import type { Project, StageMeasurement } from './pitchproof-types';

export type MeasurementSummary = {
  requests: number | null;
  durationMs: number | null;
  failedRequests: number | null;
  inputBytes: number | null;
  outputBytes: number | null;
};

export function summarizeMeasurements(measurements?: readonly StageMeasurement[]): MeasurementSummary {
  if (!measurements?.length) return { requests: null, durationMs: null, failedRequests: null, inputBytes: null, outputBytes: null };
  const bytes = (key: 'inputBytes' | 'outputBytes'): number | null => {
    if (measurements.some(measurement => !validCount(measurement[key]))) return null;
    return measurements.reduce((sum, measurement) => sum + measurement[key]!, 0);
  };
  return {
    requests: measurements.reduce((sum, measurement) => sum + measurement.requests, 0),
    durationMs: measurements.reduce((sum, measurement) => sum + measurement.durationMs, 0),
    failedRequests: measurements.reduce((sum, measurement) => sum + (measurement.status === 'failed' ? measurement.requests : 0), 0),
    inputBytes: bytes('inputBytes'), outputBytes: bytes('outputBytes'),
  };
}

function validCount(value: number | undefined | null): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function elapsed(start: string | undefined, end: string): number | null {
  if (!start) return null;
  const duration = Date.parse(end) - Date.parse(start);
  return validCount(duration) ? duration : null;
}

export function acceptanceSummary(project: Project): { automatedReadyMs: number | null; reviewedMs: number | null; accepted: boolean } {
  const generation = project.generations.at(-1);
  const acceptance = generation && generation.directions.some(direction => direction.id === project.selectedDirectionId)
    ? project.acceptances?.findLast(record => record.generationId === generation.id
      && record.directionId === project.selectedDirectionId && record.reviewedVersion === project.version - 1)
    : undefined;
  return {
    automatedReadyMs: generation ? elapsed(generation.runStartedAt ?? project.researchStartedAt, generation.createdAt) : null,
    reviewedMs: acceptance && validCount(acceptance.elapsedMs) ? acceptance.elapsedMs : null,
    accepted: acceptance !== undefined,
  };
}
