import assert from 'node:assert/strict';
import { test } from 'node:test';
import { acceptanceSummary, summarizeMeasurements } from '../lib/measurement';
import { EMPTY_BRIEF, type Generation, type Project, type StageMeasurement } from '../lib/pitchproof-types';
import { AppError } from '../server/errors';
import { geminiStructuredText } from '../server/providers/gemini';
import { providerJson, type ProviderObserver } from '../server/providers/http';

type Observation = Parameters<ProviderObserver>[0];
const bytes = (value: string) => new TextEncoder().encode(value).byteLength;
const endpoint = new URL('https://private-endpoint-sentinel.example/?key=private-query-sentinel');

function assertSafe(measurement: Observation): void {
  assert.ok(Number.isFinite(Date.parse(measurement.startedAt)));
  assert.ok(Number.isFinite(measurement.durationMs) && measurement.durationMs >= 0);
  assert.equal(measurement.requests, 1);
  assert.ok(Object.isFrozen(measurement));
  assert.doesNotMatch(JSON.stringify(measurement), /sentinel|private|https|prompt|model text/);
  assert.equal(measurement.inputTokens, undefined);
  assert.equal(measurement.outputTokens, undefined);
  assert.ok(Object.keys(measurement).every(key => [
    'startedAt', 'durationMs', 'requests', 'status', 'failureCode', 'httpStatus', 'inputBytes', 'outputBytes',
  ].includes(key)));
}

test('each successful GET emits one safe observation with actual UTF-8 response bytes', async context => {
  const observations: Observation[] = [];
  const payload = '{"text":"private-model-sentinel café"}';
  const fetch = context.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
    assert.equal(init.redirect, 'manual');
    assert.ok(init.signal instanceof AbortSignal);
    return new Response(payload);
  });
  const result = await providerJson(endpoint, { headers: { 'x-api-key': 'private-key-sentinel' } }, 'Provider', 1000, false, measurement => observations.push(measurement));
  assert.deepEqual(result, { text: 'private-model-sentinel café' });
  assert.equal(fetch.mock.callCount(), 1);
  assert.equal(observations.length, 1);
  assertSafe(observations[0]);
  assert.equal(observations[0].status, 'success');
  assert.equal(observations[0].failureCode, null);
  assert.equal(observations[0].httpStatus, 200);
  assert.equal(observations[0].inputBytes, 0);
  assert.equal(observations[0].outputBytes, bytes(payload));
});

test('POST measurement counts the serialized body bytes rather than characters or estimated tokens', async context => {
  const body = JSON.stringify({ prompt: 'private-prompt-sentinel 日本語' });
  const observations: Observation[] = [];
  context.mock.method(globalThis, 'fetch', async () => new Response('{}'));
  await providerJson(endpoint, { method: 'POST', body }, 'Provider', 1000, false, measurement => observations.push(measurement));
  assert.equal(observations.length, 1);
  assertSafe(observations[0]);
  assert.equal(observations[0].inputBytes, bytes(body));
  assert.equal(observations[0].outputBytes, 2);
});

test('non-success responses and invalid JSON emit failed observations without response content', async context => {
  const observations: Observation[] = [];
  const fetch = context.mock.method(globalThis, 'fetch');
  for (const [status, payload, code, outputBytes] of [
    [503, 'private-unavailable-sentinel', 'PROVIDER_ERROR', 0],
    [200, 'private-invalid-json-sentinel', 'PROVIDER_RESPONSE', bytes('private-invalid-json-sentinel')],
    [302, 'private-redirect-sentinel', 'PROVIDER_REDIRECT', 0],
  ] as const) {
    fetch.mock.mockImplementation(async () => new Response(payload, { status }));
    await assert.rejects(() => providerJson(endpoint, {}, 'Provider', 1000, false, measurement => observations.push(measurement)),
      error => error instanceof AppError && error.code === code);
    const measurement = observations.at(-1)!;
    assertSafe(measurement);
    assert.equal(measurement.status, 'failed');
    assert.equal(measurement.failureCode, code);
    assert.equal(measurement.httpStatus, status);
    assert.equal(measurement.outputBytes, outputBytes);
  }
  assert.equal(observations.length, 3);
  assert.equal(fetch.mock.callCount(), 3);
});

test('a timeout before response emits one failure with no invented HTTP status', async context => {
  const observations: Observation[] = [];
  context.mock.method(globalThis, 'fetch', (_url: unknown, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
    init.signal?.addEventListener('abort', () => reject(new Error('private-error-sentinel')), { once: true });
  }));
  await assert.rejects(() => providerJson(endpoint, {}, 'Provider', 1, false, measurement => observations.push(measurement)),
    error => error instanceof AppError && error.code === 'PROVIDER_TIMEOUT');
  assert.equal(observations.length, 1);
  assertSafe(observations[0]);
  assert.equal(observations[0].status, 'failed');
  assert.equal(observations[0].failureCode, 'PROVIDER_TIMEOUT');
  assert.equal(observations[0].httpStatus, undefined);
  assert.equal(observations[0].outputBytes, 0);
});

test('a timeout during body reading retains the bytes actually read and HTTP status', async context => {
  const observations: Observation[] = [];
  const chunk = new TextEncoder().encode('private-partial-sentinel');
  context.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(chunk);
      init.signal?.addEventListener('abort', () => controller.error(new Error('private-body-sentinel')), { once: true });
    },
  })));
  await assert.rejects(() => providerJson(endpoint, {}, 'Provider', 1, false, measurement => observations.push(measurement)),
    error => error instanceof AppError && error.code === 'PROVIDER_TIMEOUT');
  assert.equal(observations.length, 1);
  assertSafe(observations[0]);
  assert.equal(observations[0].failureCode, 'PROVIDER_TIMEOUT');
  assert.equal(observations[0].httpStatus, 200);
  assert.equal(observations[0].outputBytes, chunk.byteLength);
});

test('bounded rejection reading counts actual chunks and preserves safe failure classification', async context => {
  const observations: Observation[] = [];
  let cancelled = false;
  context.mock.method(console, 'warn', () => {});
  context.mock.method(globalThis, 'fetch', async () => new Response(new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new Uint8Array(16_385)); },
    cancel() { cancelled = true; },
  }), { status: 400 }));
  await assert.rejects(() => providerJson(endpoint, {}, 'Provider', 1000, false, measurement => observations.push(measurement)),
    error => error instanceof AppError && error.code === 'PROVIDER_BAD_REQUEST');
  assert.equal(cancelled, true);
  assert.equal(observations.length, 1);
  assertSafe(observations[0]);
  assert.equal(observations[0].outputBytes, 16_385);
  assert.equal(observations[0].failureCode, 'PROVIDER_BAD_REQUEST');
});

test('observer exceptions cannot change successful results or replace provider failures', async context => {
  const fetch = context.mock.method(globalThis, 'fetch', async () => new Response('{"ok":true}'));
  let calls = 0;
  const observe: ProviderObserver = () => { calls++; throw new Error('observer failed'); };
  assert.deepEqual(await providerJson(endpoint, {}, 'Provider', 1000, false, observe), { ok: true });
  fetch.mock.mockImplementation(async () => new Response('', { status: 503 }));
  await assert.rejects(() => providerJson(endpoint, {}, 'Provider', 1000, false, observe),
    error => error instanceof AppError && error.code === 'PROVIDER_ERROR');
  assert.equal(calls, 2);
});

test('Gemini forwards the observer and transport success stays separate from model completion', async context => {
  const observations: Observation[] = [];
  let serialized = '';
  context.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
    serialized = String(init.body);
    return Response.json({ status: 'incomplete', steps: [], privateText: 'private-model-sentinel' });
  });
  await assert.rejects(() => geminiStructuredText({
    apiKey: 'private-key-sentinel', model: 'gemini-3.5-flash-lite', input: 'private-prompt-sentinel',
    schema: { type: 'object' }, purpose: 'synthesis', observe: measurement => observations.push(measurement),
  }), error => error instanceof AppError && error.code === 'MODEL_INCOMPLETE');
  assert.equal(observations.length, 1);
  assertSafe(observations[0]);
  assert.equal(observations[0].status, 'success');
  assert.equal(observations[0].inputBytes, bytes(serialized));
});

const measurements: StageMeasurement[] = [
  { stage: 'generation', startedAt: '2026-10-26T10:00:00.000Z', durationMs: 125, status: 'failed', failureCode: 'PROVIDER_TIMEOUT', requests: 1, inputBytes: 100, outputBytes: 0 },
  { stage: 'generation', startedAt: '2026-10-26T10:00:01.000Z', durationMs: 250, status: 'success', failureCode: null, requests: 1, inputBytes: 100, outputBytes: 300 },
  { stage: 'review', startedAt: '2026-10-26T10:00:02.000Z', durationMs: 125, status: 'success', failureCode: null, requests: 1, inputBytes: 400, outputBytes: 50 },
];

test('measurement summaries include failed attempts and keep unknown historical counts unknown', () => {
  assert.deepEqual(summarizeMeasurements(measurements), { requests: 3, durationMs: 500, failedRequests: 1, inputBytes: 600, outputBytes: 350 });
  assert.deepEqual(summarizeMeasurements(), { requests: null, durationMs: null, failedRequests: null, inputBytes: null, outputBytes: null });
  assert.deepEqual(summarizeMeasurements([]), summarizeMeasurements());
  assert.deepEqual(summarizeMeasurements([{ ...measurements[0], inputBytes: undefined, outputBytes: undefined }, measurements[1]]),
    { requests: 2, durationMs: 375, failedRequests: 1, inputBytes: null, outputBytes: null });
});

function projectFixture(): Project {
  const generation: Generation = {
    id: 'generation-1', createdAt: '2026-10-26T10:00:20.000Z', runStartedAt: '2026-10-26T10:00:10.000Z',
    model: 'example', evidenceIds: [], parentDirectionId: null, feedback: null, brief: { ...EMPTY_BRIEF },
    directions: [{
      id: 'direction-1', title: 'A direction', hook: 'A hook', audienceHypothesis: 'A hypothesis', strategy: 'A strategy',
      visuals: { description: 'A visual', palette: [], references: [] }, channels: [], claims: [], limitations: [],
      testPlan: { hypothesis: 'A pilot', variants: [], metric: 'Preference', successCriterion: 'Review results' },
    }],
  };
  return {
    id: 'project-1', title: 'A project', version: 8, status: 'ready', brief: { ...EMPTY_BRIEF }, references: [], evidence: [],
    generations: [generation], selectedDirectionId: 'direction-1', decisions: [], annotations: {}, operation: null, error: null,
    createdAt: '2026-10-26T09:00:00.000Z', updatedAt: '2026-10-26T10:00:30.000Z', researchStartedAt: '2026-10-26T10:00:00.000Z',
    acceptances: [{ generationId: 'generation-1', directionId: 'direction-1', createdAt: '2026-10-26T10:00:30.000Z', reviewedVersion: 7, elapsedMs: 30_000 }],
  };
}

test('explicit operator review is separate from automated readiness and bound to the reviewed project version', () => {
  const project = projectFixture();
  assert.deepEqual(acceptanceSummary(project), { automatedReadyMs: 10_000, reviewedMs: 30_000, accepted: true });
  project.version++;
  assert.deepEqual(acceptanceSummary(project), { automatedReadyMs: 10_000, reviewedMs: null, accepted: false });
});

test('a changed selection or latest generation invalidates earlier acceptance', () => {
  const project = projectFixture();
  project.selectedDirectionId = 'different-direction';
  assert.equal(acceptanceSummary(project).accepted, false);
  project.selectedDirectionId = 'direction-1';
  project.generations.push({ ...project.generations[0], id: 'generation-2' });
  assert.deepEqual(acceptanceSummary(project), { automatedReadyMs: 10_000, reviewedMs: null, accepted: false });
});

test('historical projects retain unknown timing rather than invented readiness or review durations', () => {
  const project = projectFixture();
  delete project.generations[0].runStartedAt;
  assert.equal(acceptanceSummary(project).automatedReadyMs, 20_000);
  delete project.researchStartedAt;
  delete project.acceptances;
  assert.deepEqual(acceptanceSummary(project), { automatedReadyMs: null, reviewedMs: null, accepted: false });
  project.generations = [];
  assert.deepEqual(acceptanceSummary(project), { automatedReadyMs: null, reviewedMs: null, accepted: false });
});
