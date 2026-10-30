import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const DEFAULT_ORIGIN = 'https://pitchproof-studio.zippy17.chatgpt.site';
const CATEGORIES = ['brand', 'artist', 'movie', 'place', 'podcast'];
const MAX_ADVANCES = 12;
const NOTE = 'Agency QA note: validate this cultural association with runners before treating it as an audience truth.';
const FEEDBACK = 'Revise the visual tone toward independent cinema and music. Research fresh artist and movie associations, avoid celebrity endorsement claims, and propose a small creative test for everyday runners.';
const INPUT = {
  brief: {
    product: 'PitchProof private QA daily running shoe',
    description: 'A hypothetical daily running shoe for a controlled QA brief. No performance, sustainability, price, or athlete endorsement claims have been verified.',
    category: 'Running footwear', market: 'New York City',
    audience: 'Adults who run recreationally and want a practical everyday running routine. Cultural tastes are hypotheses to validate.',
    objective: 'Develop three distinct launch campaign hypotheses and a small creative test for each.',
    constraints: 'Private QA project. Do not invent technical product facts, purchase probabilities, endorsements, or measured audience demographics.',
    website: '',
    productFacts: [{ id: 'F1', text: 'A hypothetical daily running shoe used only in this private QA project.', source: 'user_supplied', sourceUrl: null }], callToAction: 'Explore the test product',
  },
  references: [
    { query: 'Nike', role: 'competitor' },
    { query: 'Adidas', role: 'aesthetic' },
    { query: 'Patagonia', role: 'audience' },
  ],
};
const receipt = {
  schemaVersion: 1, startedAt: new Date().toISOString(), status: 'pending', mode: 'preflight',
  scope: 'Real-provider public HTTP API smoke only. This receipt does not mark PitchProof complete.',
  events: [], checks: [],
  requiresReview: [
    'Semantic citation fidelity and creative quality require manual review of actual records and claims.',
    'The actual browser journey, reload behavior, narrow screens, downloaded print layout, and real-phone QA still require review.',
    'A second reference set, recovery behavior, guest isolation, and independent review are outside this smoke.',
  ],
};
let cookie = '';
let origin = DEFAULT_ORIGIN;
let project;
let output;

class SmokeFailure extends Error {
  constructor(code, details = {}) { super(code); this.code = code; this.details = details; }
}
function check(condition, code, details = {}) {
  if (!condition) throw new SmokeFailure(code, details);
}
function pass(name, details = {}) { receipt.checks.push({ name, status: 'pass', observedAt: new Date().toISOString(), ...details }); }
function safeCode(value) { return typeof value === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(value) ? value : 'UNRECOGNIZED_ERROR'; }
function options() {
  const args = process.argv.slice(2);
  let run = false;
  let storageOnly = false;
  let base = DEFAULT_ORIGIN;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--run') run = true;
    else if (args[i] === '--storage-only') storageOnly = true;
    else if (args[i] === '--base-url' && args[i + 1]) base = args[++i];
    else if (args[i] === '--help') {
      console.log('Node >=22. Usage: node verify-live-flow.mjs [--run | --storage-only] [--base-url http://127.0.0.1:3000]');
      return { help: true };
    } else throw new SmokeFailure('INVALID_ARGUMENT');
  }
  check(!(run && storageOnly), 'CONFLICTING_RUN_MODES');
  let url;
  try { url = new URL(base); } catch { throw new SmokeFailure('INVALID_BASE_URL'); }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) && ['http:', 'https:'].includes(url.protocol);
  check((url.origin === DEFAULT_ORIGIN || loopback) && url.pathname === '/' && !url.search && !url.hash && !url.username && !url.password, 'DISALLOWED_BASE_URL');
  return { run, storageOnly, origin: url.origin };
}
async function request(path, { method = 'GET', body, format = 'json', expectedStatus, includeCookie = true, captureCookie = true, sameOrigin = true } = {}) {
  check(path.startsWith('/api/') && !path.includes('..'), 'INVALID_API_PATH');
  const headers = { Accept: format === 'json' ? 'application/json' : format === 'html' ? 'text/html' : 'text/markdown' };
  if (cookie && includeCookie) headers.Cookie = cookie;
  if (method === 'POST') Object.assign(headers, { Origin: sameOrigin ? origin : 'https://invalid.example', 'Sec-Fetch-Site': sameOrigin ? 'same-origin' : 'cross-site', 'Content-Type': 'application/json' });
  const event = { method, path, startedAt: new Date().toISOString() };
  receipt.events.push(event);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 95_000);
  try {
    const response = await fetch(`${origin}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: controller.signal, redirect: 'error' });
    event.status = response.status;
    for (const value of response.headers.getSetCookie()) {
      const match = /^pitchproof_session=([a-f0-9]{64})(?:;|$)/.exec(value);
      if (match && captureCookie) cookie = `pitchproof_session=${match[1]}`;
    }
    let size = 0;
    const chunks = [];
    if (response.body) {
      for await (const chunk of response.body) {
        size += chunk.length;
        check(size <= 2_000_000, 'RESPONSE_TOO_LARGE', { status: response.status });
        chunks.push(chunk);
      }
    }
    const text = Buffer.concat(chunks).toString('utf8');
    const contentType = response.headers.get('content-type') ?? '';
    let data;
    if (contentType.toLowerCase().includes('application/json')) {
      try { data = JSON.parse(text); } catch { throw new SmokeFailure('MALFORMED_JSON', { status: response.status }); }
    }
    if (!response.ok) {
      event.code = data ? safeCode(data.code) : 'NON_JSON_HTTP_ERROR';
      if (expectedStatus === response.status) return data ?? { code: 'NON_JSON_HTTP_ERROR' };
      throw new SmokeFailure(event.code, { status: response.status });
    }
    check(expectedStatus === undefined || expectedStatus === response.status, 'UNEXPECTED_HTTP_STATUS', { status: response.status, expectedStatus });
    if (format === 'json') {
      check(data && typeof data === 'object' && !Array.isArray(data), 'NON_JSON_SUCCESS', { status: response.status });
      return data;
    }
    check(contentType.toLowerCase().startsWith(format === 'html' ? 'text/html' : 'text/markdown'), 'INVALID_EXPORT_TYPE', { status: response.status });
    return text;
  } catch (error) {
    const failure = error instanceof SmokeFailure ? error : new SmokeFailure(controller.signal.aborted ? 'REQUEST_TIMEOUT' : 'REQUEST_FAILED');
    event.code = failure.code;
    throw failure;
  } finally { clearTimeout(timer); event.finishedAt = new Date().toISOString(); }
}
function validateProject(value) {
  check(value && /^[a-zA-Z0-9-]{1,100}$/.test(value.id) && Number.isInteger(value.version) && value.version >= 0 && Array.isArray(value.references) && Array.isArray(value.evidence) && Array.isArray(value.generations) && Array.isArray(value.decisions) && value.annotations && typeof value.annotations === 'object', 'INVALID_PROJECT_RESPONSE');
  return value;
}
function projectPath() { return `/api/projects/${project.id}`; }
async function command(action) {
  const previousVersion = project.version;
  project = validateProject((await request(`${projectPath()}/commands`, { method: 'POST', body: { ...action, expectedVersion: previousVersion, commandId: randomUUID() } })).project);
  check(project.version > previousVersion, 'VERSION_DID_NOT_ADVANCE');
  if (project.status === 'error' || project.operation?.state === 'failed') throw new SmokeFailure(safeCode(project.operation?.failureCode) === 'UNRECOGNIZED_ERROR' ? 'OPERATION_FAILED' : safeCode(project.operation.failureCode));
  return project;
}
async function reload() {
  const previous = project;
  project = validateProject((await request(projectPath())).project);
  check(project.id === previous.id && project.version === previous.version, 'RELOAD_VERSION_CHANGED');
}
function plan(operation) {
  check(operation?.id && Array.isArray(operation.steps) && operation.steps.length > 0 && operation.steps.length < MAX_ADVANCES, 'INVALID_RESEARCH_PLAN');
  return { id: operation.id, kind: operation.kind, parentDirectionId: operation.parentDirectionId, feedback: operation.feedback, steps: operation.steps.map(({ id, category, seedIds, seedNames, seedRoles }) => ({ id, category, seedIds, seedNames, seedRoles })) };
}
async function finishOperation(expectedPlan) {
  for (let i = 0; project.operation && i < MAX_ADVANCES; i++) {
    check(project.operation.id === expectedPlan.id, 'OPERATION_CHANGED');
    await command({ action: 'advance' });
  }
  check(!project.operation && project.status === 'ready', 'ADVANCE_LIMIT_REACHED');
  const generation = project.generations.at(-1);
  validateGeneration(generation, expectedPlan);
  pass(`${expectedPlan.kind}_generation`, { runId: expectedPlan.id, generationId: generation.id, directionIds: generation.directions.map(d => d.id), evidenceCount: generation.evidenceIds.length });
  return structuredClone(generation);
}
function validateGeneration(generation, expectedPlan) {
  check(generation && Array.isArray(generation.directions) && generation.directions.length === 3 && typeof generation.model === 'string' && generation.model.length > 0, 'INVALID_GENERATION');
  check(generation.parentDirectionId === expectedPlan.parentDirectionId && generation.feedback === expectedPlan.feedback, 'GENERATION_PARENT_OR_FEEDBACK_CHANGED');
  check(JSON.stringify(generation.brief) === JSON.stringify(INPUT.brief), 'FROZEN_BRIEF_CHANGED');
  const records = project.evidence.filter(e => e.runId === expectedPlan.id);
  const ids = new Set(records.map(e => e.id));
  check(records.length >= 6 && ids.size === records.length && new Set(records.map(e => e.category)).size >= 2, 'INSUFFICIENT_REAL_EVIDENCE');
  check(Array.isArray(generation.evidenceIds) && generation.evidenceIds.length === ids.size && generation.evidenceIds.every(id => ids.has(id)) && new Set(generation.evidenceIds).size === ids.size, 'INVALID_GENERATION_EVIDENCE');
  for (const evidence of records) {
    const context = evidence.context;
    const step = expectedPlan.steps.find(s => s.category === evidence.category && JSON.stringify(s.seedIds) === JSON.stringify(context?.referenceIds));
    check(step && CATEGORIES.includes(evidence.category) && evidence.entity?.id && evidence.entity?.name && Number.isInteger(evidence.rank) && evidence.rank >= 1 && evidence.rank <= 6 && Number.isFinite(Date.parse(evidence.collectedAt)) && typeof evidence.observation === 'string' && evidence.observation.length > 0, 'INVALID_EVIDENCE_PROVENANCE');
    check(context.endpoint === 'https://hackathon.api.qloo.com/v2/insights' && JSON.stringify(context.referenceNames) === JSON.stringify(step.seedNames) && JSON.stringify(context.referenceRoles) === JSON.stringify(step.seedRoles) && context.market === INPUT.brief.market, 'INVALID_EVIDENCE_CONTEXT');
    const expectedParameters = { 'filter.type': `urn:entity:${evidence.category}`, 'signal.interests.entities': step.seedIds.join(','), take: '6' };
    if (evidence.category === 'place') expectedParameters['filter.location.query'] = INPUT.brief.market;
    check(JSON.stringify(context.parameters) === JSON.stringify(expectedParameters) && context.geographyApplied === (evidence.category === 'place'), 'INVALID_QUERY_PROVENANCE');
    check(evidence.score === null || Number.isFinite(evidence.score?.value) && ['query.affinity', 'query.measurements.affinity'].includes(evidence.score.metric), 'INVALID_SCORE_PROVENANCE');
  }
  check(new Set(generation.directions.map(d => d.id)).size === 3 && new Set(generation.directions.map(d => d.title.trim().toLowerCase())).size === 3 && new Set(generation.directions.map(d => d.hook.trim().toLowerCase())).size === 3, 'DUPLICATE_DIRECTIONS');
  for (const direction of generation.directions) {
    check(Array.isArray(direction.claims) && direction.claims.length >= 2 && direction.claims.every(c => typeof c.text === 'string' && c.text.length > 0 && Array.isArray(c.evidenceIds) && c.evidenceIds.length > 0 && c.evidenceIds.every(id => ids.has(id))) && new Set(direction.claims.flatMap(c => c.evidenceIds)).size >= 2, 'INVALID_CITATIONS');
    check(direction.audienceHypothesis && direction.strategy && direction.visuals?.description && Array.isArray(direction.visuals.palette) && direction.visuals.palette.length >= 3 && direction.testPlan?.hypothesis && direction.testPlan.metric && direction.testPlan.successCriterion && direction.testPlan.variants?.length >= 2 && direction.limitations?.length >= 2, 'INCOMPLETE_DIRECTION');
    const factIds = INPUT.brief.productFacts.map(fact => fact.id);
    check(Array.isArray(direction.productFactIds) && direction.productFactIds.length > 0 && new Set(direction.productFactIds).size === direction.productFactIds.length && direction.productFactIds.every(id => factIds.includes(id)), 'INVALID_PRODUCT_FACT_REFERENCES');
    const contract = direction.testPlan.contract;
    check(contract?.version === 1 && JSON.stringify(contract.shared?.productFactIds) === JSON.stringify(direction.productFactIds) && contract.shared.durationSeconds === 15 && contract.shared.callToAction === INPUT.brief.callToAction && direction.campaign?.callToAction === INPUT.brief.callToAction && ['baseEditId', 'soundtrackId', 'channel', 'audience', 'landingPage'].every(key => typeof contract.shared[key] === 'string' && contract.shared[key].length > 0), 'INVALID_SHARED_PILOT_CONTROLS');
    check(Array.isArray(contract.arms) && contract.arms.length === 2 && contract.arms.every(arm => typeof arm.message === 'string' && arm.message.length > 0 && Object.keys(arm).length === 1) && contract.arms[0].message !== contract.arms[1].message, 'INVALID_MESSAGE_ONLY_PILOT');
  }
  receipt.research ??= [];
  receipt.research.push({ ...expectedPlan, emptySteps: expectedPlan.steps.filter(s => !records.some(e => e.category === s.category && JSON.stringify(e.context.referenceIds) === JSON.stringify(s.seedIds))) });
}
function preserved(snapshot) {
  check(snapshot.generations.every(g => JSON.stringify(project.generations.find(x => x.id === g.id)) === JSON.stringify(g)), 'PRIOR_GENERATION_CHANGED');
  check(snapshot.evidence.every(e => JSON.stringify(project.evidence.find(x => x.id === e.id)) === JSON.stringify(e)), 'PRIOR_EVIDENCE_CHANGED');
  check(snapshot.decisions.every(d => project.decisions.some(x => JSON.stringify(x) === JSON.stringify(d))), 'DECISION_HISTORY_CHANGED');
  check(Object.entries(snapshot.annotations).every(([id, text]) => project.annotations[id] === text), 'ANNOTATIONS_CHANGED');
}
const htmlEscape = text => text.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
async function storageSmoke() {
  receipt.scope = 'Storage-only hosted HTTP QA. No provider authentication, brand search, research, synthesis, or full-flow claims.';
  receipt.requiresReview = [
    'All real-provider workflow gates remain blocked or unverified by this storage-only run.',
    'The actual browser journey, narrow screens, generated exports and print layout require separate verification.',
    'Provider recovery, reference sensitivity, semantic evidence fidelity and independent review remain open.',
  ];
  const input = structuredClone(INPUT);
  input.brief.product = 'PitchProof private storage-only guest QA draft';
  project = validateProject((await request('/api/projects', { method: 'POST', body: input })).project);
  receipt.projectId = project.id;
  check(cookie.length > 0 && project.status === 'draft' && project.generations.length === 0 && project.evidence.length === 0, 'INVALID_STORAGE_QA_DRAFT');
  await reload();
  check(JSON.stringify(project.brief) === JSON.stringify(input.brief), 'DRAFT_BRIEF_NOT_PERSISTED');
  const listed = await request('/api/projects');
  check(Array.isArray(listed.projects) && listed.projects.some(p => p.id === project.id && p.version === project.version && p.title === input.brief.product), 'DRAFT_NOT_IN_OWNER_LIST');
  pass('draft_get_and_list_persistence');
  const isolated = await request(projectPath(), { includeCookie: false, captureCookie: false, expectedStatus: 404 });
  check(isolated.code === 'NOT_FOUND', 'OWNER_ISOLATION_FAILED');
  const isolatedList = await request('/api/projects', { includeCookie: false, captureCookie: false });
  check(Array.isArray(isolatedList.projects) && !isolatedList.projects.some(p => p.id === project.id), 'OWNER_LIST_ISOLATION_FAILED');
  pass('owner_get_and_list_isolation_without_cookie');
  const blockedBody = { action: 'update_brief', brief: input.brief, references: input.references, expectedVersion: project.version, commandId: randomUUID() };
  const rejected = await request(`${projectPath()}/commands`, { method: 'POST', body: blockedBody, sameOrigin: false, expectedStatus: 403 });
  check(['CROSS_ORIGIN', 'NON_JSON_HTTP_ERROR'].includes(rejected.code), 'SAME_ORIGIN_REJECTION_FAILED');
  await reload();
  pass('cross_origin_command_rejected_without_mutation');
  const previousVersion = project.version;
  const updatedBrief = { ...input.brief, objective: 'Storage-only QA update. Verify persisted data, command replay, and version conflicts without provider requests.' };
  const envelope = { action: 'update_brief', brief: updatedBrief, references: input.references, expectedVersion: previousVersion, commandId: randomUUID() };
  project = validateProject((await request(`${projectPath()}/commands`, { method: 'POST', body: envelope })).project);
  check(project.version === previousVersion + 1 && JSON.stringify(project.brief) === JSON.stringify(updatedBrief), 'DRAFT_UPDATE_FAILED');
  const afterUpdate = structuredClone(project);
  const replay = validateProject((await request(`${projectPath()}/commands`, { method: 'POST', body: envelope })).project);
  check(JSON.stringify(replay) === JSON.stringify(afterUpdate), 'IDEMPOTENT_REPLAY_CHANGED_PROJECT');
  pass('identical_command_replay_without_duplicate_write', { previousVersion, version: project.version });
  const stale = await request(`${projectPath()}/commands`, { method: 'POST', body: { ...envelope, commandId: randomUUID() }, expectedStatus: 409 });
  check(stale.code === 'STALE_VERSION', 'STALE_VERSION_REJECTION_FAILED');
  await reload();
  check(JSON.stringify(project) === JSON.stringify(afterUpdate), 'REJECTED_COMMAND_CHANGED_PROJECT');
  pass('stale_version_rejected_without_mutation');
  for (const format of ['html', 'markdown']) {
    const unavailable = await request(`${projectPath()}/export?format=${format}`, { expectedStatus: 409 });
    check(unavailable.code === 'EXPORT_NOT_READY', 'UNGENERATED_EXPORT_NOT_REJECTED', { format });
  }
  await reload();
  check(project.generations.length === 0 && project.evidence.length === 0 && project.operation === null && project.status === 'draft', 'STORAGE_QA_STARTED_PROVIDER_OPERATION');
  pass('ungenerated_exports_rejected');
  await writeFile(resolve(output, 'draft.json'), JSON.stringify({ id: project.id, version: project.version, status: project.status, brief: project.brief, references: project.references.map(({ query, role, entity }) => ({ query, role, entity })) }, null, 2), { mode: 0o600 });
  receipt.status = 'storage_only_pass';
  receipt.message = 'Storage-only HTTP QA passed. No provider calls were requested. All provider and complete-browser workflow gates remain unverified.';
}
async function main() {
  check(Number(process.versions.node.split('.')[0]) >= 22, 'NODE_22_REQUIRED');
  const opts = options();
  if (opts.help) return;
  origin = opts.origin;
  receipt.origin = origin;
  receipt.mode = opts.storageOnly ? 'storage_only' : opts.run ? 'live_run' : 'preflight';
  output = resolve('outputs/live-flow', `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`);
  await mkdir(output, { recursive: true, mode: 0o700 });
  const config = await request('/api/config');
  check(['qlooConfigured', 'modelConfigured', 'storageConfigured'].every(k => typeof config[k] === 'boolean'), 'INVALID_CONFIGURATION_RESPONSE');
  receipt.configuration = Object.fromEntries(['qlooConfigured', 'modelConfigured', 'storageConfigured', 'modelName', 'modelProvider'].map(k => [k, config[k]]));
  const missing = (opts.storageOnly ? ['storageConfigured'] : ['qlooConfigured', 'modelConfigured', 'storageConfigured']).filter(k => !config[k]);
  if (missing.length) {
    receipt.status = 'blocked'; receipt.blockedOn = missing;
    receipt.message = 'Configuration is incomplete. No project or provider requests were created.';
    process.exitCode = 2;
    return;
  }
  if (opts.storageOnly) { await storageSmoke(); return; }
  pass('configuration_flags', { caveat: 'Flags do not prove authentication or successful generation.' });
  if (!opts.run) { receipt.status = 'preflight_only'; receipt.message = 'Configuration checked. Pass --run to authorize a private guest QA project and real provider requests.'; return; }
  project = validateProject((await request('/api/projects', { method: 'POST', body: INPUT })).project);
  receipt.projectId = project.id;
  check(cookie.length > 0, 'GUEST_COOKIE_MISSING');
  const confirmedIds = new Set();
  receipt.references = [];
  for (const [slot, reference] of INPUT.references.entries()) {
    const data = await request(`${projectPath()}/search`, { method: 'POST', body: { slot, query: reference.query } });
    check(Array.isArray(data.candidates), 'INVALID_CANDIDATE_RESPONSE');
    const candidates = data.candidates.map(c => ({ id: c.entity?.id, name: c.entity?.name, type: c.entity?.type }));
    const matches = data.candidates.filter(c => typeof c.entity?.name === 'string' && c.entity.name.normalize('NFKC').toLowerCase() === reference.query.normalize('NFKC').toLowerCase() && ['brand', 'urn:entity:brand'].includes(c.entity.type));
    check(matches.length === 1, 'AMBIGUOUS_OR_MISSING_EXACT_BRAND', { slot, query: reference.query, candidates });
    const candidate = matches[0];
    check(typeof candidate.entity.id === 'string' && !confirmedIds.has(candidate.entity.id) && /^[a-f0-9]{64}$/.test(candidate.token), 'INVALID_OR_DUPLICATE_REFERENCE');
    await command({ action: 'confirm_reference', slot, token: candidate.token });
    check(project.references[slot]?.entity?.id === candidate.entity.id && project.references[slot]?.role === reference.role, 'REFERENCE_CONFIRMATION_CHANGED');
    confirmedIds.add(candidate.entity.id);
    receipt.references.push({ slot, query: reference.query, role: reference.role, ...candidates.find(c => c.id === candidate.entity.id) });
  }
  pass('three_exact_distinct_confirmed_brands');
  await command({ action: 'start_research' });
  const initial = await finishOperation(plan(project.operation));
  const chosen = initial.directions[0];
  const rejected = initial.directions[1];
  const originalNoteId = chosen.claims[0].evidenceIds[0];
  await command({ action: 'choose', directionId: chosen.id });
  await command({ action: 'reject', directionId: rejected.id, reason: 'QA decision. Prefer the first hypothesis for a focused visual revision.' });
  await command({ action: 'annotate', targetId: originalNoteId, text: NOTE });
  await reload();
  check(project.selectedDirectionId === chosen.id && project.annotations[originalNoteId] === NOTE && project.decisions.some(d => d.directionId === rejected.id && d.decision === 'rejected'), 'CHOICE_REJECTION_OR_NOTE_NOT_PERSISTED');
  pass('choice_rejection_evidence_note_persisted');
  const prior = structuredClone(project);
  await command({ action: 'revise', directionId: chosen.id, feedback: FEEDBACK });
  const revisionPlan = plan(project.operation);
  check(revisionPlan.kind === 'revision' && revisionPlan.parentDirectionId === chosen.id && revisionPlan.feedback === FEEDBACK && revisionPlan.id !== receipt.research[0].id, 'INVALID_REVISION_PLAN');
  const revision = await finishOperation(revisionPlan);
  check(project.generations.length === prior.generations.length + 1 && revision.evidenceIds.every(id => !prior.evidence.some(e => e.id === id)), 'REVISION_DID_NOT_USE_NEW_EVIDENCE');
  await reload();
  preserved(prior);
  pass('revision_history_new_evidence_and_original_note_persisted');
  const revisedChoice = revision.directions[0];
  const revisedNoteId = revisedChoice.claims[0].evidenceIds[0];
  await command({ action: 'choose', directionId: revisedChoice.id });
  await command({ action: 'annotate', targetId: revisedNoteId, text: NOTE });
  const final = structuredClone(project);
  await reload();
  preserved(final);
  check(project.selectedDirectionId === revisedChoice.id && project.annotations[revisedNoteId] === NOTE, 'REVISED_SELECTION_OR_NOTE_NOT_PERSISTED');
  const citedIds = [...new Set(revisedChoice.claims.flatMap(c => c.evidenceIds))];
  for (const format of ['html', 'markdown']) {
    const text = await request(`${projectPath()}/export?format=${format}`, { format });
    const encode = format === 'html' ? htmlEscape : value => value;
    check([INPUT.brief.product, INPUT.brief.description, revisedChoice.title, revisedChoice.hook, NOTE, revision.model, revision.createdAt, revisedChoice.testPlan.metric].every(s => text.includes(encode(s))), 'EXPORT_CONTENT_MISSING', { format });
    check(['hypotheses', 'Evidence and provenance', 'Explicit product fact ledger', 'Unverified brief context', 'Operator review and run measurements', 'user_supplied', 'Shared base edit', 'Shared soundtrack', 'Arm 1 message', 'Arm 2 message'].every(value => text.includes(value)), 'EXPORT_PROVENANCE_MISSING', { format });
    check(INPUT.brief.productFacts.every(fact => text.includes(encode(`${fact.id}: ${fact.text}`))), 'EXPORT_PRODUCT_FACTS_MISSING', { format });
    check([revisedChoice.testPlan.contract.shared.baseEditId, revisedChoice.testPlan.contract.shared.soundtrackId, ...revisedChoice.testPlan.contract.arms.map(arm => arm.message)].every(value => text.includes(encode(value))), 'EXPORT_PILOT_CONTRACT_MISSING', { format });
    for (const id of citedIds) {
      const evidence = project.evidence.find(e => e.id === id);
      check([id, evidence.entity.name, evidence.context.endpoint, evidence.collectedAt, JSON.stringify(evidence.context.parameters)].every(s => text.includes(encode(s))), 'EXPORT_CITATION_PROVENANCE_MISSING', { format });
      if (format === 'html') check(text.includes(`href="#e-${htmlEscape(id)}"`) && text.includes(`id="e-${htmlEscape(id)}"`), 'EXPORT_CITATION_LINK_MISSING');
    }
    const headings = format === 'html' ? [...text.matchAll(/<h2>([\s\S]*?)<\/h2>/g)].map(m => m[1]) : [...text.matchAll(/^## (.+)$/gm)].map(m => m[1]);
    const expectedHeadings = format === 'html' ? [encode(revisedChoice.title), 'Evidence and provenance'] : ['Explicit product fact ledger', 'Operator review and run measurements', revisedChoice.title, 'Evidence and provenance'];
    check(JSON.stringify(headings) === JSON.stringify(expectedHeadings), 'EXPORT_DID_NOT_LIMIT_TO_SELECTION', { format });
    const filename = format === 'html' ? 'brief.html' : 'brief.md';
    await writeFile(resolve(output, filename), text, { mode: 0o600 });
    pass(`${format}_export_downloaded_and_checked`, { filename, selectedDirectionId: revisedChoice.id, citedEvidenceIds: citedIds });
  }
  await writeFile(resolve(output, 'project-evidence.json'), JSON.stringify({ id: project.id, version: project.version, brief: project.brief, references: project.references.map(({ query, role, entity }) => ({ query, role, entity })), evidence: project.evidence, generations: project.generations, selectedDirectionId: project.selectedDirectionId, decisions: project.decisions, annotations: project.annotations, acceptances: project.acceptances }, null, 2), { mode: 0o600 });
  receipt.status = 'api_smoke_pass';
  receipt.message = 'The real-provider API smoke passed. Manual citation fidelity and browser journey reviews remain pending.';
}
try { await main(); }
catch (error) {
  receipt.status = 'failed';
  receipt.failure = error instanceof SmokeFailure ? { code: error.code, ...error.details } : { code: 'UNEXPECTED_LOCAL_ERROR' };
  if (project && output) await writeFile(resolve(output, 'partial-project.json'), JSON.stringify(project, null, 2), { mode: 0o600 });
  receipt.message = 'Stopped at the first failure. No automatic retries or cleanup requests were sent. A timed-out server command may still finish.';
  process.exitCode = 1;
} finally {
  cookie = '';
  receipt.finishedAt = new Date().toISOString();
  if (output) {
    try { await writeFile(resolve(output, 'receipt.json'), JSON.stringify(receipt, null, 2), { mode: 0o600 }); }
    catch { process.exitCode = 1; console.error('RECEIPT_WRITE_FAILED'); }
    console.log(`${receipt.status}. Receipt directory ${output}`);
  } else if (receipt.status === 'failed') console.error(receipt.failure.code);
}
