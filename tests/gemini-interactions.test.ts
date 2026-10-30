import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Miniflare } from 'miniflare';
import type { Command, Evidence } from '../lib/pitchproof-types';
import { CATEGORIES } from '../lib/pitchproof-types';
import { AppError, randomToken } from '../server/errors';
import { makeOperation, makeProject, PitchProof } from '../server/pitchproof';
import { geminiStructuredText } from '../server/providers/gemini';
import { normalizeEvidence } from '../server/providers/qloo';
import { synthesize } from '../server/providers/synthesis';
import { Store } from '../server/store';
import { parseProjectInput } from '../server/validation';
import { applyMigrations } from './helpers/database';
import { campaign, modelPilotProposal, geminiResponse, isCampaignReview } from './helpers/campaign';

const env = { QLOO_API_KEY: 'synthetic-qloo-key', MODEL_API_KEY: 'synthetic-model-key', MODEL_NAME: 'gemini-3.5-flash-lite' };
const request = { apiKey: env.MODEL_API_KEY, model: env.MODEL_NAME, input: 'Synthetic input', systemInstruction: 'Return structured output', schema: { type: 'object' }, purpose: 'synthesis' as const };

function completed(text: string) {
  return { status: 'completed', steps: [{ type: 'thought', summary: [{ type: 'text', text: 'Excluded reasoning' }] }, { type: 'model_output', content: [{ type: 'text', text }] }] };
}

async function withFetch(mock: typeof fetch, run: () => Promise<void>) {
  const original = globalThis.fetch;
  globalThis.fetch = mock;
  try { await run(); } finally { globalThis.fetch = original; }
}

function projectFixture() {
  const project = makeProject(parseProjectInput({
    brief: { product: 'Campaign test', description: 'A city campaign', category: 'Footwear', market: 'London', audience: 'City residents', objective: 'Launch', constraints: '', website: '', productFacts: [{ id: 'F1', text: 'The supplied product is a running shoe.', source: 'user_supplied', sourceUrl: null }], callToAction: 'Explore the campaign' },
    references: [{ query: 'Seed brand', role: 'aesthetic' }, { query: 'Second seed', role: 'competitor' }, { query: 'Third seed', role: 'audience' }],
  }));
  project.references.forEach((reference, index) => {
    reference.entity = { id: `seed-${index}`, name: reference.query, type: 'urn:entity:brand', description: '', image: null, url: null };
  });
  return project;
}

function directionsOutput(evidence: Pick<Evidence, 'id' | 'entity'>[], generation = 1) {
  return { directions: Array.from({ length: 3 }, (_, index) => ({
    title: `Creative direction ${generation}/${index}`, hook: `Distinct campaign hook ${generation}/${index}`, audienceHypothesis: 'An audience hypothesis to test', strategy: 'A creative interpretation to test',
    visuals: { description: 'A proposed visual treatment', palette: ['#112233', '#445566', '#778899'], references: [evidence.at(-1)!.entity.name] },
    channels: ['Organic social'], evidenceIds: [evidence[0].id, evidence.at(-1)!.id], productFactIds: ['F1'], campaign: campaign([evidence[0].id, evidence.at(-1)!.id], index),
    testPlan: modelPilotProposal(),
    limitations: ['Associations are not causal proof', 'Customer preferences need validation'],
  })) };
}

test('Gemini 3.5 uses documented stateless Interactions REST and extracts only model text', async () => {
  await withFetch(async (url, init) => {
    assert.equal(String(url), 'https://generativelanguage.googleapis.com/v1beta/interactions');
    assert.equal(init?.method, 'POST');
    assert.equal(new Headers(init?.headers).get('x-goog-api-key'), env.MODEL_API_KEY);
    assert.equal(init?.redirect, 'manual');
    assert.ok(init?.signal instanceof AbortSignal);
    assert.deepEqual(JSON.parse(String(init?.body)), {
      model: env.MODEL_NAME, input: request.input, system_instruction: request.systemInstruction, store: false,
      response_format: { type: 'text', mime_type: 'application/json', schema: request.schema },
      generation_config: { max_output_tokens: 10_000, thinking_level: 'low' },
    });
    return Response.json({ status: 'completed', output_text: 'Excluded SDK shortcut', steps: [
      { type: 'thought', summary: [{ type: 'text', text: 'Excluded reasoning' }] },
      { type: 'user_input', content: [{ type: 'text', text: 'Excluded echoed input' }] },
      { type: 'model_output', content: [{ type: 'image', text: 'Excluded media' }, { type: 'text', thought: true, text: 'Excluded thought' }, { type: 'text', text: '{"ok":' }, { type: 'text', text: 'true}' }] },
    ] });
  }, async () => { assert.equal(await geminiStructuredText(request), '{"ok":true}'); });
});

test('Interactions failures, incomplete results, missing status and absent final text cannot become output', async () => {
  for (const status of ['failed', 'cancelled', 'in_progress', 'requires_action', undefined]) {
    await withFetch(async () => Response.json({ ...completed('{"ok":true}'), status }), async () => {
      await assert.rejects(() => geminiStructuredText(request), error => error instanceof AppError && error.code === 'MODEL_RESPONSE');
    });
  }
  await withFetch(async () => Response.json({ ...completed('{"partial":true}'), status: 'incomplete' }), async () => {
    await assert.rejects(() => geminiStructuredText(request), error => error instanceof AppError && error.code === 'MODEL_INCOMPLETE');
  });
  for (const payload of [
    { status: 'completed', output_text: '{"shortcut":true}', steps: [] },
    { status: 'completed', steps: [{ type: 'thought', summary: [{ type: 'text', text: '{"thought":true}' }] }] },
    { status: 'completed', steps: [{ type: 'model_output', content: [{ type: 'text', text: 123 }] }] },
    completed(' '.repeat(10)), completed('x'.repeat(90_001)),
  ]) {
    await withFetch(async () => Response.json(payload), async () => {
      await assert.rejects(() => geminiStructuredText(request), error => error instanceof AppError && error.code === 'MODEL_RESPONSE');
    });
  }
  await withFetch(async () => Response.json({ status: 'completed', steps: [{ type: 'model_output', status: 'in_progress', content: [{ type: 'text', text: '{"partial":true}' }] }] }), async () => {
    await assert.rejects(() => geminiStructuredText(request), error => error instanceof AppError && error.code === 'MODEL_INCOMPLETE');
  });
});

test('Gemini 2.5 keeps generateContent transport, structured schema and thought filtering', async () => {
  await withFetch(async (url, init) => {
    assert.equal(String(url), 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent');
    const body = JSON.parse(String(init?.body));
    assert.deepEqual(body.systemInstruction, { parts: [{ text: request.systemInstruction }] });
    assert.deepEqual(body.contents, [{ role: 'user', parts: [{ text: request.input }] }]);
    assert.deepEqual(body.generationConfig, { responseMimeType: 'application/json', responseJsonSchema: request.schema, thinkingConfig: { thinkingBudget: 1024 }, temperature: 0.8, maxOutputTokens: 10_000 });
    assert.equal(body.store, undefined);
    return Response.json({ candidates: [{ finishReason: 'STOP', content: { parts: [{ thought: true, text: 'Excluded reasoning' }, { text: '{"ok":true}' }] } }] });
  }, async () => { assert.equal(await geminiStructuredText({ ...request, model: 'gemini-2.5-flash' }), '{"ok":true}'); });
  for (const [finishReason, code] of [['MAX_TOKENS', 'MODEL_OUTPUT_LIMIT'], ['SAFETY', 'MODEL_RESPONSE'], [undefined, 'MODEL_RESPONSE']] as const) {
    await withFetch(async () => Response.json({ candidates: [{ finishReason, content: { parts: [{ text: '{"partial":true}' }] } }] }), async () => {
      await assert.rejects(() => geminiStructuredText({ ...request, model: 'gemini-2.5-flash' }), error => error instanceof AppError && error.code === code);
    });
  }
});

test('Interactions transport preserves HTTP error handling without provider text disclosure', async () => {
  for (const [status, code] of [[400, 'PROVIDER_BAD_REQUEST'], [401, 'PROVIDER_AUTH'], [429, 'PROVIDER_RATE_LIMIT'], [500, 'PROVIDER_ERROR']] as const) {
    await withFetch(async () => Response.json({ error: { message: 'Private provider payload' } }, { status }), async () => {
      await assert.rejects(() => geminiStructuredText(request), error => error instanceof AppError && error.code === code && !error.message.includes('Private'));
    });
  }
});

test('modern synthesis retains the full operation catalog, bounded schema and canonical evidence claims', async () => {
  const project = projectFixture();
  const operation = makeOperation(project, 'research');
  const evidence = operation.steps.flatMap((step, stepIndex) => normalizeEvidence({ results: { entities: Array.from({ length: 6 }, (_, index) => ({ entity_id: `observed-${stepIndex}-${index}`, name: `Observed ${stepIndex}/${index}` })) } }, operation, step));
  assert.equal(evidence.length, 54);
  const aliased = evidence.map((record, index) => ({ ...record, id: `E${index + 1}` }));
  let response = directionsOutput(aliased);
  await withFetch(async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    if (isCampaignReview(body)) return geminiResponse(body, { issues: [] });
    const payload = JSON.parse(body.input);
    assert.deepEqual(payload.evidence.map((record: Evidence) => record.id), aliased.map(record => record.id));
    const schema = body.response_format.schema;
    const array = schema.properties.directions;
    assert.equal(array.minItems, 3);
    assert.equal(array.maxItems, 3);
    assert.equal(array.items.additionalProperties, false);
    assert.equal(array.items.properties.visuals.properties.references.minItems, 1);
    assert.equal(array.items.properties.visuals.properties.references.maxItems, 5);
    assert.deepEqual(array.items.properties.evidenceIds.items.enum, aliased.map(record => record.id));
    assert.equal(array.items.properties.visuals.properties.references.items.enum, undefined);
    assert.deepEqual(new Set(payload.evidence.flatMap((record: Evidence) => [record.entity.name, ...record.context.referenceNames])), new Set(evidence.flatMap(record => [record.entity.name, ...record.context.referenceNames])));
    assert.deepEqual(payload.brief, operation.brief);
    return Response.json(completed(JSON.stringify(response)));
  }, async () => {
    const directions = await synthesize(env, operation, evidence, project);
    assert.deepEqual(directions[0].claims, [evidence[0], evidence.at(-1)!].map(record => ({ text: record.observation, evidenceIds: [record.id] })));
    response = directionsOutput(aliased);
    response.directions[0].evidenceIds[0] = 'invented-evidence';
    await assert.rejects(() => synthesize(env, operation, evidence, project), error => error instanceof AppError && error.code === 'INVALID_CITATIONS');
    response = directionsOutput(aliased);
    response.directions[0].visuals.references = ['Outside current research'];
    await assert.rejects(() => synthesize(env, operation, evidence, project), error => error instanceof AppError && error.code === 'UNSUPPORTED_VISUAL_REFERENCE');
    response = directionsOutput(aliased);
    response.directions[0].visuals.palette[0] = 'invalid';
    await assert.rejects(() => synthesize(env, operation, evidence, project), error => error instanceof AppError && error.code === 'MODEL_RESPONSE');
  });
});

test('modern research and revision planner feed the persisted direction pipeline with fresh evidence', async () => {
  const mf = new Miniflare({ modules: true, script: 'export default { fetch() { return new Response("ok"); } }', compatibilityDate: '2026-05-01', d1Databases: ['DB'] });
  try {
    const db = await mf.getD1Database('DB') as unknown as D1Database;
    await applyMigrations(db);
    const store = new Store(db);
    const owner = 'modern-workflow-owner';
    let project = projectFixture();
    await store.create(owner, project);
    const service = new PitchProof(store, env);
    const command = (value: Command) => ({ ...value, expectedVersion: project.version, commandId: randomToken() });
    let researchCalls = 0;
    let plannerCalls = 0;
    let modelCalls = 0;
    let reviewCalls = 0;
    let revisionInput: { feedback: string; revisionContext: { parentDirection: { id: string } }; evidence: Evidence[] } | undefined;
    await withFetch(async (url, init) => {
      if (String(url).includes('/v2/insights')) {
        researchCalls++;
        return Response.json({ results: { entities: Array.from({ length: 6 }, (_, index) => ({ entity_id: `research-${researchCalls}-${index}`, name: `Observed ${researchCalls}/${index}` })) } });
      }
      assert.equal(String(url), 'https://generativelanguage.googleapis.com/v1beta/interactions');
      const body = JSON.parse(String(init?.body));
      assert.equal(body.store, false);
      assert.equal(body.model, env.MODEL_NAME);
      assert.equal(body.generation_config.temperature, undefined);
      assert.equal(body.generation_config.thinking_budget, undefined);
      if (body.input.startsWith('Choose the TWO')) {
        plannerCalls++;
        assert.equal(body.generation_config.max_output_tokens, 4096);
        assert.deepEqual(body.response_format.schema.properties.categories.items.enum, CATEGORIES);
        assert.equal(body.response_format.schema.properties.categories.minItems, 2);
        assert.match(body.input, /local community voice/);
        return Response.json(completed(JSON.stringify({ categories: ['place', 'podcast'] })));
      }
      if (isCampaignReview(body)) { reviewCalls++; return geminiResponse(body, { issues: [] }); }
      modelCalls++;
      const payload = JSON.parse(body.input);
      if (payload.feedback) revisionInput = payload;
      return Response.json(completed(JSON.stringify(directionsOutput(payload.evidence, modelCalls))));
    }, async () => {
      project = await service.execute(owner, project.id, command({ action: 'start_research' }));
      for (let step = 0; project.operation && step < 12; step++) project = await service.execute(owner, project.id, command({ action: 'advance' }));
      assert.equal(project.status, 'ready');
      assert.equal(project.generations.length, 1);
      assert.equal(researchCalls, 9);
      const prior = structuredClone(project.generations[0]);
      const oldEvidence = structuredClone(project.evidence);
      const parent = prior.directions[0];
      project = await service.execute(owner, project.id, command({ action: 'revise', directionId: parent.id, feedback: 'Explore local community voice and a podcast treatment' }));
      assert.equal(plannerCalls, 1);
      assert.deepEqual([...new Set(project.operation!.steps.map(step => step.category))], ['place', 'podcast']);
      for (let step = 0; project.operation && step < 9; step++) project = await service.execute(owner, project.id, command({ action: 'advance' }));
      assert.equal(project.status, 'ready');
      assert.equal(project.generations.length, 2);
      assert.equal(project.generations[1].model, `gemini/${env.MODEL_NAME}`);
      assert.equal(modelCalls, 2);
      assert.equal(reviewCalls, 2);
      assert.equal(researchCalls, 12);
      assert.equal(project.generations[1].parentDirectionId, parent.id);
      assert.equal(revisionInput?.revisionContext.parentDirection.id, parent.id);
      assert.match(revisionInput?.feedback ?? '', /local community voice/);
      const fresh = project.evidence.slice(oldEvidence.length);
      assert.deepEqual(revisionInput?.evidence.map(record => record.id), fresh.map((_, index) => `E${index + 1}`));
      assert.deepEqual(project.generations[1].evidenceIds, fresh.map(record => record.id));
      const records = new Map(fresh.map(record => [record.id, record]));
      for (const direction of project.generations[1].directions) {
        for (const claim of direction.claims) assert.equal(claim.text, records.get(claim.evidenceIds[0])?.observation);
      }
      assert.deepEqual(project.generations[0], prior);
      assert.deepEqual(project.evidence.slice(0, oldEvidence.length), oldEvidence);
      assert.deepEqual(await store.read(owner, project.id), project);
    });
  } finally { await mf.dispose(); }
});
