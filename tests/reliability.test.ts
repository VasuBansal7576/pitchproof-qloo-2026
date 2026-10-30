import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { Miniflare } from 'miniflare';
import { PitchProof, makeProject, makeOperation } from '../server/pitchproof';
import { Store } from '../server/store';
import { parseProjectInput } from '../server/validation';
import { normalizeEvidence } from '../server/providers/qloo';
import { hash, randomToken, AppError } from '../server/errors';
import type { Command, Project } from '../lib/pitchproof-types';
import { synthesisIdentity } from '../server/providers/synthesis';
import { acceptanceSummary } from '../lib/measurement';
import { geminiResponse, isCampaignReview } from './helpers/campaign';

const env = { QLOO_API_KEY: 'synthetic-qloo', MODEL_API_KEY: 'synthetic-model', MODEL_NAME: 'gemini-3.5-flash-lite' };
let mf: Miniflare, db: D1Database, store: Store;
before(async () => {
  mf = new Miniflare({ modules: true, script: 'export default {fetch(){return new Response("ok")}}', compatibilityDate: '2026-05-01', d1Databases: ['DB'] });
  db = await mf.getD1Database('DB') as unknown as D1Database; store = new Store(db);
  for (const file of (await readdir('drizzle')).filter(file => file.endsWith('.sql')).sort()) for (const statement of (await readFile(`drizzle/${file}`, 'utf8')).split('--> statement-breakpoint')) if (statement.trim()) await db.prepare(statement.trim()).run();
});
after(async () => { await mf.dispose(); });
const command = (project: Project, value: Command) => ({ ...value, expectedVersion: project.version, commandId: randomToken() });
async function pending(owner: string) {
  const project = makeProject(parseProjectInput({ brief: { product: 'Test shoe', description: 'A hypothetical sample, no performance claims verified.', category: 'Running footwear', market: 'London', audience: 'Recreational runners', objective: 'Launch', constraints: 'Original media only.', website: '', callToAction: 'Explore Test shoe', productFacts: [{ id: 'F1', text: 'A dark mesh upper.', source: 'user_supplied', sourceUrl: null }, { id: 'F2', text: 'A simple silhouette.', source: 'user_supplied', sourceUrl: null }] }, references: [{ query: 'Nike', role: 'competitor' }, { query: 'On', role: 'aesthetic' }, { query: 'Patagonia', role: 'audience' }] }));
  project.references.forEach((ref, index) => { ref.entity = { id: `seed-${index}`, name: ref.query, type: 'urn:entity:brand', description: '', image: null, url: null }; });
  project.operation = makeOperation(project, 'research'); project.operation.phase = 'synthesis'; project.status = 'researching'; project.researchStartedAt = project.operation.startedAt;
  const operation = project.operation;
  project.evidence = operation.steps.slice(0, 2).flatMap((step, index) => normalizeEvidence({ results: { entities: Array.from({ length: 3 }, (_, n) => ({ entity_id: `entity-${index}-${n}`, name: `Observed ${index} ${n}` })) } }, operation, step));
  operation.steps.forEach(step => { step.status = 'complete'; step.evidenceIds = project.evidence.filter(record => record.category === step.category).map(record => record.id); });
  await store.create(owner, project); return project;
}
function draft(input: { evidence: { id: string; entity: { name: string } }[] }) {
  const ids = input.evidence.slice(0, 2).map(record => record.id);
  return { directions: ['participation', 'story', 'product_discovery'].map((device, index) => ({ title: `Private draft proposal ${index}`, hook: `A city routine idea ${index}`, audienceHypothesis: 'A possible recreational running audience.', strategy: 'A proposed footwear introduction in a daily routine.', productFactIds: ['F1'], campaign: { device, proposition: `A proposed routine concept ${index}.`, audienceTension: 'A possible lack of time for a routine.', mechanism: ['A calendar route prompt for viewers.', 'A runner chooses a side street over the usual route.', 'The product upper appears in a macro reveal.'][index], execution: 'Open on a calendar, show the runner preparing, then the supplied upper, and end with the product.', evidenceBridge: ids.map(evidenceId => ({ evidenceId, interpretation: 'We propose a routine-inspired creative treatment.', relevance: 'A daily routine gives the footwear a proposed occasion.', uncertainty: 'The association does not establish an actual preference.' })) }, visuals: { description: 'An original calendar and street sequence.', palette: ['#111111', '#FFFFFF', '#56624B'], references: [input.evidence[0].entity.name] }, channels: ['Video social'], evidenceIds: ids, testPlan: { message: `An everyday city routine concept ${index}.` }, limitations: ['Cultural associations do not prove customer preference.', 'Confirm product facts and production rights before use.'] })) };
}
function providers(reviewFailure: '503' | 'malformed' | 'quality' = '503') {
  const original = globalThis.fetch; const calls = { generation: 0, review: 0, qloo: 0 };
  globalThis.fetch = async (url, init) => {
    assert.ok(String(url).includes('generativelanguage.googleapis.com'));
    const body = JSON.parse(String(init?.body));
    if (isCampaignReview(body)) {
      calls.review++;
      if (calls.review === 1 || reviewFailure === '503' && calls.review === 2) {
        if (reviewFailure === '503') return new Response('private vendor details', { status: 503 });
        if (reviewFailure === 'malformed') return geminiResponse(body, 'not JSON');
        return geminiResponse(body, { issues: [{ directionIndex: 1, code: 'unsupported_claim', reason: 'Private draft proposal has a secret generated claim' }] });
      }
      return geminiResponse(body, { issues: [] });
    }
    calls.generation++; return geminiResponse(body, draft(JSON.parse(body.input)));
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}

test('review-only retries survive service restart without exposing drafts or regenerating', async () => {
  for (const failure of ['503', 'malformed'] as const) {
    const owner = `resume-${failure}`; let project = await pending(owner); const mock = providers(failure);
    try {
      project = await new PitchProof(store, env).execute(owner, project.id, command(project, { action: 'advance' }));
      assert.equal(project.operation?.failureStage, 'review'); assert.equal(project.generations.length, 0);
      assert.doesNotMatch(JSON.stringify(project), /Private draft proposal|private vendor details/);
      assert.ok(await store.draft(owner, project.id, project.operation!.id));
      assert.equal(await store.draft('other-owner', project.id, project.operation!.id), null);
      project = await new PitchProof(new Store(db), env).execute(owner, project.id, command(project, { action: 'retry' }));
      project = await new PitchProof(new Store(db), env).execute(owner, project.id, command(project, { action: 'advance' }));
      assert.equal(project.status, 'ready'); assert.equal(project.generations.length, 1); assert.equal(project.generations[0].directions.length, 3);
      assert.deepEqual(mock.calls, { generation: 1, review: failure === '503' ? 3 : 2, qloo: 0 });
      assert.equal(project.generations[0].measurements?.reduce((n, event) => n + event.requests, 0), failure === '503' ? 4 : 3);
      assert.equal(await db.prepare('SELECT COUNT(*) AS total FROM synthesis_drafts WHERE owner_id=?').bind(owner).first<{total:number}>().then(row => row?.total), 0);
    } finally { mock.restore(); }
  }
});
test('a repaired quality finding publishes without leaking its private reason', async () => {
  const owner = 'quality-rejection'; let project = await pending(owner); const mock = providers('quality');
  try {
    project = await new PitchProof(store, env).execute(owner, project.id, command(project, { action: 'advance' }));
    assert.equal(project.status, 'ready');
    assert.doesNotMatch(JSON.stringify(project), /secret generated claim/);
    assert.equal(mock.calls.generation, 2); assert.equal(mock.calls.review, 2);
    assert.equal(project.generations[0].directions[0].reviewWarnings, undefined);
  } finally { mock.restore(); }
});
test('changed agency context or evidence order prevents checkpoint reuse', async () => {
  for (const change of ['annotation', 'decision', 'evidence-order', 'brief', 'model'] as const) {
    const owner = `context-${change}`; let project = await pending(owner); const mock = providers();
    try {
      project = await new PitchProof(store, env).execute(owner, project.id, command(project, { action: 'advance' }));
      const version = project.version;
      if (change === 'annotation') project.annotations[project.evidence[0].id] = 'A new agency interpretation.';
      if (change === 'decision') project.decisions.push({ directionId: 'historical-direction', decision: 'rejected', reason: 'Do not reuse this idea.', createdAt: new Date().toISOString() });
      if (change === 'evidence-order') project.evidence.reverse();
      if (change === 'brief') { project.brief.constraints = 'Use an original calendar scene.'; project.operation!.brief.constraints = project.brief.constraints; }
      await store.save(owner, version, project);
      const configuration = change === 'model' ? { ...env, MODEL_NAME: 'gemini-3.5-flash' } : env;
      project = await new PitchProof(store, configuration).execute(owner, project.id, command(project, { action: 'retry' }));
      project = await new PitchProof(store, configuration).execute(owner, project.id, command(project, { action: 'advance' }));
      assert.equal(project.status, 'ready'); assert.equal(mock.calls.generation, 2);
    } finally { mock.restore(); }
  }
});
test('notes edited while review is running cannot receive a stale approval', async () => {
  const owner = 'review-context-race'; let project = await pending(owner); const original = globalThis.fetch;
  let release!: () => void, started!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; }); const reviewing = new Promise<void>(resolve => { started = resolve; });
  globalThis.fetch = async (_url, init) => { const body = JSON.parse(String(init?.body)); if (isCampaignReview(body)) { started(); await waiting; return geminiResponse(body, { issues: [] }); } return geminiResponse(body, draft(JSON.parse(body.input))); };
  try {
    const advancing = new PitchProof(store, env).execute(owner, project.id, command(project, { action: 'advance' })); await reviewing;
    project = await store.read(owner, project.id); project.annotations[project.evidence[0].id] = 'Changed while reviewer was away.'; await store.save(owner, project.version, project);
    release(); project = await advancing;
    assert.equal(project.operation?.failureCode, 'CONTEXT_CHANGED'); assert.equal(project.generations.length, 0); assert.equal(await store.draft(owner, project.id, project.operation!.id), null);
  } finally { release?.(); globalThis.fetch = original; }
});
test('atomic quota reserves neither call when fresh synthesis has only one unit left', async () => {
  const owner = 'fresh-quota'; const project = await pending(owner); const mock = providers(); const day = new Date().toISOString().slice(0, 10);
  await db.prepare('INSERT INTO provider_usage(owner_id,day,calls) VALUES(?,?,119)').bind(owner, day).run();
  const before = await db.prepare('SELECT calls FROM provider_usage WHERE owner_id=? AND day=?').bind('__site_total__', day).first<{calls:number}>();
  try {
    const result = await new PitchProof(store, env).execute(owner, project.id, command(project, { action: 'advance' }));
    assert.equal(result.operation?.failureCode, 'DAILY_LIMIT'); assert.equal(mock.calls.generation, 0);
    assert.equal((await db.prepare('SELECT calls FROM provider_usage WHERE owner_id=? AND day=?').bind(owner, day).first<{calls:number}>())?.calls, 119);
    assert.deepEqual(await db.prepare('SELECT calls FROM provider_usage WHERE owner_id=? AND day=?').bind('__site_total__', day).first(), before);
  } finally { mock.restore(); }
});
test('a matching review checkpoint can use the last remaining model unit', async () => {
  const owner = 'review-quota'; let project = await pending(owner); const mock = providers(); const day = new Date().toISOString().slice(0, 10);
  try {
    project = await new PitchProof(store, env).execute(owner, project.id, command(project, { action: 'advance' }));
    await db.prepare('UPDATE provider_usage SET calls=119 WHERE owner_id=? AND day=?').bind(owner, day).run();
    project = await new PitchProof(store, env).execute(owner, project.id, command(project, { action: 'retry' }));
    project = await new PitchProof(store, env).execute(owner, project.id, command(project, { action: 'advance' }));
    assert.equal(project.status, 'ready'); assert.equal(mock.calls.generation, 1);
    assert.equal((await db.prepare('SELECT calls FROM provider_usage WHERE owner_id=? AND day=?').bind(owner, day).first<{calls:number}>())?.calls, 120);
  } finally { mock.restore(); }
});
test('zero-row CAS guards cannot insert, replace, consume, or publish a draft', async () => {
  const owner = 'guarded-draft'; const project = await pending(owner); project.operation!.leaseToken = randomToken(); project.operation!.leaseUntil = Date.now() + 150_000;
  await store.save(owner, project.version, project);
  const context = await hash(synthesisIdentity(env, project.operation!, project.evidence, project));
  const payload = { private: 'private-only-marker' };
  await store.saveDraft(owner, project.version, project, context, payload);
  const stale = structuredClone(project); stale.title = 'Must not persist';
  await assert.rejects(() => store.saveDraft(owner, stale.version - 1, stale, 'wrong-context', { private: 'replacement-marker' }), error => error instanceof AppError && error.code === 'STALE_VERSION');
  assert.deepEqual((await store.draft(owner, project.id, project.operation!.id))?.payload, payload);
  const current = await store.read(owner, project.id); const op = current.operation!; current.operation = null;
  await assert.rejects(() => store.save(owner, current.version, current, undefined, { operationId: op.id, leaseToken: 'wrong-lease', contextHash: context }), error => error instanceof AppError && error.code === 'STALE_VERSION');
  assert.ok((await store.read(owner, project.id)).operation); assert.ok(await store.draft(owner, project.id, op.id));
  await assert.rejects(() => store.saveDraft('foreign-owner', project.version, project, context, payload));
  assert.equal(await store.draft('foreign-owner', project.id, op.id), null);
});

test('concurrent identical quota reservations charge once and expired records are pruned', async () => {
  const owner = 'reservation-race'; const project = await pending(owner);
  project.operation!.leaseToken = randomToken(); project.operation!.leaseUntil = Date.now() + 150_000;
  await store.save(owner, project.version, project);
  const reservation = { id: 'one-exact-stage', projectId: project.id, operationId: project.operation!.id, leaseToken: project.operation!.leaseToken! };
  await db.prepare('INSERT INTO provider_reservations(owner_id,reservation_id,day,units) VALUES(?,?,?,?)').bind(owner, 'expired-reservation', '2020-01-01', 1).run();
  await db.prepare('INSERT INTO synthesis_drafts(owner_id,project_id,operation_id,context_hash,payload_json,expires_at) VALUES(?,?,?,?,?,?)').bind(owner, project.id, 'expired-operation', 'old', '{}', 0).run();
  const admitted = await Promise.all([store.budget(owner, 2, reservation), store.budget(owner, 2, reservation)]);
  assert.deepEqual(admitted.sort(), [false, true]);
  const day = new Date().toISOString().slice(0, 10);
  assert.equal((await db.prepare('SELECT calls FROM provider_usage WHERE owner_id=? AND day=?').bind(owner, day).first<{calls:number}>())?.calls, 2);
  assert.equal(await db.prepare('SELECT 1 FROM synthesis_drafts WHERE project_id=? AND operation_id=?').bind(project.id, 'expired-operation').first(), null);
  assert.equal(await db.prepare('SELECT 1 FROM provider_reservations WHERE owner_id=? AND reservation_id=?').bind(owner, 'expired-reservation').first(), null);
});

test('canceling a paused review removes the private draft without changing approved history', async () => {
  const owner = 'cancel-private-draft'; let project = await pending(owner); const mock = providers();
  try {
    project = await new PitchProof(store, env).execute(owner, project.id, command(project, { action: 'advance' }));
    const operationId = project.operation!.id;
    assert.ok(await store.draft(owner, project.id, operationId));
    project = await new PitchProof(store, env).execute(owner, project.id, command(project, { action: 'cancel' }));
    assert.equal(project.operation, null); assert.equal(project.generations.length, 0);
    assert.equal(project.evidence.length, 6); assert.equal(await store.draft(owner, project.id, operationId), null);
  } finally { mock.restore(); }
});

test('operator acceptance is explicit, idempotent and invalidated by later notes', async () => {
  const owner = 'explicit-review'; let project = await pending(owner); const mock = providers();
  try {
    project = await new PitchProof(store, env).execute(owner, project.id, command(project, { action: 'advance' }));
    project = await new PitchProof(store, env).execute(owner, project.id, command(project, { action: 'retry' }));
    project = await new PitchProof(store, env).execute(owner, project.id, command(project, { action: 'advance' }));
    assert.equal(acceptanceSummary(project).accepted, false);
    const directionId = project.generations[0].directions[0].id;
    project = await new PitchProof(store, env).execute(owner, project.id, command(project, { action: 'choose', directionId }));
    const accept = command(project, { action: 'accept', directionId });
    project = await new PitchProof(store, env).execute(owner, project.id, accept);
    assert.equal(acceptanceSummary(project).accepted, true); assert.equal(project.acceptances?.length, 1);
    assert.deepEqual(await new PitchProof(store, env).execute(owner, project.id, accept), project);
    await assert.rejects(() => new PitchProof(store, env).execute(owner, project.id, command(project, { action: 'accept', directionId })), error => error instanceof AppError && error.code === 'ALREADY_REVIEWED');
    const frozen = JSON.stringify(project.generations);
    project = await new PitchProof(store, env).execute(owner, project.id, command(project, { action: 'annotate', targetId: directionId, text: 'Review these production details.' }));
    assert.equal(acceptanceSummary(project).accepted, false); assert.equal(project.acceptances?.length, 1);
    assert.equal(JSON.stringify(project.generations), frozen);
  } finally { mock.restore(); }
});

test('an expired worker cannot delete the draft held by a replacement reviewer', async () => {
  const owner = 'replacement-reviewer'; let project = await pending(owner); const original = globalThis.fetch;
  let releaseA!: () => void, releaseB!: () => void, startedA!: () => void, startedB!: () => void;
  const blockedA = new Promise<void>(resolve => { releaseA = resolve; }); const blockedB = new Promise<void>(resolve => { releaseB = resolve; });
  const reviewingA = new Promise<void>(resolve => { startedA = resolve; }); const reviewingB = new Promise<void>(resolve => { startedB = resolve; });
  let reviews = 0, generations = 0;
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    if (!isCampaignReview(body)) { generations++; return geminiResponse(body, draft(JSON.parse(body.input))); }
    reviews++;
    if (reviews === 1) { startedA(); await blockedA; return geminiResponse(body, { issues: [{ directionIndex: 1, code: 'unsupported_claim', reason: 'Private obsolete rejection.' }] }); }
    startedB(); await blockedB; return geminiResponse(body, { issues: [] });
  };
  try {
    const a = new PitchProof(store, env).execute(owner, project.id, command(project, { action: 'advance' })); await reviewingA;
    project = await store.read(owner, project.id); project.operation!.leaseUntil = 0; await store.save(owner, project.version, project);
    const b = new PitchProof(store, env).execute(owner, project.id, command(project, { action: 'advance' })); await reviewingB;
    releaseA(); await a;
    assert.ok(await store.draft(owner, project.id, project.operation!.id));
    releaseB(); project = await b;
    assert.equal(project.status, 'ready'); assert.equal(project.generations.length, 1); assert.equal(generations, 1); assert.equal(reviews, 2);
  } finally { releaseA?.(); releaseB?.(); globalThis.fetch = original; }
});

test('a near-expiry cached draft is renewed before its bounded review request', async () => {
  const owner = 'renew-private-draft'; let project = await pending(owner); const mock = providers();
  try {
    project = await new PitchProof(store, env).execute(owner, project.id, command(project, { action: 'advance' }));
    await db.prepare('UPDATE synthesis_drafts SET expires_at=? WHERE owner_id=?').bind(Date.now() + 100, owner).run();
    const fetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      if (isCampaignReview(JSON.parse(String(init?.body)))) {
        const row = await db.prepare('SELECT expires_at FROM synthesis_drafts WHERE owner_id=?').bind(owner).first<{expires_at:number}>();
        assert.ok(row!.expires_at > Date.now() + 3_600_000);
        await new Promise(resolve => setTimeout(resolve, 150));
      }
      return fetch(url, init);
    };
    project = await new PitchProof(store, env).execute(owner, project.id, command(project, { action: 'retry' }));
    project = await new PitchProof(store, env).execute(owner, project.id, command(project, { action: 'advance' }));
    assert.equal(project.status, 'ready'); assert.equal(mock.calls.generation, 1); assert.equal(mock.calls.review, 3);
  } finally { mock.restore(); }
});

test('publication capacity prevents review spending and an unchanged limit cannot be retried', async () => {
  const owner = 'draft-publication-capacity'; let project = await pending(owner); const mock = providers();
  try {
    const bytes = new TextEncoder().encode(JSON.stringify(project)).byteLength;
    project.annotations[project.evidence[0].id] = 'x'.repeat(196_500 - bytes);
    await store.save(owner, project.version, project);
    project = await new PitchProof(store, env).execute(owner, project.id, command(project, { action: 'advance' }));
    assert.equal(project.operation?.failureCode, 'PROJECT_LIMIT'); assert.equal(mock.calls.generation, 1); assert.equal(mock.calls.review, 0);
    await assert.rejects(() => new PitchProof(store, env).execute(owner, project.id, command(project, { action: 'retry' })), error => error instanceof AppError && error.code === 'PROJECT_LIMIT');
    assert.equal(mock.calls.generation, 1);
  } finally { mock.restore(); }
});
