import type { Direction, Evidence, Generation, Project, Reference } from './pitchproof-types';

export function comparisonDirection(project: Project, generation: Generation): { direction: Direction | undefined; label: string } {
  const current = generation.directions.find(direction => direction.id === project.selectedDirectionId);
  if (current) return { direction: current, label: 'Selected direction' };
  const latestByDirection = new Map(project.decisions.map(decision => [decision.directionId, decision]));
  const historical = [...project.decisions].reverse().find(decision => decision.decision === 'selected' && latestByDirection.get(decision.directionId) === decision && generation.directions.some(direction => direction.id === decision.directionId));
  if (historical) return { direction: generation.directions.find(direction => direction.id === historical.directionId), label: 'Previously selected direction' };
  return { direction: generation.directions[0], label: 'First direction (no selection recorded)' };
}

export function versionEvidence(generation: Generation, evidence: Evidence[]): { records: Evidence[]; missing: number } {
  const records = new Map(evidence.map(record => [record.id, record]));
  const ids = [...new Set(generation.evidenceIds)];
  return { records: ids.flatMap(id => { const record = records.get(id); return record ? [record] : []; }), missing: ids.filter(id => !records.has(id)).length };
}

function difference<T>(left: T[], right: T[], key: (item: T) => string): { leftOnly: T[]; rightOnly: T[] } {
  const leftKeys = new Set(left.map(key));
  const rightKeys = new Set(right.map(key));
  const unique = (items: T[]) => [...new Map(items.map(item => [key(item), item])).values()];
  return { leftOnly: unique(left.filter(item => !rightKeys.has(key(item)))), rightOnly: unique(right.filter(item => !leftKeys.has(key(item)))) };
}

export function referenceChanges(left: Reference[], right: Reference[]) {
  return difference(left, right, ref => JSON.stringify([ref.role, (ref.entity?.name ?? ref.query).trim().toLocaleLowerCase()]));
}

export function evidenceChanges(left: Evidence[], right: Evidence[]) {
  return difference(left, right, record => JSON.stringify([record.category, record.entity.id]));
}
