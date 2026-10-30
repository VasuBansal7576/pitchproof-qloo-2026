import assert from 'node:assert/strict';
import { test } from 'node:test';
import { comparisonDirection, evidenceChanges, referenceChanges, versionEvidence } from '../lib/comparison';
import type { Direction, Evidence, Generation, Project, Reference } from '../lib/pitchproof-types';

const direction = (id: string) => ({ id }) as Direction;
const generation = (id: string, ids: string[], evidenceIds: string[] = []) => ({ id, directions: ids.map(direction), evidenceIds }) as Generation;
const record = (id: string, entityId: string, category: Evidence['category']) => ({ id, entity: { id: entityId }, category }) as Evidence;
const reference = (name: string, role: Reference['role']) => ({ query: name, role, entity: null }) as Reference;

test('each version uses its current or most recent unrejected selection, with a labeled fallback', () => {
  const current = generation('current', ['a', 'b']);
  const history = generation('history', ['c', 'd']);
  const project = { selectedDirectionId: 'b', decisions: [
    { directionId: 'c', decision: 'selected' }, { directionId: 'd', decision: 'selected' }, { directionId: 'd', decision: 'rejected' },
  ] } as Project;
  assert.deepEqual(comparisonDirection(project, current), { direction: current.directions[1], label: 'Selected direction' });
  assert.deepEqual(comparisonDirection(project, history), { direction: history.directions[0], label: 'Previously selected direction' });
  assert.deepEqual(comparisonDirection(project, generation('none', ['x'])), { direction: direction('x'), label: 'First direction (no selection recorded)' });
});

test('version evidence retains recorded observations and reports missing records', () => {
  const first = record('one', 'entity-1', 'brand');
  const result = versionEvidence(generation('one', [], ['one', 'missing', 'one']), [first]);
  assert.deepEqual(result, { records: [first], missing: 1 });
});

test('reference and evidence differences use role and entity category instead of run IDs', () => {
  const before = [reference('Alpha', 'aesthetic'), reference('Shared', 'audience')];
  const after = [reference('Beta', 'aesthetic'), reference('shared', 'audience')];
  assert.deepEqual(referenceChanges(before, after), { leftOnly: [before[0]], rightOnly: [after[0]] });
  const oldRecords = [record('old-shared', 'shared', 'brand'), record('old-only', 'removed', 'artist')];
  const newRecords = [record('new-shared', 'shared', 'brand'), record('new-only', 'added', 'movie')];
  assert.deepEqual(evidenceChanges(oldRecords, newRecords), { leftOnly: [oldRecords[1]], rightOnly: [newRecords[1]] });
});
