import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { DirectionSummary } from '../components/pitchproof/comparison';
import type { Direction } from '../lib/pitchproof-types';

const direction: Direction = {
  id: 'direction', title: 'A campaign', hook: 'A hook', audienceHypothesis: 'An audience', strategy: 'A proposal',
  visuals: { description: 'Visuals', palette: [], references: [] }, channels: [], claims: [],
  testPlan: { hypothesis: 'Hypothesis', variants: [], metric: 'Metric', successCriterion: 'Criterion' }, limitations: [],
};

test('reference comparison labels each direction containing an unverified claim', () => {
  const flagged = renderToStaticMarkup(createElement(DirectionSummary, { direction: { ...direction, unverifiedClaim: true } }));
  assert.match(flagged, /unverified claim/g);
  assert.match(flagged, /excluded from exports/);
  assert.match(flagged, /A proposal/);
  const clean = renderToStaticMarkup(createElement(DirectionSummary, { direction }));
  assert.doesNotMatch(clean, /unverified claim/g);
  assert.match(clean, /A proposal/);
});


test('reference comparison labels unresolved quality warnings', () => {
  const html = renderToStaticMarkup(createElement(DirectionSummary, { direction: { ...direction, reviewWarnings: ['evidence_gap', 'confounded_test'] } }));
  assert.match(html, /evidence interpretation needs review/);
  assert.match(html, /test design needs review/);
  assert.match(html, /excluded from exports/);
});
