import type { Direction } from './pitchproof-types';

export { buildConceptPilot } from './product-contract';

export type PilotProposal = {
  kind: 'concept' | 'execution';
  hypothesis: string;
  variable: string;
  variants: string[];
};

export function pilotPlan(proposal: PilotProposal): Direction['testPlan'] {
  const shared = 'Use two original 15-second videos in one placement, the same verified product facts, production standard, soundtrack, CTA, audience and landing page. Randomize 50/50 and split spend equally.';
  return {
    ...proposal,
    controls: proposal.kind === 'concept'
      ? `${shared} Change only the campaign proposition and the copy needed to express it. Keep the visual treatment comparable.`
      : `${shared} Keep the campaign proposition and copy identical. Change only the declared visual treatment.`,
    budget: 'PitchProof planning default, subject to agency approval. Cap total spend at USD 200 over seven days, USD 100 per arm. Confirm or replace the amount and local-currency equivalent before launch.',
    minimumData: 'Use 1,000 delivered impressions per arm as a proposed delivery floor only. Before launch, use the agency baseline CTR and smallest practical difference to calculate the required sample. The delivery floor alone cannot establish a winner.',
    metric: 'Landing-page link clicks divided by delivered impressions, reported separately for each arm. CTR measures response to this ad, not purchases or customer taste.',
    successCriterion: 'Before launch, record the agency-approved smallest practical CTR difference, required sample and analysis rule. Advance a proposal only when comparable delivery and that predeclared rule support it. If those inputs are missing, do not launch or name a winner.',
    inconclusive: 'Stop at the approved spend cap or seven-day limit. If the required sample, comparable delivery or predeclared decision evidence is insufficient, record an inconclusive pilot. Do not name a winner or extend spend without new approval.',
  };
}
