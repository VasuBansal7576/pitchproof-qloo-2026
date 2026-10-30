import assert from 'node:assert/strict';
import test from 'node:test';
import { assertNoKnownUnsupportedClaims, buildConceptPilot, campaignCallToAction, productRole, suppliedFacts } from '../lib/product-contract';
import type { Brief, ProductFact } from '../lib/pitchproof-types';
import { AppError } from '../server/errors';

const fact = (id: string, text: string, sourceUrl: string | null = null): ProductFact => ({ id, text, source: 'user_supplied', sourceUrl });
const brief = (overrides: Partial<Brief> = {}): Brief => ({
  product: 'Stride', description: 'Reference-led relay footwear with mental clarity and everything you need.',
  category: 'Running footwear', market: 'India', audience: 'Runners who make time for a daily routine',
  objective: 'Launch', constraints: '', website: 'https://example.com/stride',
  productFacts: [fact('F2', 'The shoe weighs 230 grams.', 'https://example.com/specs'), fact('F5', 'Available in blue.')],
  ...overrides,
});
const rejects = (code: string) => (error: unknown): boolean => error instanceof AppError && error.status === 422 && error.code === code;

test('explicit facts retain stable IDs and provenance without description-derived claims', () => {
  const source = brief();
  assert.deepEqual(suppliedFacts(source), [fact('F2', 'The shoe weighs 230 grams.', 'https://example.com/specs'), fact('F5', 'Available in blue.')]);
  const returned = suppliedFacts(source);
  returned[0].text = 'Changed';
  assert.equal(source.productFacts![0].text, 'The shoe weighs 230 grams.');
  assert.throws(() => suppliedFacts(brief({ productFacts: undefined })), rejects('PRODUCT_FACTS_REQUIRED'));
  assert.throws(() => suppliedFacts(brief({ productFacts: [] })), rejects('PRODUCT_FACTS_REQUIRED'));
});

test('fact ledger rejects duplicate IDs, inferred provenance and oversized facts', () => {
  for (const productFacts of [
    [fact('F2', 'One.'), fact('F2', 'Two.')], [fact('F9', 'One.')],
    [fact('F1', '')], [fact('F1', 'x'.repeat(301))],
    [{ ...fact('F1', 'A claim.'), source: 'verified' } as unknown as ProductFact],
    [{ ...fact('F1', 'A claim.'), sourceUrl: undefined } as unknown as ProductFact],
  ]) assert.throws(() => suppliedFacts(brief({ productFacts })), rejects('PRODUCT_FACTS_INVALID'));
  assert.equal(suppliedFacts(brief({ productFacts: [fact('F8', 'x'.repeat(300))] }))[0].text.length, 300);
});

test('known unsupported claims fail wherever creative copy carries them', () => {
  const unsupported = [
    { title: 'Mental clarity with every stride' },
    { visuals: { description: 'A shoe built for relay.' } },
    { campaign: { execution: 'Stride is designed for turns.' } },
    { hook: 'Everything you need for the next run.' },
    { campaign: { mechanism: 'A relay-ready shoe.' } },
    { campaign: { mechanism: 'Built for passing the baton in dawn city routines.' } },
    { campaign: { mechanism: 'Designed for taking the unexpected turn in your daily route.' } },
    { hook: 'Nothing added. Everything you need for the city pavement.' },
    { rationale: 'Customer tastes are unverified. Built for relay.' },
    { rationale: 'Audience hypothesis. Designed for turns.' },
  ];
  for (const copy of unsupported) assert.throws(() => assertNoKnownUnsupportedClaims(copy, suppliedFacts(brief())), rejects('UNSUPPORTED_PRODUCT_COPY'));
});

test('description and reference statements cannot support product claims', () => {
  assert.throws(() => assertNoKnownUnsupportedClaims({ title: 'Built for relay', references: ['A relay brand'] }, suppliedFacts(brief())), rejects('UNSUPPORTED_PRODUCT_COPY'));
  assert.throws(() => assertNoKnownUnsupportedClaims('Mental clarity', suppliedFacts(brief())), error => {
    assert.ok(error instanceof AppError);
    assert.equal(error.code, 'UNSUPPORTED_PRODUCT_COPY');
    assert.ok(!error.message.includes('Mental clarity'));
    assert.ok(!error.message.includes('https://'));
    return true;
  });
});

test('explicit product facts support the named claim families', () => {
  for (const text of ['Offers mental clarity.', 'Built for relay.', 'Designed for turns.', 'Everything you need for running.']) {
    assert.doesNotThrow(() => assertNoKnownUnsupportedClaims({ campaign: { proposition: text } }, [fact('F1', text)]));
  }
});

test('ordinary audience hypotheses and creative routines remain eligible for semantic review', () => {
  assert.doesNotThrow(() => assertNoKnownUnsupportedClaims({ audienceHypothesis: 'The audience may seek headspace in a daily routine.', strategy: 'A creative campaign concept for routine.' }, suppliedFacts(brief())));
  assert.doesNotThrow(() => assertNoKnownUnsupportedClaims({ audienceHypothesis: 'The audience may seek mental clarity.', risk: 'There is no verified mental clarity benefit.' }, suppliedFacts(brief())));
});

test('negated and unverified product facts cannot license a positive claim', () => {
  for (const text of ['No mental clarity benefit is verified.', 'Mental clarity is unverified.', 'Not designed for turns.', 'Built for relay is unsupported.']) {
    const copy = /mental/.test(text) ? 'Offers mental clarity.' : /turns/.test(text) ? 'Designed for turns.' : 'Built for relay.';
    assert.throws(() => assertNoKnownUnsupportedClaims(copy, [fact('F1', text)]), rejects('UNSUPPORTED_PRODUCT_COPY'));
  }
});

test('negative limitations remain eligible but cannot exempt a separate positive claim', () => {
  for (const text of ['No mental clarity claims are verified.', 'Mental clarity is unverified.', 'Mental clarity claims are not verified.', 'No claims about mental clarity.', 'Not built for relay.']) {
    assert.doesNotThrow(() => assertNoKnownUnsupportedClaims({ limitations: [text] }, suppliedFacts(brief())));
  }
  for (const text of ['No mental clarity claims. Everything you need.', 'Mental clarity is unverified; built for relay.', 'No mental clarity claims: designed for turns.', 'No mental clarity claims but this shoe offers mental clarity.', 'The shoe is not without mental clarity.', 'Mental clarity is unverified by competitors but guaranteed by Stride.', 'No mental clarity benefits are unverified.', 'No mental clarity claims are unsupported.']) {
    assert.throws(() => assertNoKnownUnsupportedClaims({ limitations: [text] }, suppliedFacts(brief())), rejects('UNSUPPORTED_PRODUCT_COPY'), text);
  }
});

test('product role contains only selected supplied facts with no inferred purpose', () => {
  assert.equal(productRole(brief(), ['F5']), 'Present Stride using these user-supplied product facts: F5: Available in blue.');
  for (const ids of [[], ['F1'], ['F2', 'F2']]) assert.throws(() => productRole(brief(), ids), rejects('PRODUCT_FACT_IDS_INVALID'));
});

test('CTA has a bounded default or an explicit user value', () => {
  assert.equal(campaignCallToAction(brief()), 'Explore Stride');
  assert.equal(campaignCallToAction(brief({ callToAction: '' })), 'Explore Stride');
  assert.equal(campaignCallToAction(brief({ callToAction: '  View the shoe  ' })), 'View the shoe');
  for (const callToAction of [' ', 'x'.repeat(181), 'Explore\nproduct']) assert.throws(() => campaignCallToAction(brief({ callToAction })), rejects('CAMPAIGN_CTA_INVALID'));
  assert.equal(campaignCallToAction(brief({ callToAction: 'x'.repeat(180) })).length, 180);
});

test('concept pilot changes only message and renders both arms from shared controls', () => {
  const plan = buildConceptPilot('A daily rhythm worth keeping.', brief({ callToAction: 'View the shoe' }), ['F5', 'F2']);
  assert.equal(plan.kind, 'concept');
  assert.equal(plan.variable, 'Campaign message');
  assert.deepEqual(plan.contract, {
    version: 1,
    shared: {
      baseEditId: 'concept-base-edit-v1', soundtrackId: 'concept-shared-soundtrack-v1', productFactIds: ['F2', 'F5'],
      durationSeconds: 15, channel: 'One video ad channel selected before launch',
      audience: 'Runners who make time for a daily routine', callToAction: 'View the shoe', landingPage: 'https://example.com/stride',
    },
    arms: [{ message: 'A daily rhythm worth keeping.' }, { message: 'Introducing Stride.' }],
  });
  assert.equal(plan.variants.length, 2);
  const sharedControls = plan.variants.map(variant => variant.slice(variant.indexOf(' | Base edit:')));
  assert.equal(sharedControls[0], sharedControls[1]);
  for (const variant of plan.variants) {
    assert.ok(variant.includes('F2: The shoe weighs 230 grams.; F5: Available in blue.'));
    assert.ok(variant.includes('CTA: View the shoe'));
    assert.ok(!variant.includes('mental clarity'));
    assert.ok(!variant.includes('verified'));
  }
  assert.ok(plan.controls!.includes('same base video edit'));
  assert.ok(plan.controls!.includes('Semantic review'));
  assert.ok(plan.successCriterion.includes('do not launch or name a winner'));
});

test('message boundary rejects actual extra action and execution changes', () => {
  for (const message of [
    'Tag your running partner', 'A daily rhythm, tag your running partner.',
    'A daily rhythm. Share your route.', 'Join the relay.', 'Discover your rhythm.',
    'A daily rhythm\nA second instruction', 'A rhythm? Try it.', 'A campaign at https://example.com',
    'x'.repeat(181), '', 'Keep going', 'View the shoe',
  ]) {
    assert.throws(() => buildConceptPilot(message, brief(), ['F2']), rejects('INVALID_PILOT_MESSAGE'));
  }
});

test('pilot requires selected factual support and enforces copy limits', () => {
  assert.throws(() => buildConceptPilot('Built for relay.', brief(), ['F2']), rejects('UNSUPPORTED_PRODUCT_COPY'));
  assert.throws(() => buildConceptPilot('A daily rhythm.', brief({ productFacts: undefined }), ['F2']), rejects('PRODUCT_FACTS_REQUIRED'));
  assert.throws(() => buildConceptPilot('Built for relay.', brief({ productFacts: [fact('F2', 'Available in blue.'), fact('F5', 'Built for relay.')] }), ['F2']), rejects('UNSUPPORTED_PRODUCT_COPY'));
  assert.equal(buildConceptPilot('A'.repeat(180), brief(), ['F2']).contract!.arms[0].message.length, 180);
  assert.equal(buildConceptPilot('A creative campaign concept for routine.', brief(), ['F2']).contract!.arms[1].message, 'Introducing Stride.');
});
