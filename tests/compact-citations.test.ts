import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Evidence } from '../lib/pitchproof-types';
import { AppError } from '../server/errors';
import { makeOperation, makeProject } from '../server/pitchproof';
import { synthesize } from '../server/providers/synthesis';
import { parseProjectInput } from '../server/validation';
import { campaign, modelPilotProposal, geminiResponse, isCampaignReview } from './helpers/campaign';

function fixture() {
  const project = makeProject(parseProjectInput({
    brief: { product: 'Campaign test', description: 'A city campaign', category: 'Footwear', market: 'London', audience: 'City residents', objective: 'Launch', constraints: '', website: '', productFacts: [{ id: 'F1', text: 'The supplied product is a running shoe.', source: 'user_supplied', sourceUrl: null }], callToAction: 'Explore the campaign' },
    references: [{ query: 'Seed brand', role: 'aesthetic' }, { query: 'Second seed', role: 'competitor' }, { query: 'Third seed', role: 'audience' }],
  }));
  project.references.forEach((reference, index) => {
    reference.entity = { id: `seed-${index}`, name: reference.query, type: 'urn:entity:brand', description: '', image: null, url: null };
  });
  const operation = makeOperation(project, 'research');
  const evidence: Evidence[] = Array.from({ length: 6 }, (_, index) => ({
    id: `a945aa81-506e-4bd8-8806-${String(index).padStart(12, '0')}`, runId: operation.id, category: index % 2 ? 'artist' : 'brand',
    entity: { id: `d5126444-2989-418d-947e-${String(index).padStart(12, '0')}`, name: `Observed ${index}`, type: 'urn:entity:brand', description: '', image: null, url: null },
    rank: index + 1, score: null, observation: `Canonical association ${index}.`, collectedAt: project.createdAt,
    context: { referenceNames: ['Seed brand'], referenceIds: ['seed-0'], referenceRoles: ['aesthetic'], market: 'London', geographyApplied: false, parameters: {}, endpoint: '/v2/insights' },
  }));
  return { project, operation, evidence };
}

function output(ids = ['E1', 'E6']) {
  return { directions: Array.from({ length: 3 }, (_, index) => ({
    title: `Direction ${index}`, hook: `A distinct creative hook ${index}`, audienceHypothesis: 'An audience hypothesis to test', strategy: 'A proposed creative interpretation',
    visuals: { description: 'A proposed visual treatment', palette: ['#112233', '#445566', '#778899'], references: ['Observed 0'] },
    channels: ['Organic social'], evidenceIds: ids, productFactIds: ['F1'], campaign: campaign(ids, index),
    testPlan: modelPilotProposal(),
    limitations: ['Associations are not causal proof', 'Customer preferences require validation'],
  })) };
}

async function withModel(ids: string[], run: (request: () => ReturnType<typeof synthesize>) => Promise<void>) {
  const { project, operation, evidence } = fixture();
  const original = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    if (isCampaignReview(body)) return geminiResponse(body, { issues: [] });
    const payload = JSON.parse(body.input);
    assert.deepEqual(payload.evidence.map((record: Evidence) => record.id), ['E1', 'E2', 'E3', 'E4', 'E5', 'E6']);
    assert.deepEqual(payload.evidence, evidence.map((record, index) => ({
      id: `E${index + 1}`, category: record.category,
      entity: { id: record.entity.id, name: record.entity.name, type: record.entity.type, description: record.entity.description },
      rank: record.rank, score: record.score, observation: record.observation,
      context: { referenceNames: record.context.referenceNames, referenceIds: record.context.referenceIds, referenceRoles: record.context.referenceRoles, market: record.context.market, geographyApplied: record.context.geographyApplied },
    })));
    assert.deepEqual(payload.productFacts, project.brief.productFacts);
    assert.equal(payload.callToAction, project.brief.callToAction);
    assert.match(body.system_instruction, /exact top-level id strings/);
    return geminiResponse(body, output(ids));
  };
  try {
    await run(() => synthesize({ MODEL_API_KEY: 'synthetic-key', MODEL_NAME: 'gemini-3.5-flash-lite' }, operation, evidence, project));
  } finally { globalThis.fetch = original; }
}

test('short model-local evidence citations resolve to canonical immutable records', async () => {
  const { evidence } = fixture();
  await withModel(['E1', 'E6'], async request => {
    const directions = await request();
    for (const direction of directions) {
      assert.deepEqual(direction.claims, [evidence[0], evidence[5]].map(record => ({ text: record.observation, evidenceIds: [record.id] })));
      assert.ok(direction.claims.every(claim => !claim.evidenceIds[0].startsWith('E')));
      assert.deepEqual(direction.campaign?.evidenceBridge.map(bridge => bridge.evidenceId), [evidence[0].id, evidence[5].id]);
    }
  });
});

test('unknown aliases, raw entity IDs, canonical IDs and prior-run IDs cannot become citations', async () => {
  const { evidence } = fixture();
  for (const invalid of ['E0', 'E7', 'e1', 'E01', ' E1 ', evidence[0].entity.id, evidence[0].id, 'previous-run-evidence']) {
    await withModel(['E1', invalid], async request => {
      await assert.rejects(request, error => error instanceof AppError && error.code === 'INVALID_CITATIONS');
    });
  }
});

test('duplicate short aliases remain invalid after canonical mapping', async () => {
  await withModel(['E1', 'E1'], async request => {
    await assert.rejects(request, error => error instanceof AppError && error.code === 'INVALID_CITATIONS');
  });
});

test('bridge mismatches, unknown bridge aliases and duplicate bridges fail before review', async () => {
  const { project, operation, evidence } = fixture();
  const original = globalThis.fetch;
  const cases = [
    { ids: ['E1', 'E6'], bridges: ['E1', 'E2'] },
    { ids: ['E1', 'E6'], bridges: ['E1', 'E7'] },
    { ids: ['E1', 'E6'], bridges: ['E1', 'E1'] },
    { ids: ['E1', 'E1'], bridges: ['E1', 'E6'] },
  ];
  try {
    for (const value of cases) {
      let reviews = 0;
      globalThis.fetch = async (_url, init) => {
        const body = JSON.parse(String(init?.body));
        if (isCampaignReview(body)) { reviews++; return geminiResponse(body, { issues: [] }); }
        const response = output(value.ids);
        response.directions[0].campaign = campaign(value.bridges);
        return geminiResponse(body, response);
      };
      await assert.rejects(() => synthesize({ MODEL_API_KEY: 'synthetic-key', MODEL_NAME: 'gemini-3.5-flash-lite' }, operation, evidence, project), error => error instanceof AppError && error.code === 'INVALID_CITATIONS');
      assert.equal(reviews, 0, `Invalid citations ${JSON.stringify(value)} must not reach campaign review`);
    }
  } finally { globalThis.fetch = original; }
});

test('incomplete campaign and test contracts fail before review', async () => {
  const { project, operation, evidence } = fixture();
  const original = globalThis.fetch;
  const invalid = [
    (value: ReturnType<typeof output>) => { Reflect.deleteProperty(value.directions[0], 'campaign'); },
    (value: ReturnType<typeof output>) => { value.directions[0].campaign.evidenceBridge = value.directions[0].campaign.evidenceBridge.slice(0, 1); },
    (value: ReturnType<typeof output>) => { value.directions[0].campaign.evidenceBridge = campaign(['E1', 'E2', 'E3', 'E4']).evidenceBridge; },
    (value: ReturnType<typeof output>) => { Reflect.deleteProperty(value.directions[0].campaign, 'device'); },
    (value: ReturnType<typeof output>) => { Reflect.deleteProperty(value.directions[0].testPlan, 'message'); },
  ];
  try {
    for (const mutate of invalid) {
      let reviews = 0;
      globalThis.fetch = async (_url, init) => {
        const body = JSON.parse(String(init?.body));
        if (isCampaignReview(body)) { reviews++; return geminiResponse(body, { issues: [] }); }
        const response = output();
        mutate(response);
        return geminiResponse(body, response);
      };
      await assert.rejects(() => synthesize({ MODEL_API_KEY: 'synthetic-key', MODEL_NAME: 'gemini-3.5-flash-lite' }, operation, evidence, project), error => error instanceof AppError && error.code === 'MODEL_RESPONSE');
      assert.equal(reviews, 0);
    }
  } finally { globalThis.fetch = original; }
});

test('repeated or unknown campaign devices fail before campaign review', async () => {
  const { project, operation, evidence } = fixture();
  const original = globalThis.fetch;
  try {
    for (const device of ['participation', 'mood']) {
      let reviews = 0;
      globalThis.fetch = async (_url, init) => {
        const body = JSON.parse(String(init?.body));
        if (isCampaignReview(body)) { reviews++; return geminiResponse(body, { issues: [] }); }
        const response = output();
        Object.assign(response.directions[1].campaign, { device });
        return geminiResponse(body, response);
      };
      await assert.rejects(() => synthesize({ MODEL_API_KEY: 'synthetic-key' }, operation, evidence, project), error => error instanceof AppError && error.code === (device === 'participation' ? 'DUPLICATE_DIRECTIONS' : 'MODEL_RESPONSE'));
      assert.equal(reviews, 0);
    }
  } finally { globalThis.fetch = original; }
});

test('model-authored budget, decision policy and statistical fields are rejected before review', async () => {
  const { project, operation, evidence } = fixture();
  const original = globalThis.fetch;
  const invented = {
    controls: 'Use unequal allocation', budget: 'Automatically spend USD 5000', minimumData: 'Ten views is sufficient',
    metric: 'Sales predicted from clicks', successCriterion: 'Advance after one click', inconclusive: 'Always choose a winner',
    kind: 'execution', hypothesis: 'A model-chosen hypothesis', variable: 'Visual treatment only', variants: ['Calendar edit', 'Packing edit'],
    confidence: 0.95, statisticalSignificance: true, predictedLift: 0.2, sampleSize: 20, power: 0.8,
  };
  try {
    for (const [field, value] of Object.entries(invented)) {
      let reviews = 0;
      globalThis.fetch = async (_url, init) => {
        const body = JSON.parse(String(init?.body));
        if (isCampaignReview(body)) { reviews++; return geminiResponse(body, { issues: [] }); }
        const response = output();
        Object.assign(response.directions[0].testPlan, { [field]: value });
        return geminiResponse(body, response);
      };
      await assert.rejects(() => synthesize({ MODEL_API_KEY: 'synthetic-key' }, operation, evidence, project), error => error instanceof AppError && error.code === 'MODEL_RESPONSE', field);
      assert.equal(reviews, 0, `${field} must not become reviewer-approved policy`);
    }
  } finally { globalThis.fetch = original; }
});

test('campaign review and returned directions share approval-dependent pilot defaults with a feasible decision gate', async () => {
  const { project, operation, evidence } = fixture();
  const original = globalThis.fetch;
  const response = output();
  response.directions[1].testPlan.message = 'An ordinary departure has a small personal meaning.';
  let reviewed: { testPlan: Record<string, unknown> }[] = [];
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    if (isCampaignReview(body)) {
      reviewed = JSON.parse(body.input).proposedDirections;
      return geminiResponse(body, { issues: [] });
    }
    return geminiResponse(body, response);
  };
  try {
    const directions = await synthesize({ MODEL_API_KEY: 'synthetic-key', MODEL_NAME: 'gemini-3.5-flash-lite' }, operation, evidence, project);
    assert.deepEqual(directions.map(direction => direction.campaign?.device), ['participation', 'story', 'product_discovery']);
    assert.equal(reviewed.length, 3);
    for (const [index, direction] of directions.entries()) {
      const plan = direction.testPlan;
      assert.deepEqual(reviewed[index].testPlan, plan, 'The reviewer must see the complete plan that the agency receives');
      assert.equal(plan.kind, 'concept');
      assert.equal(plan.variable, 'Campaign message');
      assert.match(plan.hypothesis, /Changing only the campaign message/);
      assert.deepEqual(plan.contract, {
        version: 1,
        shared: { baseEditId: 'concept-base-edit-v1', soundtrackId: 'concept-shared-soundtrack-v1', productFactIds: ['F1'], durationSeconds: 15, channel: 'One video ad channel selected before launch', audience: project.brief.audience, callToAction: project.brief.callToAction, landingPage: 'One product landing page selected before launch' },
        arms: [{ message: response.directions[index].testPlan.message }, { message: 'Introducing Campaign test.' }],
      });
      assert.equal(plan.variants.length, 2);
      for (const [arm, variant] of plan.variants.entries()) {
        assert.ok(variant.startsWith(`Message: ${plan.contract!.arms[arm].message} | `));
        assert.match(variant, /Product facts: F1: The supplied product is a running shoe/);
        assert.match(variant, /CTA: Explore the campaign/);
      }
      assert.equal(plan.variants[0].slice(plan.variants[0].indexOf(' | ')), plan.variants[1].slice(plan.variants[1].indexOf(' | ')), 'Both arms must share every production control');
      assert.deepEqual(direction.productFactIds, ['F1']);
      assert.equal(direction.campaign?.callToAction, project.brief.callToAction);
      assert.match(direction.campaign!.productRole, /F1: The supplied product is a running shoe/);
      assert.match(plan.controls!, /15-second/);
      assert.match(plan.controls!, /Randomize delivery 50\/50 and split spend equally/);
      assert.match(plan.budget!, /[Pp]lanning default, subject to agency approval/);
      assert.match(plan.budget!, /USD 200 over seven days, USD 100 per arm/);
      assert.match(plan.budget!, /Confirm or replace.*before launch/);
      assert.match(plan.minimumData!, /1,000 delivered impressions per arm.*delivery floor only/);
      assert.match(plan.minimumData!, /agency baseline CTR and smallest practical difference.*required sample/);
      assert.match(plan.minimumData!, /floor alone cannot establish a winner/);
      assert.match(plan.metric, /link clicks divided by delivered impressions/);
      assert.match(plan.metric, /separately for each arm/);
      assert.match(plan.successCriterion, /agency-approved smallest practical CTR difference, required sample and analysis rule/);
      assert.match(plan.successCriterion, /inputs are missing, do not launch or name a winner/);
      assert.match(plan.inconclusive!, /Stop at the approved spend cap or seven-day limit/);
      assert.match(plan.inconclusive!, /insufficient, record an inconclusive pilot/);
      assert.match(plan.inconclusive!, /Do not name a winner or extend spend without new approval/);
    }
    for (const direction of directions) assert.match(direction.testPlan.controls!, /Replace only the message text in the same text slot with the same typography and timing/);
  } finally { globalThis.fetch = original; }
});

test('three observation bridges retain every canonical citation in a complete campaign', async () => {
  const { evidence } = fixture();
  await withModel(['E1', 'E3', 'E6'], async request => {
    const directions = await request();
    const expected = [evidence[0], evidence[2], evidence[5]];
    for (const direction of directions) {
      assert.deepEqual(direction.claims, expected.map(record => ({ text: record.observation, evidenceIds: [record.id] })));
      assert.deepEqual(direction.campaign?.evidenceBridge.map(bridge => bridge.evidenceId), expected.map(record => record.id));
    }
  });
});
