import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { Miniflare, Response } from 'miniflare';

test('provider HTTP runs in Workers and refuses credential-bearing redirects', async () => {
  const bundle = await build({
    stdin: {
      contents: `import { providerJson } from './server/providers/http';
        export default { async fetch(request) {
          try { return Response.json(await providerJson(new URL(new URL(request.url).pathname, 'https://provider.example'), { headers: { 'X-Api-Key': 'test-only-sentinel' } }, 'Provider')); }
          catch (error) { return Response.json({ code: error.code, message: error.message }, { status: error.status || 500 }); }
        } };`,
      resolveDir: process.cwd(), sourcefile: 'provider-http-worker.ts',
    }, bundle: true, write: false, format: 'esm', platform: 'browser',
  });
  const requests: string[] = [];
  const mf = new Miniflare({ modules: true, script: bundle.outputFiles[0].text, compatibilityDate: '2026-05-01',
    outboundService: async request => {
      requests.push(request.url);
      assert.equal(new URL(request.url).origin, 'https://provider.example');
      assert.equal(request.headers.get('x-api-key'), 'test-only-sentinel');
      return new URL(request.url).pathname === '/redirect'
        ? new Response(null, { status: 302, headers: { location: 'https://untrusted.example/collect' } })
        : Response.json({ results: [] });
    },
  });
  try {
    const ok = await mf.dispatchFetch('https://app.example/ok');
    assert.equal(ok.status, 200, 'A normal provider request must reach the upstream in the Workers runtime');
    assert.deepEqual(await ok.json(), { results: [] });
    const redirect = await mf.dispatchFetch('https://app.example/redirect');
    assert.equal(redirect.status, 502);
    const failure = await redirect.json() as { code: string; message: string };
    assert.equal(failure.code, 'PROVIDER_REDIRECT', failure.message);
    assert.deepEqual(requests, ['https://provider.example/ok', 'https://provider.example/redirect']);
  } finally { await mf.dispose(); }
});
