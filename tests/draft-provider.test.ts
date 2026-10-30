import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Brief, Evidence, Operation, Project } from '../lib/pitchproof-types';
import { AppError } from '../server/errors';
import { directionsFromDraft, generateDraft, modelConfiguration, revisionPlan, restoreDraft, reviewDraft, synthesisIdentity, synthesize } from '../server/providers/synthesis';

const env = { MODEL_PROVIDER: 'openai', MODEL_NAME: 'synthetic-model', MODEL_API_KEY: 'synthetic-key-do-not-serialize' };
function fixture(count = 6) {
  const brief: Brief = { product: 'Canvas shoe', description: 'A product introduction.', category: 'Footwear', market: 'London', audience: 'City residents', objective: 'Introduce the product', constraints: '', website: '', productFacts: [{ id: 'F1', text: 'The product is a shoe.', source: 'user_supplied', sourceUrl: null }], callToAction: 'Explore product' };
  const operation: Operation = { id: 'operation-one', kind: 'research', phase: 'synthesis', state: 'running', steps: [], brief: structuredClone(brief), references: [{ query: 'Atlas', role: 'aesthetic', entity: { id: 'seed', name: 'Atlas', type: 'brand', description: 'Seed description', image: 'https://example.com/seed.png', url: 'https://example.com/seed' } }], feedback: null, parentDirectionId: null, leaseToken: null, leaseUntil: 0, error: null, startedAt: '2026-10-26T00:00:00Z' };
  const evidence: Evidence[] = Array.from({ length: count }, (_, index) => ({ id: `canonical-${index}`, runId: operation.id, category: index % 2 ? 'artist' : 'brand', entity: { id: `entity-${index}`, name: `Observed ${index}`, type: index % 2 ? 'artist' : 'brand', description: `Description ${index}`, image: `https://example.com/${index}.png`, url: `https://example.com/${index}` }, rank: index + 1, score: { value: index / 100, metric: 'affinity' }, observation: `Canonical observation ${index}.`, collectedAt: '2026-10-26T00:00:00Z', context: { referenceNames: ['Atlas'], referenceIds: ['seed'], referenceRoles: ['aesthetic'], market: 'London', geographyApplied: index % 2 === 0, parameters: { transport: 'metadata' }, endpoint: '/insights' } }));
  const project: Project = { id: 'project-one', title: 'Draft provider test', version: 1, status: 'researching', brief, references: structuredClone(operation.references), evidence, generations: [], selectedDirectionId: null, decisions: [], annotations: {}, operation, error: null, createdAt: operation.startedAt, updatedAt: operation.startedAt };
  return { operation, evidence, project };
}
function output() {
  const devices = ['participation', 'story', 'product_discovery'] as const;
  return { directions: devices.map((device, index) => ({
    title: ['A mark on the calendar', 'A personal departure', 'The final object'][index], hook: ['An ordinary date has a personal mark', 'An ordinary departure has a personal meaning', 'The final object is a shoe'][index],
    audienceHypothesis: 'City residents may value an ordinary personal moment.', strategy: 'We propose an original personal moment as a creative introduction.', productFactIds: ['F1'],
    campaign: { device, proposition: ['A personal mark gives an ordinary date meaning.', 'A choice gives a departure personal meaning.', 'An object reveal makes the shoe the subject.'][index], audienceTension: 'The intended audience may overlook ordinary personal moments.', mechanism: ['Invite a viewer to mark one personal date on a calendar.', 'A character chooses between two ordinary plans and leaves with a small smile.', 'A bag is unpacked until only the supplied shoe remains.'][index], execution: 'Open on an original calendar. Show a personal mark and the supplied shoe. End on the product with the exact supplied CTA.', evidenceBridge: ['E1', 'E6'].map(evidenceId => ({ evidenceId, interpretation: 'We propose an ordinary personal ritual as an original creative idea.', relevance: 'A personal ritual gives this product introduction a concrete setting.', uncertainty: 'This association does not establish customer preference or purchase intent.' })) },
    visuals: { description: 'An original calendar sequence with a plain product end frame.', palette: ['#112233', '#445566', '#778899'], references: ['Observed 0'] }, channels: ['Organic social'], evidenceIds: ['E1', 'E6'], testPlan: { message: ['An ordinary date has a personal mark.', 'An ordinary departure has a personal meaning.', 'The final object is a shoe.'][index] }, limitations: ['Cultural associations do not prove a customer preference.', 'The audience hypothesis needs a controlled pilot.'],
  })) };
}
async function withFetch(response: (body: { messages: { role: string; content: string }[] }) => Response, run: () => Promise<void>) {
  const original = globalThis.fetch;
  globalThis.fetch = async (_url, init) => response(JSON.parse(String(init?.body)));
  try { await run(); } finally { globalThis.fetch = original; }
}
const modelResponse = (value: unknown) => Response.json({ choices: [{ message: { content: JSON.stringify(value) } }] });

test('OpenAI receives strict structured output for generation and review', async () => {
  const { operation, evidence, project } = fixture();
  const original = globalThis.fetch;
  const names: string[] = [];
  globalThis.fetch = async (_url, init) => {
    const request = JSON.parse(String(init?.body));
    assert.equal(request.response_format.type, 'json_schema');
    assert.equal(request.response_format.json_schema.strict, true);
    assert.equal(request.response_format.json_schema.schema.additionalProperties, false);
    if (request.response_format.json_schema.name === 'campaign_review') {
      assert.deepEqual(request.response_format.json_schema.schema.properties.issues.items.properties.code.enum, ['unsupported_claim']);
      assert.match(request.messages[0].content, /solely for unsupported product claims/);
      assert.match(request.messages[0].content, /cannot verify facts, evidence, rights or campaign results/);
    }
    names.push(request.response_format.json_schema.name);
    return modelResponse(names.length === 1 ? output() : { issues: [] });
  };
  try { assert.equal((await synthesize(env, operation, evidence, project)).length, 3); }
  finally { globalThis.fetch = original; }
  assert.deepEqual(names, ['campaign_directions', 'campaign_review']);
});

test('OpenCode Go uses its fixed endpoint and retries a transient failure after reserving quota', async () => {
  const { operation, evidence, project } = fixture();
  const original = globalThis.fetch;
  let calls = 0; let reservations = 0;
  globalThis.fetch = async (url, init) => {
    calls++;
    assert.equal(String(url), 'https://opencode.ai/inference/go/openai/v1/chat/completions');
    assert.match(new Headers(init?.headers).get('x-opencode-session') ?? '', /^ses_[0-9a-f-]+$/);
    assert.equal(JSON.parse(String(init?.body)).model, 'gpt-6-luna');
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer opencode-key');
    return calls === 1 ? new Response('unavailable', { status: 503 }) : modelResponse(output());
  };
  try {
    const draft = await generateDraft({ MODEL_PROVIDER: 'opencode', MODEL_API_KEY: 'gemini-key', OPENCODE_API_KEY: 'opencode-key' }, operation, evidence, project, undefined, undefined, async () => { reservations++; });
    assert.equal(draft.directions.length, 3);
  } finally { globalThis.fetch = original; }
  assert.equal(calls, 2);
  assert.equal(reservations, 1);
});

test('one reserved repair replaces invalid draft and passes only a fixed failure code', async () => {
  const { operation, evidence, project } = fixture();
  let calls = 0; let reservations = 0;
  await withFetch(body => {
    calls++;
    const input = JSON.parse(body.messages[1].content);
    if (calls === 1) return modelResponse({ private: 'rejected content' });
    assert.deepEqual(input.serverValidationFeedback, ['MODEL_RESPONSE']);
    assert.doesNotMatch(body.messages[1].content, /rejected content/);
    return modelResponse(output());
  }, async () => {
    const draft = await generateDraft(env, operation, evidence, project, undefined, async () => { reservations++; });
    assert.equal(draft.directions.length, 3);
  });
  assert.equal(calls, 2);
  assert.equal(reservations, 1);
});

test('a failed repair reservation prevents another provider request', async () => {
  const { operation, evidence, project } = fixture();
  let calls = 0;
  await withFetch(() => { calls++; return modelResponse({}); }, async () => {
    await assert.rejects(() => generateDraft(env, operation, evidence, project, undefined, async () => { throw new AppError(429, 'DAILY_LIMIT', 'Limit reached'); }), error => error instanceof AppError && error.code === 'DAILY_LIMIT');
  });
  assert.equal(calls, 1);
});

test('restored private drafts retain only wire aliases and publication makes fresh canonical directions', () => {
  const { operation, evidence, project } = fixture();
  const draft = restoreDraft(JSON.parse(JSON.stringify(output())), operation, evidence, project);
  assert.deepEqual(draft, output());
  for (const proposal of draft.directions) {
    assert.equal('id' in proposal, false);
    assert.equal('claims' in proposal, false);
    assert.equal('productRole' in proposal.campaign, false);
    assert.equal('callToAction' in proposal.campaign, false);
    assert.deepEqual(Object.keys(proposal.testPlan), ['message']);
  }
  const first = directionsFromDraft(draft, operation, evidence, project);
  const second = directionsFromDraft(draft, operation, evidence, project);
  assert.notEqual(first[0].id, second[0].id);
  assert.deepEqual(first[0].claims, [evidence[0], evidence[5]].map(record => ({ text: record.observation, evidenceIds: [record.id] })));
  assert.deepEqual(first[0].campaign?.evidenceBridge.map(bridge => bridge.evidenceId), [evidence[0].id, evidence[5].id]);
  assert.equal(first[0].campaign?.callToAction, operation.brief.callToAction);
  assert.equal(first[0].testPlan.contract?.version, 1);
  assert.deepEqual(draft, output(), 'Publication must not mutate the persisted wire draft');
});

test('restoration rejects canonical IDs, unknown aliases, bridge mismatches and arbitrary facts', () => {
  const { operation, evidence, project } = fixture();
  for (const mutate of [
    (value: ReturnType<typeof output>) => { value.directions[0].evidenceIds[0] = evidence[0].id; },
    (value: ReturnType<typeof output>) => { value.directions[0].evidenceIds[0] = 'E7'; },
    (value: ReturnType<typeof output>) => { value.directions[0].campaign.evidenceBridge[0].evidenceId = 'E2'; },
    (value: ReturnType<typeof output>) => { value.directions[0].productFactIds[0] = 'F2'; },
    (value: ReturnType<typeof output>) => { Object.assign(value.directions[0].testPlan, { variants: ['Invented A', 'Invented B'] }); },
    (value: ReturnType<typeof output>) => { Object.assign(value.directions[0].campaign, { productRole: 'Invented performance' }); },
  ]) {
    const value = output(); mutate(value);
    assert.throws(() => restoreDraft(value, operation, evidence, project), AppError);
  }
});

test('the compact generation DTO preserves every observation and creative input without image or URL transport fields', async () => {
  const { operation, evidence, project } = fixture(54);
  project.annotations[evidence[53].id] = 'Agency observation about the final item.';
  await withFetch(body => {
    const input = JSON.parse(body.messages[1].content);
    assert.equal(input.evidence.length, 54);
    for (const [index, record] of input.evidence.entries()) {
      const original = evidence[index];
      assert.equal(record.id, `E${index + 1}`);
      assert.deepEqual(record.entity, { id: original.entity.id, name: original.entity.name, type: original.entity.type, description: original.entity.description });
      assert.equal(record.rank, original.rank);
      assert.deepEqual(record.score, original.score);
      assert.equal(record.observation, original.observation);
      assert.deepEqual(record.context.referenceNames, original.context.referenceNames);
      assert.deepEqual(record.context.referenceIds, original.context.referenceIds);
      assert.deepEqual(record.context.referenceRoles, original.context.referenceRoles);
      assert.equal(record.context.geographyApplied, original.context.geographyApplied);
      assert.equal(record.context.market, original.context.market);
      assert.equal('image' in record.entity, false);
      assert.equal('url' in record.entity, false);
      assert.equal('endpoint' in record.context, false);
    }
    assert.equal(input.references[0].role, 'aesthetic');
    assert.equal(input.references[0].entity.description, 'Seed description');
    assert.deepEqual(input.agencyNotes.currentEvidenceNotes, [{ evidenceId: 'E54', agencyNote: project.annotations[evidence[53].id] }]);
    assert.equal(input.agencyNotes.contextKind, 'agency_context_not_qloo_evidence');
    assert.deepEqual(input.productFacts, operation.brief.productFacts);
    return modelResponse(output());
  }, async () => { await generateDraft(env, operation, evidence, project); });
});

test('identity binds full provenance, order, agency context, brief snapshots and model policy but contains no credential', () => {
  const { operation, evidence, project } = fixture();
  const original = synthesisIdentity(env, operation, evidence, project);
  assert.doesNotMatch(original, /synthetic-key-do-not-serialize|MODEL_API_KEY/);
  assert.equal(synthesisIdentity({ ...env, MODEL_API_KEY: 'another-key' }, operation, evidence, project), original);
  assert.equal(synthesisIdentity(env, { ...operation, state: 'failed', leaseToken: 'other-lease', leaseUntil: 99999 }, evidence, { ...project, version: 9 }), original);
  const changes = [
    () => synthesisIdentity({ ...env, MODEL_NAME: 'changed-model' }, operation, evidence, project),
    () => synthesisIdentity(env, { ...operation, brief: { ...operation.brief, objective: 'Changed objective' } }, evidence, project),
    () => synthesisIdentity(env, operation, evidence, { ...project, brief: { ...project.brief, description: 'Changed current brief' } }),
    () => synthesisIdentity(env, operation, [...evidence].reverse(), project),
    () => synthesisIdentity(env, operation, evidence.map((record, index) => index ? record : { ...record, entity: { ...record.entity, image: 'https://example.com/changed.png' } }), project),
    () => synthesisIdentity(env, operation, evidence, { ...project, annotations: { [evidence[0].id]: 'Changed agency note' } }),
    () => synthesisIdentity(env, { ...operation, feedback: 'Changed feedback' }, evidence, project),
    () => synthesisIdentity(env, operation, evidence, { ...project, decisions: [{ directionId: 'prior', decision: 'rejected', reason: 'Changed decision', createdAt: operation.startedAt }] }),
  ];
  for (const changed of changes) assert.notEqual(changed(), original);
  const reordered = { ...project, annotations: { z: 'last', a: 'first' } };
  assert.equal(synthesisIdentity(env, operation, evidence, reordered), synthesisIdentity(env, operation, evidence, { ...reordered, annotations: { a: 'first', z: 'last' } }));
});

test('generation gets fixed validation feedback while review outages do not change checkpoint identity', async () => {
  const { operation, evidence, project } = fixture();
  const before = synthesisIdentity(env, operation, evidence, project);
  operation.measurements = [{ stage: 'review', startedAt: operation.startedAt, durationMs: 3, status: 'failed', failureCode: 'PROVIDER_ERROR', requests: 1 }];
  assert.equal(synthesisIdentity(env, operation, evidence, project), before);
  operation.measurements.push({ stage: 'generation', startedAt: operation.startedAt, durationMs: 0, status: 'failed', failureCode: 'UNSUPPORTED_PRODUCT_COPY', requests: 0 });
  operation.validationFeedback = ['UNSUPPORTED_PRODUCT_COPY'];
  assert.notEqual(synthesisIdentity(env, operation, evidence, project), before);
  await withFetch(body => {
    const input = JSON.parse(body.messages[1].content);
    assert.deepEqual(input.serverValidationFeedback, ['UNSUPPORTED_PRODUCT_COPY']);
    assert.doesNotMatch(body.messages[1].content, /synthetic-key-do-not-serialize/);
    return modelResponse(output());
  }, async () => { await generateDraft(env, operation, evidence, project); });
});

test('invalid pilot feedback guides synthetic generation while message and semantic guards remain enforced', async () => {
  const { operation, evidence, project } = fixture();
  const before = synthesisIdentity(env, operation, evidence, project);
  operation.validationFeedback = ['INVALID_PILOT_MESSAGE'];
  assert.notEqual(synthesisIdentity(env, operation, evidence, project), before);
  let message = 'Discover your moment.';
  let reviewCode: 'unsupported_claim' | null = 'unsupported_claim';
  let generationRequests = 0;
  let reviewRequests = 0;
  let generationInstruction = '';
  let validationFeedback: unknown;
  await withFetch(body => {
    const input = JSON.parse(body.messages[1].content);
    if ('proposedDirections' in input) {
      reviewRequests++;
      return modelResponse({ issues: reviewCode ? [{ directionIndex: 2, code: reviewCode, reason: 'Synthetic semantic review rejects the message.' }] : [] });
    }
    generationRequests++;
    validationFeedback = input.serverValidationFeedback;
    generationInstruction = body.messages[0].content;
    const value = output();
    value.directions[1].testPlan.message = message;
    return modelResponse(value);
  }, async () => {
    await assert.rejects(() => synthesize(env, operation, evidence, project), error => error instanceof AppError && error.code === 'INVALID_PILOT_MESSAGE' && /direction 2/.test(error.message));
    assert.equal(reviewRequests, 0);
    assert.deepEqual(validationFeedback, ['INVALID_PILOT_MESSAGE']);
    assert.match(generationInstruction, /INVALID_PILOT_MESSAGE means testPlan\.message failed the single-message boundary/);
    assert.match(generationInstruction, /accepted "An ordinary moment has personal meaning\."/);
    assert.match(generationInstruction, /rejected "Discover your moment\."/);
    message = 'An ordinary moment has personal meaning.';
    await assert.rejects(() => synthesize(env, operation, evidence, project), error => error instanceof AppError && error.code === 'CAMPAIGN_REVIEW');
    assert.equal(reviewRequests, 1);
    reviewCode = null;
    const directions = await synthesize(env, operation, evidence, project);
    assert.equal(directions.length, 3);
    assert.equal(directions[1].testPlan.contract?.arms[0].message, message);
    assert.equal(reviewRequests, 2);
    assert.equal(generationRequests, 3);
  });
});

test('validation guidance survives telemetry eviction without invalidating review checkpoints', () => {
  const { operation, evidence, project } = fixture();
  operation.validationFeedback = ['CAMPAIGN_REVIEW'];
  operation.measurements = [{ stage: 'review', startedAt: operation.startedAt, durationMs: 0, status: 'failed', failureCode: 'CAMPAIGN_REVIEW', requests: 0 }];
  const identity = synthesisIdentity(env, operation, evidence, project);
  operation.measurements = Array.from({ length: 80 }, () => ({ stage: 'review', startedAt: operation.startedAt, durationMs: 3, status: 'failed', failureCode: 'PROVIDER_ERROR', requests: 1 }));
  operation.measurementsTruncated = true;
  assert.equal(synthesisIdentity(env, operation, evidence, project), identity);
});

test('schema diagnostics contain fixed field paths and codes without rejected copy', () => {
  const { operation, evidence, project } = fixture();
  const value = output(); value.directions[0].title = '';
  Object.assign(value.directions[0].campaign, { 'private-sensitive-key': 'private-rejected-copy' });
  assert.throws(() => restoreDraft(value, operation, evidence, project), error => error instanceof AppError && error.code === 'MODEL_RESPONSE' && /directions.0.title/.test(error.message) && !/private|rejected-copy/.test(error.message));
});

test('review sees the published product and pilot contract and never exposes its private rejection reason', async () => {
  const { operation, evidence, project } = fixture();
  const draft = restoreDraft(output(), operation, evidence, project);
  const before = structuredClone(draft);
  await withFetch(body => {
    const input = JSON.parse(body.messages[1].content);
    const published = directionsFromDraft(draft, operation, evidence, project);
    assert.deepEqual(input.proposedDirections[0].testPlan, published[0].testPlan);
    assert.equal(input.proposedDirections[0].campaign.callToAction, published[0].campaign?.callToAction);
    assert.equal(input.proposedDirections[0].campaign.productRole, published[0].campaign?.productRole);
    assert.equal('id' in input.proposedDirections[0], false);
    return modelResponse({ issues: [{ directionIndex: 2, code: 'unsupported_claim', reason: 'PRIVATE GENERATED CAMPAIGN COPY MUST NOT BE EXPOSED' }] });
  }, async () => {
    await assert.rejects(() => reviewDraft(env, operation, evidence, project, draft), error => error instanceof AppError && error.code === 'CAMPAIGN_REVIEW' && /unsupported_claim in direction 2/.test(error.message) && !/PRIVATE GENERATED/.test(error.message));
  });
  assert.deepEqual(draft, before);
});

test('review outages and malformed results leave the resumable draft unchanged', async () => {
  const { operation, evidence, project } = fixture();
  const draft = restoreDraft(output(), operation, evidence, project);
  const before = structuredClone(draft);
  for (const response of [() => new Response('unavailable', { status: 503 }), () => modelResponse({ issues: 'malformed' })]) {
    await withFetch(response, async () => { await assert.rejects(() => reviewDraft(env, operation, evidence, project, draft), AppError); });
    assert.deepEqual(draft, before);
  }
});

test('unsupported product benefit copy fails before it can become a stored draft', () => {
  const { operation, evidence, project } = fixture();
  const value = output();
  value.directions[0].hook = 'This shoe brings mental clarity.';
  assert.throws(() => restoreDraft(value, operation, evidence, project), error => error instanceof AppError && error.code === 'UNSUPPORTED_PRODUCT_COPY' && !/mental clarity/.test(error.message));
});

test('validated drafts have a 35,000-byte aggregate storage bound', () => {
  const { operation, evidence, project } = fixture();
  const value = output();
  const longCopy = 'A proposed ordinary personal moment. '.repeat(40).slice(0, 1500);
  for (const [index, direction] of value.directions.entries()) {
    direction.hook = `${index} ${longCopy}`;
    direction.audienceHypothesis = longCopy;
    direction.strategy = longCopy;
    direction.campaign.proposition = longCopy;
    direction.campaign.audienceTension = longCopy;
    direction.campaign.mechanism = longCopy;
    direction.campaign.execution = longCopy;
    direction.visuals.description = longCopy;
    direction.campaign.evidenceBridge.forEach(bridge => { bridge.interpretation = longCopy; bridge.relevance = longCopy; bridge.uncertainty = longCopy; });
  }
  assert.throws(() => restoreDraft(value, operation, evidence, project), error => error instanceof AppError && error.code === 'MODEL_RESPONSE' && /saved draft limit/.test(error.message));
});


test('provider credentials select OpenCode key with legacy fallback and preserve Gemini rollback', async () => {
  assert.equal(modelConfiguration({ MODEL_PROVIDER: 'opencode', OPENCODE_API_KEY: 'opencode-key' }).configured, true);
  assert.equal(modelConfiguration({ MODEL_PROVIDER: 'opencode', MODEL_API_KEY: 'legacy-key', OPENCODE_API_KEY: '  ' }).configured, true);
  assert.equal(modelConfiguration({ MODEL_PROVIDER: 'gemini', OPENCODE_API_KEY: 'opencode-key' }).configured, false);
  const original = globalThis.fetch;
  const { project } = fixture();
  const headers: string[] = [];
  globalThis.fetch = async (_url, init) => {
    const requestHeaders = new Headers(init?.headers);
    headers.push(requestHeaders.get('authorization') ?? requestHeaders.get('x-goog-api-key') ?? '');
    if (requestHeaders.has('x-goog-api-key')) return Response.json({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify({ categories: ['brand', 'artist'] }) }] } }] });
    return modelResponse({ categories: ['brand', 'artist'] });
  };
  try {
    await revisionPlan({ MODEL_PROVIDER: 'opencode', MODEL_API_KEY: 'gemini-key', OPENCODE_API_KEY: 'opencode-key' }, 'Change the tone', project, 'direction');
    await revisionPlan({ MODEL_PROVIDER: 'opencode', MODEL_API_KEY: 'legacy-key' }, 'Change the tone', project, 'direction');
    await revisionPlan({ MODEL_PROVIDER: 'gemini', MODEL_API_KEY: 'gemini-key', OPENCODE_API_KEY: 'opencode-key' }, 'Change the tone', project, 'direction');
  } finally { globalThis.fetch = original; }
  assert.deepEqual(headers, ['Bearer opencode-key', 'Bearer legacy-key', 'gemini-key']);
});

test('review rejects incomplete or refused provider output even if it contains valid JSON', async () => {
  const { operation, evidence, project } = fixture();
  const draft = restoreDraft(output(), operation, evidence, project);
  const original = globalThis.fetch;
  try {
    for (const [finishReason, refusal, message] of [
      ['length', null, /output limit/],
      ['content_filter', null, /could not review/],
      ['stop', 'private provider explanation', /could not review/],
      ['tool_calls', null, /did not finish/],
    ] as const) {
      globalThis.fetch = async () => Response.json({ choices: [{ finish_reason: finishReason, message: { content: '{"issues":[]}', refusal } }] });
      await assert.rejects(() => reviewDraft({ MODEL_PROVIDER: 'opencode', OPENCODE_API_KEY: 'test-key' }, operation, evidence, project, draft), error => error instanceof AppError && error.code === 'MODEL_REVIEW_RESPONSE' && message.test(error.message) && !error.message.includes('private provider explanation'));
    }
    globalThis.fetch = async () => Response.json({ choices: [{ finish_reason: 'stop', message: { content: '{"issues":[]}' } }] });
    assert.deepEqual(await reviewDraft({ MODEL_PROVIDER: 'opencode', OPENCODE_API_KEY: 'test-key' }, operation, evidence, project, draft), []);
  } finally { globalThis.fetch = original; }
});

test('OpenCode gpt-6-luna uses no reasoning for generation, review and planning only', async () => {
  const { operation, evidence, project } = fixture();
  const original = globalThis.fetch;
  const requests: { reasoning_effort?: string; max_tokens: number; response_format: { json_schema: { name: string } } }[] = [];
  globalThis.fetch = async (_url, init) => {
    const request = JSON.parse(String(init?.body));
    requests.push(request);
    const name = request.response_format.json_schema.name;
    return modelResponse(name === 'campaign_directions' ? output() : name === 'campaign_review' ? { issues: [] } : { categories: ['brand', 'artist'] });
  };
  try {
    const lunar = { MODEL_PROVIDER: 'opencode', MODEL_NAME: 'gpt-6-luna', OPENCODE_API_KEY: 'test-key' };
    const draft = await generateDraft(lunar, operation, evidence, project);
    await reviewDraft(lunar, operation, evidence, project, draft);
    await revisionPlan(lunar, 'Change the tone', project, 'direction');
    assert.deepEqual(requests.map(request => request.reasoning_effort), ['none', 'none', 'none']);
    assert.deepEqual(requests.map(request => request.max_tokens), [7000, 4000, 300]);
    requests.length = 0;
    await generateDraft({ ...lunar, MODEL_NAME: 'glm-5.3-flash' }, operation, evidence, project);
    await generateDraft({ MODEL_PROVIDER: 'openai', MODEL_NAME: 'gpt-6-luna', MODEL_API_KEY: 'test-key' }, operation, evidence, project);
    assert.deepEqual(requests.map(request => request.reasoning_effort), [undefined, undefined]);
  } finally { globalThis.fetch = original; }
});

test('allowing known claims after repair does not relax citation or pilot grammar checks', () => {
  const { operation, evidence, project } = fixture();
  const invalidCitation = output();
  invalidCitation.directions[0].testPlan.message = 'This shoe offers mental clarity.';
  invalidCitation.directions[0].evidenceIds = ['E1', 'unknown'];
  assert.throws(() => restoreDraft(invalidCitation, operation, evidence, project, true), error => error instanceof AppError && error.code === 'INVALID_CITATIONS');
  const invalidGrammar = output();
  invalidGrammar.directions[0].testPlan.message = 'Discover mental clarity!';
  assert.throws(() => restoreDraft(invalidGrammar, operation, evidence, project, true), error => error instanceof AppError && error.code === 'INVALID_PILOT_MESSAGE');
});
