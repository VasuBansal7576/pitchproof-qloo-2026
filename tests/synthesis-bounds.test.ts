import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Evidence } from '../lib/pitchproof-types';
import { AppError } from '../server/errors';
import { makeOperation, makeProject } from '../server/pitchproof';
import { generateDraft, synthesize, validateDirections } from '../server/providers/synthesis';
import { parseProjectInput } from '../server/validation';
import { campaign, modelPilotProposal, geminiResponse, isCampaignReview } from './helpers/campaign';

function fixture() {
  const project = makeProject(parseProjectInput({
    brief: { product: 'Campaign test', description: 'A city campaign', category: 'Footwear', market: 'London', audience: 'City residents', objective: 'Launch', constraints: '', website: '', productFacts: [{ id: 'F1', text: 'The supplied product is a running shoe.', source: 'user_supplied', sourceUrl: null }], callToAction: 'Explore the campaign' },
    references: [{ query: 'Seed brand', role: 'aesthetic' }, { query: 'Second seed', role: 'competitor' }, { query: 'Third seed', role: 'audience' }],
  }));
  project.references.forEach((reference, index) => {
    reference.entity = { id: `seed-${index + 1}`, name: reference.query, type: 'urn:entity:brand', description: '', image: null, url: null };
  });
  const operation = makeOperation(project, 'research');
  const evidence: Evidence[] = Array.from({ length: 54 }, (_,index) => ({
    id: `evidence-${index}`, runId: operation.id, category: index % 2 ? 'artist' : 'brand',
    entity: { id: `entity-${index}`, name: `Observed ${index}`, type: index % 2 ? 'urn:entity:artist' : 'urn:entity:brand', description: '', image: null, url: null },
    rank: index + 1, score: null, observation: `Observed association ${index}, a hypothesis proxy.`, collectedAt: project.createdAt,
    context: { referenceNames: ['Seed brand'], referenceIds: ['seed-1'], referenceRoles: ['aesthetic'], market: 'London', geographyApplied: false, parameters: {}, endpoint: '/v2/insights' },
  }));
  return { project, operation, evidence };
}

function output(referenceCount = 5) {
  return { directions: Array.from({ length: 3 }, (_,index) => ({
    title: `Creative direction ${index}`, hook: `Distinct campaign hook ${index}`, audienceHypothesis: 'An audience hypothesis to test', strategy: 'A creative interpretation to test',
    visuals: { description: 'A proposed visual treatment', palette: ['#112233', '#445566', '#778899'], references: Array.from({ length: referenceCount }, (_,reference) => `Observed ${reference}`) },
    channels: ['Organic social'], evidenceIds: ['E1', 'E2'], productFactIds: ['F1'], campaign: campaign(['E1', 'E2'], index),
    testPlan: modelPilotProposal(),
    limitations: ['Associations are not causal proof', 'Customer preferences need validation'],
  })) };
}

test('Gemini receives selective direction and reference bounds with the full operation catalog', async () => {
  const { project, operation, evidence } = fixture();
  const original = globalThis.fetch;
  let requests = 0;
  let requestBody = '';
  let response = output(1);
  globalThis.fetch = async (_url, init) => {
    requests++;
    const body = JSON.parse(String(init?.body));
    if (isCampaignReview(body)) return geminiResponse(body, { issues: [] });
    requestBody = String(init?.body);
    return geminiResponse(body, response);
  };
  try {
    for (const count of [1, 5]) {
      response = output(count);
      const directions = await synthesize({ MODEL_API_KEY: 'synthetic-test-key' }, operation, evidence, project);
      assert.equal(directions.length, 3);
      assert.deepEqual(directions[0].visuals.references, response.directions[0].visuals.references);
      assert.deepEqual(directions[0].claims, evidence.slice(0, 2).map(record => ({ text: record.observation, evidenceIds: [record.id] })));
    }
    assert.equal(requests, 4);
    const schema = JSON.parse(requestBody).generationConfig.responseJsonSchema;
    const directionArray = schema.properties.directions;
    const fields = directionArray.items.properties;
    assert.equal(directionArray.minItems, 3);
    assert.equal(directionArray.maxItems, 3);
    assert.equal(fields.visuals.properties.references.minItems, 1);
    assert.equal(fields.visuals.properties.references.maxItems, 5);
    assert.equal(fields.visuals.properties.palette.minItems, 3);
    assert.equal(fields.visuals.properties.palette.maxItems, 6);
    assert.ok(fields.visuals.properties.palette.items.enum.every((color: string) => /^#[a-fA-F0-9]{6}$/.test(color)));
    assert.equal(fields.evidenceIds.items.type, 'string');
    assert.deepEqual(fields.evidenceIds.items.enum, evidence.map((_, index) => `E${index + 1}`));
    assert.equal(fields.visuals.properties.references.items.enum, undefined);
    assert.deepEqual(JSON.parse(JSON.parse(requestBody).contents[0].parts[0].text).evidence.map((record: Evidence) => record.id), evidence.map((_, index) => `E${index + 1}`));
    assert.equal(directionArray.items.additionalProperties, false);
    assert.equal(schema.$schema, undefined);
    assert.doesNotMatch(JSON.stringify(schema), /"(?:minLength|maxLength|pattern)":/);
    const bounds: string[] = [];
    function collect(value: unknown, path: string) {
      if (!value || typeof value !== 'object') return;
      for (const [key, child] of Object.entries(value)) {
        const next = `${path}.${key}`;
        if (key === 'minItems' || key === 'maxItems') bounds.push(next);
        collect(child, next);
      }
    }
    collect(schema, 'schema');
    assert.deepEqual(bounds.sort(), [
      'schema.properties.directions.minItems', 'schema.properties.directions.maxItems',
      'schema.properties.directions.items.properties.visuals.properties.references.minItems',
      'schema.properties.directions.items.properties.visuals.properties.references.maxItems',
      'schema.properties.directions.items.properties.visuals.properties.palette.minItems',
      'schema.properties.directions.items.properties.visuals.properties.palette.maxItems',
    ].sort());
  } finally { globalThis.fetch = original; }
});

test('server rejects missing or excessive directions and references without altering model data', () => {
  const { project, operation, evidence } = fixture();
  const invalid = (value: unknown) => assert.throws(() => validateDirections(value, evidence, operation, project), error => error instanceof AppError && error.code === 'MODEL_RESPONSE');
  for (const count of [0, 6]) {
    const value = output(count);
    const before = structuredClone(value);
    invalid(value);
    assert.deepEqual(value, before);
  }
  invalid({ directions: output().directions.slice(0, 2) });
  invalid({ directions: [...output().directions, { ...output().directions[0], title: 'Fourth direction', hook: 'Fourth creative hook' }] });
});

test('a provider response exceeding its reference bound still fails at the server boundary', async () => {
  const { project, operation, evidence } = fixture();
  const response = output(6);
  const before = structuredClone(response);
  const original = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = async () => {
    requests++;
    return Response.json({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify(response) }] } }] });
  };
  try {
    await assert.rejects(() => synthesize({ MODEL_API_KEY: 'synthetic-test-key' }, operation, evidence, project), error => error instanceof AppError && error.code === 'MODEL_RESPONSE');
    assert.equal(requests, 1);
    assert.deepEqual(response, before);
  } finally { globalThis.fetch = original; }
});

test('reference bounds preserve strict citation, catalog and content validation', () => {
  const { project, operation, evidence } = fixture();
  for (const [mutate, code] of [
    [(value: ReturnType<typeof output>) => { value.directions[0].visuals.references = ['Outside this operation']; }, 'UNSUPPORTED_VISUAL_REFERENCE'],
    [(value: ReturnType<typeof output>) => { value.directions[0].evidenceIds = ['E1', 'unknown']; }, 'INVALID_CITATIONS'],
    [(value: ReturnType<typeof output>) => { value.directions[0].evidenceIds = ['E1', 'E1']; }, 'INVALID_CITATIONS'],
    [(value: ReturnType<typeof output>) => { value.directions[0].evidenceIds = evidence.slice(0, 7).map((_, index) => `E${index + 1}`); }, 'MODEL_RESPONSE'],
    [(value: ReturnType<typeof output>) => { value.directions[0].visuals.palette[0] = 'invalid color'; }, 'MODEL_RESPONSE'],
    [(value: ReturnType<typeof output>) => { value.directions[0].hook = 'x'.repeat(1601); }, 'MODEL_RESPONSE'],
    [(value: ReturnType<typeof output>) => { Object.assign(value.directions[0], { claims: [{ text: 'Invented benefit', evidenceIds: ['evidence-0'] }] }); }, 'MODEL_RESPONSE'],
  ] as const) {
    const value = output();
    mutate(value);
    assert.throws(() => validateDirections(value, evidence, operation, project), error => error instanceof AppError && error.code === code);
  }
  const seed = output();
  seed.directions[0].visuals.references = ['Seed brand'];
  assert.deepEqual(validateDirections(seed, evidence, operation, project)[0].visuals.references, ['Seed brand']);
});


test('current Gemini models use supported low reasoning without deprecated sampling parameters', async () => {
  const { project, operation, evidence } = fixture();
  const original = globalThis.fetch;
  let body: Record<string, unknown> = {};
  globalThis.fetch = async (_url, init) => {
    const request = JSON.parse(String(init?.body));
    if (isCampaignReview(request)) return geminiResponse(request, { issues: [] });
    body = request;
    return geminiResponse(request, output(1));
  };
  try {
    await synthesize({ MODEL_API_KEY: 'synthetic-test-key', MODEL_NAME: 'gemini-3.5-flash-lite' }, operation, evidence, project);
    const config = body.generation_config as Record<string, unknown>;
    assert.equal(config.temperature, undefined);
    assert.equal(config.thinking_level, 'low');
    assert.equal(config.max_output_tokens, 10000);
    assert.equal((body.response_format as Record<string, unknown>).mime_type, 'application/json');
    assert.ok((body.response_format as Record<string, unknown>).schema);
    assert.equal(body.store, false);
  } finally { globalThis.fetch = original; }
});


test('OpenCode generation schema retains array bounds and limits visual references to the validated catalog', async () => {
  const { project, operation, evidence } = fixture();
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (_url, init) => {
    calls++;
    const body = JSON.parse(String(init?.body));
    const schema = body.response_format.json_schema.schema;
    const directions = schema.properties.directions;
    assert.equal(directions.minItems, 3);
    assert.equal(directions.maxItems, 3);
    const fields = directions.items.properties;
    assert.equal(fields.evidenceIds.minItems, 2);
    assert.equal(fields.evidenceIds.maxItems, 6);
    assert.equal(fields.campaign.properties.evidenceBridge.minItems, 2);
    assert.equal(fields.campaign.properties.evidenceBridge.maxItems, 3);
    assert.equal(fields.visuals.properties.references.minItems, 1);
    assert.equal(fields.visuals.properties.references.maxItems, 5);
    assert.deepEqual(fields.visuals.properties.references.items.enum, [...new Set(evidence.flatMap(record => [record.entity.name, ...record.context.referenceNames]))]);
    return Response.json({ choices: [{ message: { content: JSON.stringify(output(1)) } }] });
  };
  try {
    const draft = await generateDraft({ MODEL_PROVIDER: 'opencode', OPENCODE_API_KEY: 'test-key' }, operation, evidence, project);
    assert.equal(draft.directions.length, 3);
    assert.equal(calls, 1);
  } finally { globalThis.fetch = original; }
});

test('OpenCode responses still reject insufficient and unsupported citations or references', async () => {
  const { project, operation, evidence } = fixture();
  const original = globalThis.fetch;
  let value = output(1);
  globalThis.fetch = async () => Response.json({ choices: [{ message: { content: JSON.stringify(value) } }] });
  try {
    value.directions[0].evidenceIds = ['E1'];
    await assert.rejects(() => generateDraft({ MODEL_PROVIDER: 'opencode', OPENCODE_API_KEY: 'test-key' }, operation, evidence, project), error => error instanceof AppError && error.code === 'MODEL_RESPONSE');
    value = output(1); value.directions[0].evidenceIds = ['E1', 'unknown'];
    await assert.rejects(() => generateDraft({ MODEL_PROVIDER: 'opencode', OPENCODE_API_KEY: 'test-key' }, operation, evidence, project), error => error instanceof AppError && error.code === 'INVALID_CITATIONS');
    value = output(1); value.directions[0].visuals.references = ['Outside this operation'];
    await assert.rejects(() => generateDraft({ MODEL_PROVIDER: 'opencode', OPENCODE_API_KEY: 'test-key' }, operation, evidence, project), error => error instanceof AppError && error.code === 'UNSUPPORTED_VISUAL_REFERENCE');
  } finally { globalThis.fetch = original; }
});
