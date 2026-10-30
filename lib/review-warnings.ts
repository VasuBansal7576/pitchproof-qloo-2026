import type { Direction, ReviewWarning } from './pitchproof-types';

const labels: Record<ReviewWarning, string> = {
  feedback_conflict: 'possible conflict with brief or feedback',
  unsupported_claim: 'unverified claim',
  weak_campaign: 'campaign needs development',
  evidence_gap: 'evidence interpretation needs review',
  confounded_test: 'test design needs review',
};

export function hasReviewWarnings(direction: Direction): boolean {
  return !!direction.unverifiedClaim || !!direction.reviewWarnings?.length;
}

export function reviewWarningText(direction: Direction): string {
  const warnings = new Set(direction.reviewWarnings ?? []);
  if (direction.unverifiedClaim) warnings.add('unsupported_claim');
  return [...warnings].map(warning => labels[warning]).join(', ');
}
