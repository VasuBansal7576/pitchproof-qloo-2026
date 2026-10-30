import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { makeOperation, makeProject } from '../server/pitchproof';
import { parseProjectInput } from '../server/validation';
import { normalizeEvidence } from '../server/providers/qloo';
import { CONTRACT_VERSION, modelConfiguration, revisionPlan, synthesize } from '../server/providers/synthesis';
import { renderBriefHtml, renderBriefMarkdown } from '../lib/export';
import { CATEGORIES, type Evidence, type Generation, type Operation } from '../lib/pitchproof-types';
import { AppError, now, uid } from '../server/errors';

const env = { MODEL_API_KEY: process.env.MODEL_API_KEY, OPENCODE_API_KEY: process.env.OPENCODE_API_KEY, MODEL_PROVIDER: process.env.MODEL_PROVIDER || 'gemini', MODEL_NAME: process.env.MODEL_NAME };
assert.ok(modelConfiguration(env).configured, 'Configure a real model credential before running this check.');
const output = resolve('outputs/pre-qloo-model');
await mkdir(output, { recursive: true });
const receipt: Record<string, unknown> = { startedAt: now(), source: 'Real model API with explicitly synthetic evidence. Qloo is not contacted.', fullQlooWorkflowVerified: false, checks: {} };
const checks = receipt.checks as Record<string, unknown>;
async function checkpoint() { await writeFile(resolve(output, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n'); }
const project = makeProject(parseProjectInput({
  brief: { product: 'SYNTHETIC MODEL INTEGRATION TEST', description: 'An imaginary everyday running shoe for a controlled integration check. This is not a client campaign.', category: 'Running footwear', market: 'London', audience: 'A proposed city-running audience, not observed customers', objective: 'Test structured creative synthesis', constraints: 'All supplied evidence is invented test data. Explicitly disclose synthetic evidence in every direction and never imply real Qloo research.', website: '', productFacts: [{ id: 'F1', text: 'An imaginary everyday running shoe used only for this synthetic integration check.', source: 'user_supplied', sourceUrl: null }], callToAction: 'Explore the test product' },
  references: [{ query: 'Fixture Footwear', role: 'competitor' }, { query: 'Fixture Studio', role: 'aesthetic' }, { query: 'Fixture Trails', role: 'audience' }],
}));
project.references.forEach((reference, index) => { reference.entity = { id: `fixture-brand-${index}`, name: reference.query, type: 'urn:entity:brand', description: 'Invented brand used only for integration testing.', image: null, url: null }; });
function fixtures(operation: Operation): Evidence[] {
  return operation.steps.slice(0, 2).flatMap((step, index) => normalizeEvidence({ results: { entities: Array.from({ length: 3 }, (_, row) => ({ entity_id: `fixture-${operation.id}-${index}-${row}`, name: `Imaginary ${step.category} reference ${row + 1}`, types: [`urn:entity:${step.category}`], properties: { description: `Synthetic example for ${['community gatherings', 'night-time city exploration', 'everyday creative routines'][row]}. This entity is invented and is not a Qloo observation.` }, query: { affinity: 0.4 + row * 0.1 } })) } }, operation, step).map(evidence => ({ ...evidence, observation: `SYNTHETIC FIXTURE ONLY. ${evidence.observation}`, context: { ...evidence.context, endpoint: 'synthetic-fixture://no-qloo-request' } })));
}
function generation(operation: Operation, directions: Generation['directions']): Generation {
  return { id: uid(), createdAt: now(), model: `${env.MODEL_PROVIDER}/${env.MODEL_NAME}`, directions, evidenceIds: [...new Set(directions.flatMap(direction => direction.claims.flatMap(claim => claim.evidenceIds)))], parentDirectionId: operation.parentDirectionId, feedback: operation.feedback, brief: structuredClone(operation.brief), references: structuredClone(operation.references), contractVersion: CONTRACT_VERSION, runStartedAt: operation.startedAt };
}
function validateProductPilots(directions: Generation['directions']) {
  for (const direction of directions) {
    assert.deepEqual(direction.productFactIds, ['F1']);
    assert.equal(direction.campaign?.callToAction, project.brief.callToAction);
    const contract = direction.testPlan.contract;
    assert.ok(contract);
    assert.equal(contract.version, 1);
    assert.deepEqual(contract.shared.productFactIds, ['F1']);
    assert.equal(contract.shared.callToAction, project.brief.callToAction);
    assert.equal(contract.shared.durationSeconds, 15);
    assert.equal(contract.arms.length, 2);
    assert.notEqual(contract.arms[0].message, contract.arms[1].message);
  }
}
try {
  const operation = makeOperation(project, 'research');
  const evidence = fixtures(operation);
  assert.ok(new Set(evidence.map(item => item.category)).size >= 2);
  project.evidence = evidence;
  console.log('Checking real structured synthesis with synthetic evidence.');
  const directions = await synthesize(env, operation, evidence, project);
  assert.equal(directions.length, 3);
  validateProductPilots(directions);
  project.generations.push(generation(operation, directions));
  checks.initialStructuredSynthesis = { pass: true, directionCount: 3, evidenceCount: evidence.length, citationIdsValidatedByApplication: true, observedAt: now() };
  await checkpoint();
  const parentDirection = directions[0];
  const feedback = 'Shift the idea toward accessible local community gatherings and conversational audio. Keep the production simple and remove performance competition. This remains a synthetic integration check.';
  console.log('Checking real feedback research planning.');
  const categories = await revisionPlan(env, feedback, project, parentDirection.id);
  assert.equal(categories.length, 2);
  assert.equal(new Set(categories).size, 2);
  assert.ok(categories.every(category => CATEGORIES.includes(category)));
  checks.feedbackPlanning = { pass: true, categories, observedAt: now() };
  await checkpoint();
  const revision = makeOperation(project, 'revision', feedback, parentDirection.id, categories);
  const revisionEvidence = fixtures(revision);
  project.evidence.push(...revisionEvidence);
  const original = JSON.stringify(project.generations[0]);
  console.log('Checking real structured revision with new synthetic evidence.');
  const revised = await synthesize(env, revision, revisionEvidence, project);
  validateProductPilots(revised);
  project.generations.push(generation(revision, revised));
  assert.equal(JSON.stringify(project.generations[0]), original);
  const revisionIds = new Set(revisionEvidence.map(item => item.id));
  assert.ok(revised.every(direction => direction.claims.every(claim => claim.evidenceIds.every(id => revisionIds.has(id)))));
  project.selectedDirectionId = revised[0].id;
  project.annotations[revised[0].id] = 'Synthetic integration review note. Never present this artifact as a real Qloo campaign.';
  checks.structuredRevision = { pass: true, directionCount: revised.length, citesOnlyRevisionEvidence: true, originalGenerationUnchanged: true, observedAt: now() };
  const html = renderBriefHtml(project);
  const markdown = renderBriefMarkdown(project);
  const escapedTitle = revised[0].title.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);
  assert.ok(html.includes(`<h2>${escapedTitle}</h2>`));
  assert.ok(markdown.includes(revised[0].title));
  assert.ok(html.includes('Synthetic integration review note.'));
  for (const text of ['Explicit product fact ledger', 'user_supplied', 'Unverified brief context', 'Shared base edit', 'Arm 1 message', 'Operator review and run measurements']) assert.ok(html.includes(text) && markdown.includes(text));
  for (const claim of revised[0].claims) for (const id of claim.evidenceIds) assert.ok(html.includes(`id="e-${id}"`));
  await writeFile(resolve(output, 'synthetic-brief.html'), html);
  await writeFile(resolve(output, 'synthetic-brief.md'), markdown);
  await writeFile(resolve(output, 'synthetic-project.json'), JSON.stringify(project, null, 2) + '\n');
  checks.exports = { pass: true, formats: ['html', 'markdown'], selectedDirection: true, evidenceAnchors: true, annotation: true, observedAt: now() };
  receipt.completedAt = now();
  receipt.status = 'pass';
  await checkpoint();
  console.log('PASS real model synthesis, feedback planning, revision, immutable history and export rendering. Evidence was synthetic; full Qloo workflow remains unverified.');
} catch (error) {
  receipt.completedAt = now();
  receipt.status = 'failed';
  receipt.error = error instanceof AppError ? { code: error.code, status: error.status, message: error.message } : { name: error instanceof Error ? error.name : 'UnknownError', message: 'The model integration check failed.' };
  await checkpoint();
  console.error(JSON.stringify(receipt.error));
  process.exitCode = 1;
}
