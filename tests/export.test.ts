import test from "node:test";
import assert from "node:assert/strict";
import { renderBriefHtml, renderBriefMarkdown } from "../lib/export";
import { EMPTY_BRIEF, type Direction, type Project } from "../lib/pitchproof-types";
import { buildConceptPilot } from "../lib/product-contract";

function syntheticProject(): Project {
  const direction: Direction = {
    id: "direction-test", title: "Synthetic direction", hook: "A proposed campaign", audienceHypothesis: "A hypothesis to test",
    strategy: "A test strategy", visuals: { description: "Graphic typography", palette: ["#111111"], references: ["Synthetic film"] },
    channels: ["Social"], claims: [{ text: "Synthetic observed association", evidenceIds: ["evidence-test"] }],
    testPlan: { hypothesis: "Creative changes engagement", variants: ["Control", "Treatment"], metric: "Click-through rate", successCriterion: "Pre-register a threshold" }, limitations: ["Not a purchase prediction"],
  };
  const brief = { ...EMPTY_BRIEF, product: "Test shoe", description: "Agency facts", market: "London", audience: "Recreational runners" };
  return {
    id: "project-test", title: "Synthetic brief", version: 1, status: "ready", brief, references: [],
    evidence: [{ id: "evidence-test", runId: "run-test", category: "artist", entity: { id: "synthetic-artist", name: "Synthetic artist", type: "urn:entity:artist", description: "", image: null, url: null }, rank: 2,
      score: { value: 0.72, metric: "affinity" }, observation: "A synthetic association for testing", collectedAt: "2026-10-24T00:00:00Z",
      context: { referenceNames: ["Synthetic brand"], referenceIds: ["synthetic-brand"], referenceRoles: ["aesthetic"], market: "London", geographyApplied: false, parameters: { "filter.type": "urn:entity:artist" }, endpoint: "/v2/insights" } }],
    generations: [{ id: "generation-test", createdAt: "2026-10-24T00:00:00Z", model: "synthetic-test-model", directions: [direction], evidenceIds: ["evidence-test"], parentDirectionId: null, feedback: null, brief }],
    selectedDirectionId: null, decisions: [], annotations: {}, operation: null, error: null, createdAt: "2026-10-24T00:00:00Z", updatedAt: "2026-10-24T00:00:00Z",
  };
}

test("HTML export escapes agency and provider content instead of executing it", () => {
  const project = syntheticProject();
  project.title = '<script>alert("brief")</script>';
  project.evidence[0].observation = '<img src=x onerror="alert(1)">';
  project.annotations["direction-test"] = '<script>alert("annotation")</script>';
  const html = renderBriefHtml(project);
  assert.ok(html.includes("&lt;script&gt;"));
  assert.ok(html.includes("&lt;img"));
  assert.ok(!html.includes("<script>"));
  assert.ok(!html.includes("<img src=x"));
});

test("exports retain score context and separate agency annotation from evidence", () => {
  const project = syntheticProject();
  project.annotations["evidence-test"] = "Agency opinion";
  const markdown = renderBriefMarkdown(project);
  assert.ok(markdown.includes("affinity: 0.72"));
  assert.ok(markdown.includes("not a purchase probability"));
  assert.ok(markdown.includes("Geographic filtering was not applied"));
  assert.ok(markdown.includes("Agency annotation: Agency opinion"));
  assert.equal(project.evidence[0].observation, "A synthetic association for testing");
});

test("export uses frozen generation brief after current draft changes", () => {
  const project = syntheticProject();
  project.brief = { ...project.brief, product: "Changed unresearched product" };
  project.title = "Changed unresearched product";
  assert.ok(renderBriefMarkdown(project).includes("Product: Test shoe"));
  assert.ok(!renderBriefMarkdown(project).includes("Changed unresearched product"));
  assert.ok(!renderBriefHtml(project).includes("Changed unresearched product"));
});

test("an explicitly selected historical direction exports its own frozen brief", () => {
  const project = syntheticProject();
  const newer = structuredClone(project.generations[0]);
  newer.id = "newer-generation";
  newer.brief.product = "Newer shoe";
  newer.directions[0].id = "newer-direction";
  newer.directions[0].title = "Newer campaign";
  project.generations.push(newer);
  project.selectedDirectionId = "direction-test";
  const markdown = renderBriefMarkdown(project);
  assert.ok(markdown.startsWith("# Test shoe"));
  assert.ok(!markdown.includes("Newer campaign"));
  assert.ok(!renderBriefHtml(project).includes("Newer campaign"));
});

test("selected direction export excludes other campaign directions", () => {
  const project = syntheticProject();
  project.generations[0].directions.push({ ...project.generations[0].directions[0], id: "second", title: "Excluded direction" });
  project.selectedDirectionId = "direction-test";
  assert.ok(!renderBriefHtml(project).includes("Excluded direction"));
  assert.ok(!renderBriefMarkdown(project).includes("Excluded direction"));
});

test("a project without generated directions cannot export a finished brief", () => {
  const project = syntheticProject();
  project.generations = [];
  assert.throws(() => renderBriefHtml(project), /Generate campaign directions/);
  assert.throws(() => renderBriefMarkdown(project), /Generate campaign directions/);
});


test("reference imagery and source context use the generation snapshot after input edits", () => {
  const project = syntheticProject();
  const original = { query: "Original brand", role: "aesthetic" as const, entity: { id: "original-brand", name: "Original brand", type: "urn:entity:brand", description: "", image: "https://images.example.test/original.jpg", url: "https://example.test/original" } };
  project.generations[0].references = [original];
  project.generations[0].directions[0].visuals.references = ["Original brand"];
  project.generations[0].brief.website = "https://example.test/product";
  project.references = [{ query: "New brand", role: "aesthetic", entity: null }];
  project.annotations["direction-test"] = "Use the reviewed production treatment";
  for (const output of [renderBriefHtml(project), renderBriefMarkdown(project)]) {
    assert.ok(output.includes("Original brand"));
    assert.ok(output.includes("https://images.example.test/original.jpg"));
    assert.ok(output.includes("https://example.test/product"));
    assert.ok(output.includes("Use the reviewed production treatment"));
    assert.ok(!output.includes("New brand"));
  }
});

test("legacy inspiration names remain visible while unsafe image URLs are excluded", () => {
  const project = syntheticProject();
  project.generations[0].directions[0].visuals.references = ["Synthetic film", "Synthetic artist"];
  project.evidence[0].entity.image = "javascript:alert(1)";
  project.evidence[0].entity.url = "https://secret@example.test/private";
  for (const output of [renderBriefHtml(project), renderBriefMarkdown(project)]) {
    assert.ok(output.includes("Synthetic film"));
    assert.ok(!output.includes("javascript:"));
    assert.ok(!output.includes("secret@example"));
  }
});

test('campaign exports retain the proposition, creative evidence bridge and complete pilot decision plan', () => {
  const project = syntheticProject();
  const direction = project.generations[0].directions[0];
  const additional = { ...structuredClone(project.evidence[0]), id: 'second-evidence', observation: 'A second synthetic association' };
  project.evidence.push(additional);
  direction.claims.push({ text: additional.observation, evidenceIds: [additional.id] });
  project.generations[0].evidenceIds.push(additional.id);
  direction.campaign = {
    proposition: 'A daily ritual worth making time for',
    audienceTension: 'Finding a moment between work and home',
    productRole: 'The supplied shoe appears during preparation',
    mechanism: 'A calendar entry becomes a hand-drawn route',
    execution: 'Open on a calendar, follow the runner drawing a route, end on the supplied shoe',
    callToAction: 'Explore the daily ritual campaign',
    evidenceBridge: [{ evidenceId: 'evidence-test', interpretation: 'The association suggests an original ritual sequence', relevance: 'A routine offers this footwear brief an occasion', uncertainty: 'This creative inference cannot establish what city runners prefer' }, { evidenceId: 'second-evidence', interpretation: 'The second association offers an original calendar motif', relevance: 'The motif makes the proposed daily ritual visible', uncertainty: 'It does not predict creative performance' }],
  };
  direction.testPlan = {
    kind: 'concept', hypothesis: 'The ritual proposition may prompt campaign interest', variable: 'Campaign proposition only',
    variants: ['Ritual product introduction', 'Neutral product introduction'],
    controls: 'Same product facts, format, duration, soundtrack, CTA and audience; randomized 50/50 exposure',
    budget: 'Proposed £200 over seven days, pending agency approval', minimumData: 'Proposed 200 impressions per arm; agency baseline needed for power calculation',
    metric: 'Campaign-page clicks divided by delivered impressions', successCriterion: 'Use the predeclared agency decision threshold',
    inconclusive: 'Record no winner if the cap is reached before comparable delivery and sufficient decision evidence',
  };
  const values = [
    direction.campaign.proposition, direction.campaign.audienceTension, direction.campaign.productRole, direction.campaign.mechanism, direction.campaign.execution, direction.campaign.callToAction,
    ...direction.campaign.evidenceBridge.flatMap(bridge => [bridge.interpretation, bridge.relevance, bridge.uncertainty]),
    direction.testPlan.kind, direction.testPlan.hypothesis, direction.testPlan.variable, ...direction.testPlan.variants, direction.testPlan.controls,
    direction.testPlan.budget, direction.testPlan.minimumData, direction.testPlan.metric, direction.testPlan.successCriterion, direction.testPlan.inconclusive,
  ];
  for (const output of [renderBriefHtml(project), renderBriefMarkdown(project)]) {
    for (const value of values) { assert.ok(value); assert.ok(output.includes(value), `Export lost ${value}`); }
    assert.ok(output.includes('Synthetic observed association'));
    assert.ok(output.includes('What remains uncertain'));
  }
  const html = renderBriefHtml(project);
  assert.ok(html.includes('href="#e-evidence-test"'));
  assert.ok(html.includes('id="e-evidence-test"'));
  assert.ok(html.includes('href="#e-second-evidence"'));
  assert.ok(html.includes('id="e-second-evidence"'));
});

test('HTML export escapes every new agency and model-authored campaign field', () => {
  const project = syntheticProject();
  const fields = ['proposition', 'audienceTension', 'productRole', 'mechanism', 'execution', 'callToAction', 'interpretation', 'relevance', 'uncertainty', 'variable', 'controls', 'budget', 'minimumData', 'inconclusive'];
  const unsafe = Object.fromEntries(fields.map(field => [field, `<script>${field}</script>`]));
  project.generations[0].directions[0].campaign = {
    proposition: unsafe.proposition, audienceTension: unsafe.audienceTension, productRole: unsafe.productRole, mechanism: unsafe.mechanism, execution: unsafe.execution, callToAction: unsafe.callToAction,
    evidenceBridge: [{ evidenceId: 'evidence-test', interpretation: unsafe.interpretation, relevance: unsafe.relevance, uncertainty: unsafe.uncertainty }],
  };
  Object.assign(project.generations[0].directions[0].testPlan, { kind: 'concept', variable: unsafe.variable, controls: unsafe.controls, budget: unsafe.budget, minimumData: unsafe.minimumData, inconclusive: unsafe.inconclusive });
  const html = renderBriefHtml(project);
  assert.equal(html.includes('<script>'), false);
  for (const field of fields) assert.ok(html.includes(`&lt;script&gt;${field}&lt;/script&gt;`));
});

test('legacy saved directions still export their available test fields without empty campaign sections', () => {
  const project = syntheticProject();
  const before = structuredClone(project);
  for (const output of [renderBriefHtml(project), renderBriefMarkdown(project)]) {
    assert.ok(output.includes('Creative changes engagement'));
    assert.ok(output.includes('Pre-register a threshold'));
    assert.equal(output.includes('Campaign proposition'), false);
    assert.equal(output.includes('Observation to interpretation'), false);
    assert.equal(output.includes('undefined'), false);
  }
  assert.deepEqual(project, before);
});

test('exports distinguish the explicit frozen fact ledger from unverified description and source context', () => {
  const project = syntheticProject();
  const generation = project.generations[0];
  generation.brief = { ...generation.brief, description: 'An unverified idea about mental clarity', productFacts: [{ id: 'F3', text: 'The shoe has a blue upper', source: 'user_supplied', sourceUrl: 'https://example.test/agency-sheet' }] };
  generation.directions[0].productFactIds = ['F3'];
  project.brief = { ...generation.brief, productFacts: [{ id: 'F1', text: 'Changed unsaved fact', source: 'user_supplied', sourceUrl: null }] };
  const before = structuredClone(project);
  for (const output of [renderBriefHtml(project), renderBriefMarkdown(project)]) {
    assert.ok(output.includes('Unverified brief context'));
    assert.ok(output.includes('An unverified idea about mental clarity'));
    assert.ok(output.includes('F3: The shoe has a blue upper'));
    assert.ok(output.includes('Source: user_supplied'));
    assert.ok(output.includes('https://example.test/agency-sheet'));
    assert.ok(output.includes('PitchProof has not independently verified them'));
    assert.ok(output.includes('Product fact IDs used'));
    assert.equal(output.includes('Changed unsaved fact'), false);
    assert.equal(output.includes('Product facts supplied by the agency: An unverified idea'), false);
  }
  assert.deepEqual(project, before);
});

test('exports preserve the machine-readable pilot shared controls and each message arm', () => {
  const project = syntheticProject();
  const generation = project.generations[0];
  generation.brief.productFacts = [{ id: 'F1', text: 'The shoe has a blue upper', source: 'user_supplied', sourceUrl: null }];
  generation.brief.callToAction = 'Explore Test shoe';
  const direction = generation.directions[0];
  direction.productFactIds = ['F1'];
  direction.testPlan = buildConceptPilot('A blue accent for the everyday route.', generation.brief, ['F1']);
  direction.testPlan.variants = ['Historical presentation label A', 'Historical presentation label B'];
  const shared = direction.testPlan.contract!.shared;
  for (const output of [renderBriefHtml(project), renderBriefMarkdown(project)]) {
    for (const value of [shared.baseEditId, shared.soundtrackId, shared.channel, shared.audience, shared.callToAction, shared.landingPage, '15 seconds', 'Shared product fact IDs', 'F1', 'Arm 1 message', 'A blue accent for the everyday route.', 'Arm 2 message', 'Introducing Test shoe.']) {
      assert.ok(output.includes(value), `Export lost structured pilot value ${value}`);
    }
    assert.ok(output.includes('Replace only the message text'));
    assert.ok(output.includes('do not launch or name a winner'));
  }
});

test('exports show observed provider counts and current operator review separately from ad approval', () => {
  const project = syntheticProject();
  const generation = project.generations[0];
  generation.runStartedAt = '2026-10-23T23:59:50Z';
  generation.measurements = [
    { stage: 'research', startedAt: generation.runStartedAt, durationMs: 120, status: 'success', failureCode: null, requests: 2, inputBytes: 0, outputBytes: 300 },
    { stage: 'generation', startedAt: generation.createdAt, durationMs: 230, status: 'failed', failureCode: 'MODEL_TIMEOUT', requests: 1, inputBytes: 400, outputBytes: 0 },
    { stage: 'review', startedAt: generation.createdAt, durationMs: 50, status: 'success', failureCode: null, requests: 1, inputBytes: 500, outputBytes: 80 },
  ];
  project.selectedDirectionId = generation.directions[0].id;
  project.version = 7;
  project.acceptances = [{ generationId: generation.id, directionId: project.selectedDirectionId, createdAt: '2026-10-24T00:00:20Z', reviewedVersion: 6, elapsedMs: 30_000 }];
  for (const output of [renderBriefHtml(project), renderBriefMarkdown(project)]) {
    assert.match(output, /Provider attempts(?:<\/b>)?[: ]+4/);
    assert.match(output, /Failed provider attempts(?:<\/b>)?[: ]+1/);
    assert.ok(output.includes('10000 ms'));
    assert.ok(output.includes('30000 ms'));
    assert.ok(output.includes('400 ms'));
    assert.ok(output.includes('900'));
    assert.ok(output.includes('380'));
    assert.ok(output.includes('Requests may overlap'));
    assert.ok(output.includes('Recorded for the selected proposal and current project version'));
    assert.ok(output.includes('This does not authorize an ad launch'));
  }
  project.version++;
  for (const output of [renderBriefHtml(project), renderBriefMarkdown(project)]) {
    assert.ok(output.includes('Required. No current operator acceptance'));
    assert.equal(output.includes('30000 ms'), false);
  }
});

test('historical exports report absent facts, pilot contracts and measurements without inventing zeros', () => {
  const project = syntheticProject();
  const historical = project.generations[0];
  delete historical.brief.productFacts;
  const newer = structuredClone(historical);
  newer.id = 'new-generation';
  newer.directions[0].id = 'new-direction';
  newer.measurements = [{ stage: 'research', startedAt: newer.createdAt, durationMs: 12345, status: 'success', failureCode: null, requests: 99 }];
  project.generations.push(newer);
  project.selectedDirectionId = historical.directions[0].id;
  const before = structuredClone(project);
  for (const output of [renderBriefHtml(project), renderBriefMarkdown(project)]) {
    assert.ok(output.includes('No explicit product fact ledger was recorded'));
    assert.ok(output.includes('Not recorded for this historical direction'));
    assert.match(output, /Provider attempts(?:<\/b>)?[: ]+Not recorded/);
    assert.equal(output.includes('12345'), false);
    assert.equal(output.includes('undefined'), false);
    assert.equal(output.includes('NaN'), false);
  }
  assert.deepEqual(project, before);
});

test('HTML escapes fact provenance and structured pilot values', () => {
  const project = syntheticProject();
  const generation = project.generations[0];
  generation.brief.productFacts = [{ id: 'F1', text: '<script>fact</script>', source: 'user_supplied', sourceUrl: '<script>source</script>' }];
  generation.directions[0].testPlan = buildConceptPilot('A daily blue accent.', generation.brief, ['F1']);
  generation.directions[0].testPlan.contract!.shared.baseEditId = '<script>edit</script>';
  generation.directions[0].testPlan.contract!.arms[0].message = '<script>message</script>';
  const html = renderBriefHtml(project);
  for (const field of ['fact', 'source', 'edit', 'message']) assert.ok(html.includes(`&lt;script&gt;${field}&lt;/script&gt;`));
  assert.equal(html.includes('<script>'), false);
});


test("unverified directions and their content are excluded from both export formats", () => {
  const project = syntheticProject();
  const direction = project.generations[0].directions[0];
  direction.unverifiedClaim = true;
  direction.hook = "UNSUPPORTED PRIVATE CLAIM";
  project.annotations[direction.id] = "UNSUPPORTED PRIVATE ANNOTATION";
  for (const selected of [null, direction.id]) {
    project.selectedDirectionId = selected;
    for (const result of [renderBriefMarkdown(project), renderBriefHtml(project)]) {
      assert.match(result, /Directions with unresolved review findings are excluded/);
      assert.doesNotMatch(result, /UNSUPPORTED PRIVATE|Synthetic direction|Synthetic observed association/);
    }
  }
});


test("directions with quality review warnings are excluded from exports", () => {
  const project = syntheticProject();
  const direction = project.generations[0].directions[0];
  direction.reviewWarnings = ["evidence_gap", "confounded_test"];
  direction.hook = "UNRESOLVED QUALITY COPY";
  for (const result of [renderBriefMarkdown(project), renderBriefHtml(project)]) {
    assert.match(result, /Directions with unresolved review findings are excluded/);
    assert.doesNotMatch(result, /UNRESOLVED QUALITY COPY|Synthetic direction/);
  }
});
