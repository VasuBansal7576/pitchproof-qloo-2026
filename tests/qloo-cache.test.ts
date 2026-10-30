import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { searchQloo } from '../server/providers/qloo';

test('Qloo cache distinguishes the full URL and credential and does not cache failures', async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    if (calls === 4) return new Response('unavailable', { status: 503 });
    return Response.json({ results: [{ entity_id: `entity-${calls}`, name: `Entity ${calls}` }] });
  };
  try {
    const first = await searchQloo('cache-key-a', 'cache-query-a');
    assert.deepEqual(await searchQloo('cache-key-a', 'cache-query-a'), first);
    assert.equal(calls, 1);
    assert.notDeepEqual(await searchQloo('cache-key-a', 'cache-query-b'), first);
    assert.notDeepEqual(await searchQloo('cache-key-b', 'cache-query-a'), first);
    await assert.rejects(() => searchQloo('cache-key-a', 'cache-query-c'));
    assert.equal((await searchQloo('cache-key-a', 'cache-query-c'))[0].id, 'entity-5');
    assert.equal(calls, 5);
  } finally { globalThis.fetch = original; }
});
