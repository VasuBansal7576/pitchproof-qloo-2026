import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AppError } from '../server/errors';
import { providerJson } from '../server/providers/http';

const rejections = [
  { message: 'The schema specified in the response format is too complex to serve. Please simplify the schema.', category: 'schema-too-complex', code: 'PROVIDER_SCHEMA_TOO_COMPLEX' },
  { message: 'Invalid response_schema: properties must have a type.', category: 'invalid-schema', code: 'PROVIDER_INVALID_SCHEMA' },
  { message: 'The temperature parameter is deprecated and is not supported for this model.', category: 'unsupported-parameter', code: 'PROVIDER_UNSUPPORTED_PARAMETER' },
  { message: 'models/example is not supported for generateContent in this API version.', category: 'unsupported-model-endpoint', code: 'PROVIDER_UNSUPPORTED_MODEL_ENDPOINT' },
  { message: 'Request contains an invalid argument.', category: 'other-bad-request', code: 'PROVIDER_BAD_REQUEST' },
] as const;

for (const rejection of rejections) {
  test(`provider HTTP classifies ${rejection.category} without exposing the provider body`, async context => {
    const injected = 'AIzaFakeSentinel12345-private-prompt-sentinel';
    const logs: unknown[][] = [];
    context.mock.method(console, 'warn', (...args: unknown[]) => { logs.push(args); });
    context.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
      assert.equal(init.redirect, 'manual');
      return Response.json({ error: { code: 400, message: `${rejection.message} ${injected}`, status: 'INVALID_ARGUMENT' } }, { status: 400 });
    });
    await assert.rejects(() => providerJson(new URL('https://provider.example'), {
      headers: { 'x-api-key': injected }, body: injected, method: 'POST',
    }, 'Model provider'), error => {
      assert.ok(error instanceof AppError);
      assert.equal(error.status, 502);
      assert.equal(error.code, rejection.code);
      assert.ok(error.message.length < 200);
      assert.doesNotMatch(`${error.message} ${error.stack} ${JSON.stringify(error)}`, /sentinel|INVALID_ARGUMENT/);
      return true;
    });
    const entry = logs[0]?.[0] as { code: string; category: string };
    assert.equal(logs.length, 1);
    assert.deepEqual(Object.keys(entry).sort(), ['category', 'code']);
    assert.equal(entry.code, rejection.code);
    assert.equal(entry.category, rejection.category);
    assert.doesNotMatch(JSON.stringify(logs), /sentinel|AIzaFake|INVALID_ARGUMENT/);
  });
}

test('provider HTTP gives malformed rejection JSON a safe generic diagnosis', async context => {
  const logs: unknown[][] = [];
  context.mock.method(console, 'warn', (...args: unknown[]) => { logs.push(args); });
  context.mock.method(globalThis, 'fetch', async () => new Response('private-credential-sentinel', { status: 400 }));
  await assert.rejects(() => providerJson(new URL('https://provider.example'), {}, 'Provider'), error => {
    assert.ok(error instanceof AppError);
    assert.equal(error.code, 'PROVIDER_BAD_REQUEST');
    assert.doesNotMatch(error.message, /sentinel/);
    return true;
  });
  assert.deepEqual(logs, [[{ code: 'PROVIDER_BAD_REQUEST', category: 'other-bad-request' }]]);
});

test('provider HTTP bounds and cancels oversized rejection bodies', async context => {
  let cancelled = false;
  context.mock.method(console, 'warn', () => {});
  const body = new ReadableStream<Uint8Array>({
    pull(controller) { controller.enqueue(new Uint8Array(16_385)); },
    cancel() { cancelled = true; },
  });
  context.mock.method(globalThis, 'fetch', async () => new Response(body, { status: 400 }));
  await assert.rejects(() => providerJson(new URL('https://provider.example'), {}, 'Provider'), error => error instanceof AppError && error.code === 'PROVIDER_BAD_REQUEST');
  assert.equal(cancelled, true);
});

test('provider HTTP preserves authentication, rate limit, and other failure handling', async context => {
  const logs: unknown[][] = [];
  context.mock.method(console, 'warn', (...args: unknown[]) => { logs.push(args); });
  const fetch = context.mock.method(globalThis, 'fetch');
  for (const [status, code] of [[401, 'PROVIDER_AUTH'], [403, 'PROVIDER_AUTH'], [429, 'PROVIDER_RATE_LIMIT'], [500, 'PROVIDER_ERROR']] as const) {
    fetch.mock.mockImplementation(async () => new Response('private-provider-sentinel', { status }));
    await assert.rejects(() => providerJson(new URL('https://provider.example'), {}, 'Provider'), error => {
      assert.ok(error instanceof AppError);
      assert.equal(error.code, code);
      assert.doesNotMatch(error.message, /sentinel/);
      return true;
    });
  }
  assert.deepEqual(logs, []);
});

test('provider HTTP preserves timeout handling while reading a rejection body', async context => {
  context.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => new Response(new ReadableStream({
    start(controller) {
      init.signal?.addEventListener('abort', () => controller.error(new Error('private-provider-sentinel')), { once: true });
    },
  }), { status: 400 }));
  await assert.rejects(() => providerJson(new URL('https://provider.example'), {}, 'Provider', 1), error => {
    assert.ok(error instanceof AppError);
    assert.equal(error.code, 'PROVIDER_TIMEOUT');
    assert.doesNotMatch(error.message, /sentinel/);
    return true;
  });
});


test('unknown rejections log only fixed categories rather than provider text', async context => {
  const logs: unknown[][] = [];
  context.mock.method(console, 'warn', (...args: unknown[]) => { logs.push(args); });
  context.mock.method(globalThis, 'fetch', async () => Response.json({ error: { message: 'API key expired. privatevalueXYZ987654321' } }, { status: 400 }));
  await assert.rejects(() => providerJson(new URL('https://provider.example'), {}, 'Provider'), error => error instanceof AppError && error.code === 'PROVIDER_BAD_REQUEST');
  assert.deepEqual(logs, [[{ code: 'PROVIDER_BAD_REQUEST', category: 'other-bad-request' }]]);
  assert.doesNotMatch(JSON.stringify(logs), /privatevalueXYZ987654321/);
});


test('provider field violations refine a generic invalid-argument message without leaking details', async context => {
  const logs: unknown[][] = [];
  context.mock.method(console, 'warn', (...args: unknown[]) => { logs.push(args); });
  context.mock.method(globalThis, 'fetch', async () => Response.json({ error: { message: 'Request contains an invalid argument.', details: [{ fieldViolations: [{ field: 'private-source-value', description: 'The response schema has too many states. privatevalueXYZ987654321' }] }] } }, { status: 400 }));
  await assert.rejects(() => providerJson(new URL('https://provider.example'), {}, 'Provider'), error => error instanceof AppError && error.code === 'PROVIDER_SCHEMA_TOO_COMPLEX');
  assert.doesNotMatch(JSON.stringify(logs), /private-source-value|privatevalueXYZ987654321/);
});
