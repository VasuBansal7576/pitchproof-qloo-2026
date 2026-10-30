import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

const base = new URL(process.argv[2] || 'http://127.0.0.1:5173');
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname), 'Run this check only against a local development database.');
const input = {
  brief: {
    product: `HTTP verification ${randomUUID().slice(0, 8)}`,
    description: 'Synthetic input for a local HTTP behavior check.', category: 'Running footwear',
    market: 'London', audience: 'Recreational runners', objective: 'Launch a new product', constraints: '', website: '',
    productFacts: [{ id: 'F1', text: 'A hypothetical running shoe used only for this local HTTP behavior check.', source: 'user_supplied', sourceUrl: null }], callToAction: 'Explore the test product',
  },
  references: [{ query: 'Nike', role: 'competitor' }, { query: 'On', role: 'aesthetic' }, { query: 'Patagonia', role: 'audience' }],
};

async function call(path, body, cookie, origin = base.origin) {
  const response = await fetch(new URL(path, base), {
    method: body ? 'POST' : 'GET',
    headers: { ...(body ? { 'Content-Type': 'application/json', Origin: origin } : {}), ...(cookie ? { Cookie: cookie } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  let data;
  try { data = JSON.parse(text); }
  catch {
    if (response.ok) throw new Error(`${response.status} ${path} returned a non-JSON response.`);
    data = { error: text.slice(0, 100), code: 'HTTP_ERROR' };
  }
  return { response, data };
}

const config = await call('/api/config');
assert.equal(config.response.status, 200);
assert.equal(config.data.storageConfigured, true);
const created = await call('/api/projects', input);
assert.equal(created.response.status, 200);
const cookie = created.response.headers.get('set-cookie')?.split(';')[0];
assert.ok(cookie, 'Creating a guest project must establish an owner session.');
const project = created.data.project;
const path = `/api/projects/${project.id}`;
assert.equal((await call(path, undefined, cookie)).data.project.brief.product, input.brief.product);
assert.equal((await call(path)).response.status, 404, 'Another guest must not read the project.');
const list = await call('/api/projects', undefined, cookie);
assert.ok(list.data.projects.some(item => item.id === project.id));

const command = { action: 'update_brief', ...input, expectedVersion: project.version, commandId: randomUUID() };
const winner = await call(`${path}/commands`, command, cookie);
assert.equal(winner.response.status, 200);
const retry = await call(`${path}/commands`, command, cookie);
assert.equal(retry.response.status, 200);
assert.equal(retry.data.project.version, winner.data.project.version, 'An identical retry must not mutate twice.');
const stale = await call(`${path}/commands`, { ...command, commandId: randomUUID() }, cookie);
assert.equal(stale.response.status, 409);
assert.equal(stale.data.code, 'STALE_VERSION');
const crossOrigin = await call(`${path}/commands`, { ...command, commandId: randomUUID() }, cookie, 'https://untrusted.example');
assert.equal(crossOrigin.response.status, 403);
const exported = await call(`${path}/export?format=html`, undefined, cookie);
assert.equal(exported.response.status, 409);
assert.equal(exported.data.code, 'EXPORT_NOT_READY');
assert.equal(winner.response.headers.get('cache-control'), 'private, no-store');
console.log('PASS local HTTP creation, persistence, ownership, command retries, stale edits, cross-origin rejection, and export readiness.');
