import type { Brief, Direction, PilotContract, ProductFact } from './pitchproof-types';
import { AppError } from '../server/errors';

const claimRules = [
  /\b(?:mental clarity|clear(?:s|ing)? (?:your |the )?(?:mind|head)|clearer (?:mind|head))\b/i,
  /\b(?:built|made|designed|engineered)\s+for\s+(?:\w+\s+){0,6}(?:relays?|baton)\b|\brelay[- ]ready\b/i,
  /\b(?:built|made|designed|engineered)\s+for\s+(?:\w+\s+){0,6}(?:turns?|turning|corners?|cornering)\b/i,
  /\b(?:everything|all) you need\b/i,
];
const copyFields = new Set(['title', 'hook', 'audienceHypothesis', 'strategy', 'campaign', 'device', 'proposition', 'audienceTension', 'mechanism', 'execution', 'evidenceBridge', 'interpretation', 'relevance', 'uncertainty', 'visuals', 'description', 'palette', 'references', 'channels', 'testPlan', 'message', 'limitations']);
export class KnownClaimViolation extends AppError {
  constructor(readonly field: string, readonly rule: number) {
    super(422, 'UNSUPPORTED_PRODUCT_COPY', 'Campaign copy adds a product claim that is not in the supplied product facts.');
  }
}

function invalid(code: string, message: string): never {
  throw new AppError(422, code, message);
}

export function suppliedFacts(brief: Brief): ProductFact[] {
  const facts = brief.productFacts;
  if (!Array.isArray(facts) || facts.length === 0) invalid('PRODUCT_FACTS_REQUIRED', 'Add at least one explicit product fact before generating a campaign.');
  if (facts.length > 8) invalid('PRODUCT_FACTS_INVALID', 'Use up to eight product facts with unique IDs F1 through F8.');
  const ids = new Set<string>();
  return facts.map(fact => {
    if (!fact || typeof fact !== 'object' || !/^F[1-8]$/.test(fact.id) || ids.has(fact.id)
      || typeof fact.text !== 'string' || !fact.text.trim() || fact.text.trim().length > 300
      || fact.source !== 'user_supplied' || !(fact.sourceUrl === null || typeof fact.sourceUrl === 'string')) {
      invalid('PRODUCT_FACTS_INVALID', 'Use explicit product facts of up to 300 characters, with unique IDs F1 through F8 and user-supplied provenance.');
    }
    ids.add(fact.id);
    return { id: fact.id, text: fact.text.trim(), source: 'user_supplied', sourceUrl: fact.sourceUrl };
  });
}

export function campaignCallToAction(brief: Brief): string {
  if (brief.callToAction === undefined || brief.callToAction === '') return `Explore ${brief.product.trim() || 'product'}`;
  if (typeof brief.callToAction !== 'string' || !brief.callToAction.trim() || brief.callToAction.trim().length > 180 || /[\r\n]/.test(brief.callToAction)) {
    invalid('CAMPAIGN_CTA_INVALID', 'Use one campaign call to action of up to 180 characters.');
  }
  return brief.callToAction.trim();
}

export function assertNoKnownUnsupportedClaims(copy: unknown, facts: ProductFact[]): void {
  const visit = (value: unknown, path: string): void => {
    if (typeof value === 'string') {
      let unsupportedRule = -1;
      const unsupported = value.split(/[.!?\n;:]/).some(sentence => claimRules.some((rule, index) => Array.from(sentence.matchAll(new RegExp(rule.source, `${rule.flags}g`))).some(match => {
        const prefix = sentence.slice(0, match.index);
        const suffix = sentence.slice(match.index + match[0].length);
        const simpleEnd = /^\s*(?:claims?|benefits?)?\s*$/i.test(suffix);
        const negativeEnd = /^\s*(?:(?:claims?|benefits?)(?:\s+(?:is|are)\s+verified)?)?\s*$/i.test(suffix);
        const qualified = simpleEnd && /(?:may seek|might seek|not verified|unverified|no verified|does not establish|cannot establish)\s*(?:\w+\s+){0,3}$/i.test(prefix)
          || negativeEnd && /^\s*(?:(?:there is|there are)\s+)?(?:no|not|without)\s*(?:claims?\s+(?:of|about|for)\s*)?$/i.test(prefix)
          || !/\b(?:no|not|without|unverified)\b/i.test(prefix) && /^\s+(?:claims?\s+)?(?:is|are|remains?)\s+(?:not verified|unverified|unsupported|unconfirmed)\s*$/i.test(suffix);
        const invalid = !qualified && !facts.some(fact => rule.test(fact.text) && !/\b(?:no|not|unverified|unsupported|unconfirmed)\b/i.test(fact.text));
        if (invalid) unsupportedRule = index;
        return invalid;
      })));
      if (unsupported) throw new KnownClaimViolation(path, unsupportedRule + 1);
    } else if (Array.isArray(value)) {
      value.forEach((child, index) => visit(child, `${path}.${index}`));
    } else if (value && typeof value === 'object') {
      Object.entries(value).forEach(([key, child]) => visit(child, path ? `${path}.${copyFields.has(key) ? key : 'field'}` : copyFields.has(key) ? key : 'field'));
    }
  };
  visit(copy, 'copy');
}

function selectedFacts(brief: Brief, factIds: string[]): ProductFact[] {
  const facts = suppliedFacts(brief);
  if (!Array.isArray(factIds) || !factIds.length || new Set(factIds).size !== factIds.length || factIds.some(id => !facts.some(fact => fact.id === id))) {
    invalid('PRODUCT_FACT_IDS_INVALID', 'Select at least one supplied product fact using its unique fact ID.');
  }
  return facts.filter(fact => factIds.includes(fact.id));
}

export function productRole(brief: Brief, factIds: string[]): string {
  const facts = selectedFacts(brief, factIds);
  return `Present ${brief.product.trim()} using these user-supplied product facts: ${facts.map(fact => `${fact.id}: ${fact.text}`).join('; ')}`;
}

function declarativeMessage(value: string): string {
  if (typeof value !== 'string') invalid('INVALID_PILOT_MESSAGE', 'Use one short declarative campaign message of up to 180 characters.');
  const message = value.trim();
  const request = /(?:^|[.!?;:,]\s*)(?:tag|share|nominate|comment|subscribe|register|download|upload|scan|click|tap|buy|shop|order|join|discover|explore|save|post|send|try|visit|view|watch|see|learn|book|check|choose|meet|follow|vote|sign up|keep|start|stop|get|make|find|run|wear|feel|invite|challenge)\b|\b(?:tag|share|nominate|post|send|tell|show|invite|challenge) (?:your|a|the|us)\b/i;
  if (!message || message.length > 180 || /[\r\n?!;:]|https?:\/\/|www\.|@|#/.test(message)
    || /[.]\s+\S/.test(message) || request.test(message)
    || /\b(?:you (?:must|should|can)|please|let['’]s|we invite you to)\b/i.test(message)) {
    invalid('INVALID_PILOT_MESSAGE', 'Use one short declarative campaign message without an extra call to action or participation request.');
  }
  return message;
}

function renderVariant(message: string, shared: PilotContract['shared'], facts: ProductFact[]): string {
  return `Message: ${message} | Base edit: ${shared.baseEditId} | Soundtrack: ${shared.soundtrackId} | Product facts: ${facts.map(fact => `${fact.id}: ${fact.text}`).join('; ')} | Duration: ${shared.durationSeconds} seconds | Channel: ${shared.channel} | Audience: ${shared.audience} | CTA: ${shared.callToAction} | Landing page: ${shared.landingPage}`;
}

export function buildConceptPilot(message: string, brief: Brief, factIds: string[]): Direction['testPlan'] {
  const campaignMessage = declarativeMessage(message);
  const facts = selectedFacts(brief, factIds);
  const callToAction = campaignCallToAction(brief);
  assertNoKnownUnsupportedClaims([campaignMessage, callToAction], facts);
  const contract: PilotContract = {
    version: 1,
    shared: {
      baseEditId: 'concept-base-edit-v1',
      soundtrackId: 'concept-shared-soundtrack-v1',
      productFactIds: facts.map(fact => fact.id),
      durationSeconds: 15,
      channel: 'One video ad channel selected before launch',
      audience: brief.audience.trim() || 'One audience selected before launch',
      callToAction,
      landingPage: brief.website.trim() || 'One product landing page selected before launch',
    },
    arms: [{ message: campaignMessage }, { message: `Introducing ${brief.product.trim()}.` }],
  };
  return {
    kind: 'concept',
    hypothesis: 'Changing only the campaign message may change the rate of landing-page link clicks compared with a neutral product introduction.',
    variable: 'Campaign message',
    contract,
    variants: contract.arms.map(arm => renderVariant(arm.message, contract.shared, facts)),
    controls: 'Use the same base video edit, shot order, product fact set, soundtrack, 15-second duration, video ad channel, audience, call to action and landing page for both arms. Replace only the message text in the same text slot with the same typography and timing. Randomize delivery 50/50 and split spend equally. Select and record the shared assets, channel and landing page before launch. Semantic review of both messages is required before launch.',
    budget: 'Planning default, subject to agency approval. Cap total spend at USD 200 over seven days, USD 100 per arm. Confirm or replace the amount and local-currency equivalent before launch.',
    minimumData: 'Use 1,000 delivered impressions per arm as a proposed delivery floor only. Before launch, use the agency baseline CTR and smallest practical difference to calculate the required sample. The delivery floor alone cannot establish a winner.',
    metric: 'Landing-page link clicks divided by delivered impressions, reported separately for each arm. CTR measures response to this ad, not purchases or customer taste.',
    successCriterion: 'Before launch, record the agency-approved smallest practical CTR difference, required sample and analysis rule. Advance a proposal only when comparable delivery and that predeclared rule support it. If those inputs are missing, do not launch or name a winner.',
    inconclusive: 'Stop at the approved spend cap or seven-day limit. If the required sample, comparable delivery or predeclared decision evidence is insufficient, record an inconclusive pilot. Do not name a winner or extend spend without new approval.',
  };
}
