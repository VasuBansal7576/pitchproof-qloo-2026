import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeProjectSummaries, type ProjectSummary } from '../lib/pitchproof-types';

const summary = (id: string, version: number, updatedAt: string, status: ProjectSummary['status'] = 'draft'): ProjectSummary => ({ id, version, updatedAt, status, title: id, createdAt: '2026-10-26T00:00:00Z', category: 'Running footwear', market: 'London', directionCount: 0, evidenceCount: 0 });

test('a delayed list response cannot undo saved research progress or hide a newly created campaign', () => {
  const saved = { ...summary('active', 12, '2026-10-26T01:02:00Z', 'ready'), directionCount: 3, evidenceCount: 54 };
  const created = summary('new', 0, '2026-10-26T01:03:00Z');
  const merged = mergeProjectSummaries([saved, created], [summary('active', 10, '2026-10-26T01:01:00Z', 'researching')]);
  assert.deepEqual(merged, [created, saved]);
});

test('reconciliation picks up another session and preserves server recency and list bounds', () => {
  const current = Array.from({ length: 20 }, (_, index) => summary(String(index), 1, `2026-10-26T00:${String(index).padStart(2, '0')}:00Z`));
  const incoming = [summary('0', 2, '2026-10-26T01:00:00Z', 'ready'), summary('other-session', 0, '2026-10-26T00:59:00Z')];
  const merged = mergeProjectSummaries(current, incoming);
  assert.equal(merged.length, 20);
  assert.deepEqual(merged.slice(0, 2), incoming);
  assert.equal(merged.some(item => item.id === '1'), false);
  assert.equal(current[0].version, 1);
});
