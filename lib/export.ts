import { visualReferences } from "./visual-references";
import { hasReviewWarnings } from "./review-warnings";
import { acceptanceSummary, summarizeMeasurements } from "./measurement";
import { latestGeneration, type Direction, type Evidence, type Generation, type Project } from "./pitchproof-types";

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);
}

function exportGeneration(project: Project): Generation {
  const generation = project.generations.find((item) => item.directions.some((direction) => direction.id === project.selectedDirectionId)) ?? latestGeneration(project);
  if (!generation) throw new Error("Generate campaign directions before exporting a brief.");
  return generation;
}

function exportDirections(project: Project): Direction[] {
  const generation = exportGeneration(project);
  const selected = generation.directions.find((direction) => direction.id === project.selectedDirectionId);
  return (selected ? [selected] : generation.directions).filter(direction => !hasReviewWarnings(direction));
}

function evidenceText(evidence: Evidence): string {
  const score = evidence.score ? ` ${evidence.score.metric}: ${evidence.score.value}. This value is relative to its query, not a purchase probability.` : " No affinity score was returned.";
  const geography = evidence.context.geographyApplied ? `Location filter applied for ${evidence.context.market}.` : `Geographic filtering was not applied to this category. The market is brief context only.`;
  return `${evidence.observation}${score} Rank ${evidence.rank} within this query. References: ${evidence.context.referenceNames.join(", ")}. ${geography} Retrieved ${evidence.collectedAt}.`;
}

function productFacts(generation: Generation): string[] {
  return generation.brief.productFacts?.length
    ? generation.brief.productFacts.map(fact => `${fact.id}: ${fact.text} | Source: ${fact.source}${fact.sourceUrl ? ` | Agency-supplied source URL: ${fact.sourceUrl}` : " | No source URL supplied"}`)
    : ["No explicit product fact ledger was recorded for this historical generation. The description is unverified brief context."];
}

function pilotContract(direction: Direction): [string, string][] {
  const contract = direction.testPlan.contract;
  if (!contract) return [["Structured pilot contract", "Not recorded for this historical direction. Review its available test fields before planning a launch."]];
  const shared = contract.shared;
  return [
    ["Pilot contract version", String(contract.version)],
    ["Shared base edit", shared.baseEditId], ["Shared soundtrack", shared.soundtrackId],
    ["Shared product fact IDs", shared.productFactIds.join(", ")], ["Shared duration", `${shared.durationSeconds} seconds`],
    ["Shared channel", shared.channel], ["Shared audience", shared.audience],
    ["Shared call to action", shared.callToAction], ["Shared landing page", shared.landingPage],
    ...contract.arms.map((arm, index): [string, string] => [`Arm ${index + 1} message`, arm.message]),
  ];
}

function reviewAndMeasurements(project: Project, generation: Generation): [string, string][] {
  const measured = summarizeMeasurements(generation.measurements);
  const review = acceptanceSummary({ ...project, generations: [generation], researchStartedAt: generation === latestGeneration(project) ? project.researchStartedAt : undefined });
  const count = (value: number | null) => value === null ? "Not recorded" : String(value);
  const duration = (value: number | null) => value === null ? "Not recorded for this historical run" : `${value} ms`;
  return [
    ["Operator acceptance", review.accepted ? "Recorded for the selected proposal and current project version. Accepted for further planning only. This does not authorize an ad launch." : "Required. No current operator acceptance is recorded for the exported proposal and project version."],
    ["Run to automated readiness", duration(review.automatedReadyMs)],
    ["Research start to operator review", duration(review.reviewedMs)],
    ["Measurement coverage", generation.measurementsTruncated ? "Only the latest 80 recorded events are retained. Counts, durations and bytes are partial." : "Recorded research, generation and review requests. Missing historical stages are not recorded; research planner calls are excluded."],
    ["Provider attempts", count(measured.requests)], ["Failed provider attempts", count(measured.failedRequests)],
    ["Validation and quality failures", generation.measurements ? String(generation.measurements.filter(event => event.requests === 0 && event.status === "failed").length) : "Not recorded"],
    ["Summed provider request durations", `${duration(measured.durationMs)}. Requests may overlap. This is not wall-clock time.`],
    ["Provider request body bytes", count(measured.inputBytes)], ["Provider response body bytes", count(measured.outputBytes)],
    ...(["research", "generation", "review"] as const).map((stage): [string, string] => [`${stage} provider attempts`, count(summarizeMeasurements(generation.measurements?.filter(item => item.stage === stage)).requests)]),
  ];
}

export function renderBriefMarkdown(project: Project): string {
  const generation = exportGeneration(project);
  const directions = exportDirections(project);
  const brief = generation!.brief;
  const evidence = project.evidence.filter((item) => directions.some((direction) => direction.claims.some((claim) => claim.evidenceIds.includes(item.id))));
  const lines = [
    `# ${brief.product}`, "", "Campaign brief prepared with PitchProof", "",
    `Product: ${brief.product}`, `Category: ${brief.category}`, `Unverified brief context: ${brief.description}`,
    `Market: ${brief.market}`, `Intended audience: ${brief.audience}`, `Objective: ${brief.objective}`,
    `Constraints: ${brief.constraints || "None supplied"}`, ...(brief.website ? [`Product source supplied by the agency: ${brief.website}. The app has not independently retrieved or verified this page.`] : []), "",
    "These campaign directions are hypotheses informed by aggregate cultural affinities. They do not establish actual customer tastes, individual preferences, purchasing intent, or causal campaign performance.", "",
    ...(directions.length < (project.selectedDirectionId ? 1 : generation!.directions.length) ? ["Directions with unresolved review findings are excluded from this export.", ""] : []),
    `Generated ${generation!.createdAt}. Model: ${generation!.model}.`, "",
    "## Explicit product fact ledger", "", ...productFacts(generation).map(fact => `- ${fact}`), "",
    "These facts were supplied by the agency. PitchProof has not independently verified them. Unverified brief context and cultural evidence are not additional product facts.", "",
    "## Operator review and run measurements", "", ...reviewAndMeasurements(project, generation).map(([label, value]) => `${label}: ${value}`), "",
  ];
  for (const direction of directions) {
    const references = visualReferences(direction, project.evidence.filter(item => generation.evidenceIds.includes(item.id)), generation.references ?? []);
    lines.push(`## ${direction.title}`, "", `Hook: ${direction.hook}`, "", `Audience hypothesis: ${direction.audienceHypothesis}`, "", direction.strategy, "",
      `Product fact IDs used: ${direction.productFactIds?.join(", ") || "Not recorded for this historical direction"}`, "",
      ...(direction.campaign ? ["### Campaign proposition", "", direction.campaign.proposition, "", `Audience tension to validate: ${direction.campaign.audienceTension}`, "", `Product role: ${direction.campaign.productRole}`, "", `Campaign mechanism: ${direction.campaign.mechanism}`, "", `Proposed ad execution: ${direction.campaign.execution}`, "", `Call to action: ${direction.campaign.callToAction}`, "", "### Observation to interpretation", "", ...direction.campaign.evidenceBridge.flatMap(bridge => [`Evidence: [${bridge.evidenceId}]`, `Creative interpretation: ${bridge.interpretation}`, `Relevance to this brief: ${bridge.relevance}`, `What remains uncertain: ${bridge.uncertainty}`, ""])] : []),
      "### Proposed visual direction", "", direction.visuals.description, `Palette: ${direction.visuals.palette.join(", ")}`,
      ...direction.visuals.references.map(name => `- ${name}`), ...references.flatMap(reference => [`Source for ${reference.name}: ${reference.url || "No source link supplied"}`, ...(reference.image ? [`![${reference.name.replace(/[\[\]\\]/g, "")}](<${reference.image}>)`] : [])]), "", "Images are inspiration references supplied through Qloo. They do not convey asset-use rights or endorsement.", "", "### Supporting observations", "");
    for (const claim of direction.claims) lines.push(`- ${claim.text} [${claim.evidenceIds.join(", ")}]`);
    lines.push("", "### Proposed test", "", direction.testPlan.hypothesis, ...direction.testPlan.variants.map((variant) => `- ${variant}`),
      ...([ ["Pilot type", direction.testPlan.kind], ["Variable", direction.testPlan.variable], ["Shared controls", direction.testPlan.controls], ["Proposed budget and duration", direction.testPlan.budget], ["Minimum data", direction.testPlan.minimumData] ] as const).flatMap(([label, value]) => value ? [`${label}: ${value}`] : []),
      ...pilotContract(direction).map(([label, value]) => `${label}: ${value}`),
      `Metric: ${direction.testPlan.metric}`, `Proposed success criterion: ${direction.testPlan.successCriterion}`,
      ...(direction.testPlan.inconclusive ? [`If inconclusive: ${direction.testPlan.inconclusive}`] : []),
      "", `Proposed channels: ${direction.channels.join(", ")}`, "", "### Limitations", "", ...direction.limitations.map((limitation) => `- ${limitation}`), "");
    if (project.annotations[direction.id]) lines.push("### Agency annotation", "", project.annotations[direction.id], "");
  }
  lines.push("## Evidence and provenance", "");
  for (const item of evidence) {
    lines.push(`### ${item.entity.name} [${item.id}]`, "", evidenceText(item), `Category: ${item.category}. Endpoint: ${item.context.endpoint}.`,
      `Query parameters: ${JSON.stringify(item.context.parameters)}`, "");
    if (project.annotations[item.id]) lines.push(`Agency annotation: ${project.annotations[item.id]}`, "");
  }
  return lines.join("\n");
}

export function renderBriefHtml(project: Project): string {
  const generation = exportGeneration(project);
  const directions = exportDirections(project);
  const brief = generation!.brief;
  const e = escapeHtml;
  const evidence = project.evidence.filter((item) => directions.some((direction) => direction.claims.some((claim) => claim.evidenceIds.includes(item.id))));
  const annotation = (id: string) => project.annotations[id] ? `<aside class="annotation"><b>Agency annotation</b><p>${e(project.annotations[id])}</p></aside>` : "";
  const board = (direction: Direction) => `<div class="reference-board">${visualReferences(direction, project.evidence.filter(item => generation.evidenceIds.includes(item.id)), generation.references ?? []).map(reference => `<figure>${reference.image ? `<img src="${e(reference.image)}" alt="${e(reference.name)} visual reference supplied through Qloo" referrerpolicy="no-referrer">` : `<p>No image supplied</p>`}<figcaption>${e(reference.name)}${reference.url ? `<br><a href="${e(reference.url)}" rel="noopener noreferrer">Entity source</a>` : ""}</figcaption></figure>`).join("")}</div><p class="reference-rights">Images are inspiration references supplied through Qloo. They do not convey asset-use rights or endorsement.</p>`;
  const list = (items: string[]) => `<ul>${items.map((item) => `<li>${e(item)}</li>`).join("")}</ul>`;
  const campaign = (direction: Direction) => direction.campaign ? `<h3>Campaign proposition</h3><p>${e(direction.campaign.proposition)}</p><h3>Audience tension to validate</h3><p>${e(direction.campaign.audienceTension)}</p><h3>Product role</h3><p>${e(direction.campaign.productRole)}</p><h3>Campaign mechanism</h3><p>${e(direction.campaign.mechanism)}</p><h3>Proposed ad execution</h3><p>${e(direction.campaign.execution)}</p><h3>Call to action</h3><p>${e(direction.campaign.callToAction)}</p><h3>Observation to interpretation</h3>${direction.campaign.evidenceBridge.map(bridge => `<article class="claim"><a href="#e-${e(bridge.evidenceId)}">[${e(bridge.evidenceId)}]</a><p><b>Creative interpretation</b> ${e(bridge.interpretation)}</p><p><b>Relevance to this brief</b> ${e(bridge.relevance)}</p><p><b>What remains uncertain</b> ${e(bridge.uncertainty)}</p></article>`).join("")}` : "";
  const pilotDetails = (direction: Direction) => ([ ["Pilot type", direction.testPlan.kind], ["Variable", direction.testPlan.variable], ["Shared controls", direction.testPlan.controls], ["Proposed budget and duration", direction.testPlan.budget], ["Minimum data", direction.testPlan.minimumData], ["If inconclusive", direction.testPlan.inconclusive] ] as const).map(([label, value]) => value ? `<p><b>${label}</b> ${e(value)}</p>` : "").join("");
  const details = (rows: [string, string][]) => rows.map(([label, value]) => `<p><b>${e(label)}</b> ${e(value)}</p>`).join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${e(brief.product)} | PitchProof</title><style>
  *{box-sizing:border-box}body{font:15px/1.65 Arial,sans-serif;color:#242420;background:#f6f4ef;margin:0}main{max-width:880px;padding:64px;margin:32px auto;background:white}h1,h2{font-family:Georgia,serif;line-height:1.12;font-weight:400}h1{font-size:48px;letter-spacing:-2px;margin:22px 0}h2{font-size:36px;margin:0 0 18px}h3{font-size:12px;letter-spacing:1.3px;text-transform:uppercase;margin-top:30px}p{white-space:pre-wrap}.eyebrow{font-size:11px;letter-spacing:2px;text-transform:uppercase;color:#706f66}.brand{font-weight:800;letter-spacing:-1px;font-size:23px}.brand span{color:#d94432}.hook{font-size:24px;line-height:1.4}.meta{display:grid;grid-template-columns:1fr 1fr;gap:10px 24px;padding:22px 0;border-block:1px solid #ddd9cf}.notice,.annotation{background:#f4f2eb;padding:16px 20px;font-size:13px}.notice{border-left:3px solid #d94432}.direction{padding-top:44px;margin-top:32px;border-top:1px solid #ddd9cf}.palette{display:flex;flex-wrap:wrap;gap:8px}.swatch{padding:12px;border:1px solid #ddd;font-size:11px}.claim a{font-size:12px;color:#a83224}.evidence{border-top:1px solid #ddd9cf;padding-top:20px;margin-top:20px;font-size:13px;overflow-wrap:anywhere}.evidence h3{margin-top:0}.parameters{font:11px/1.5 monospace;color:#67665f;white-space:pre-wrap;overflow-wrap:anywhere}footer{border-top:1px solid #ddd9cf;margin-top:48px;padding-top:18px;color:#706f66;font-size:12px}.reference-board{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;margin-top:16px}.reference-board figure{margin:0;break-inside:avoid;border:1px solid #ddd9cf}.reference-board img{display:block;width:100%;height:140px;object-fit:contain;background:#f4f2eb}.reference-board figcaption{font-size:11px;padding:8px;overflow-wrap:anywhere}.reference-rights{font-size:11px;color:#67665f}.actions{max-width:880px;margin:24px auto;font-size:13px;color:#67665f;padding:0 12px}@media(max-width:650px){main{padding:28px;margin:0}.meta{grid-template-columns:1fr}h1{font-size:36px}}@media print{h1,h2,h3{break-after:avoid-page;page-break-after:avoid}h3{margin-top:22px}body{background:#fff;font-size:14px;line-height:1.5}main{margin:0;padding:0;max-width:none}.actions{display:none}.direction{break-before:auto;padding-top:24px;margin-top:24px}.direction:last-of-type{break-before:page}.notice,.evidence,.claim{break-inside:avoid}a{color:inherit}@page{size:A4;margin:20mm}}
  </style></head><body><div class="actions">Use your browser's Print command to save this brief as a PDF.</div><main><div class="brand">PitchProof<span>.</span></div><p class="eyebrow">Campaign strategy / ${e(brief.category)}</p><h1>${e(brief.product)}</h1><div class="meta"><div><b>Product</b><br>${e(brief.product)}</div><div><b>Market</b><br>${e(brief.market)}</div><div><b>Intended audience</b><br>${e(brief.audience)}</div><div><b>Objective</b><br>${e(brief.objective)}</div></div><h3>Unverified brief context</h3><p>${e(brief.description)}</p><h3>Explicit product fact ledger</h3>${list(productFacts(generation))}<p class="reference-rights">These facts were supplied by the agency. PitchProof has not independently verified them. Unverified brief context and cultural evidence are not additional product facts.</p><h3>Operator review and run measurements</h3>${details(reviewAndMeasurements(project, generation))}${brief.constraints ? `<h3>Constraints</h3><p>${e(brief.constraints)}</p>` : ""}${brief.website ? `<h3>Product source supplied by the agency</h3><p>${e(brief.website)}</p><p class="reference-rights">The app has not independently retrieved or verified this page.</p>` : ""}<p class="notice">These directions are hypotheses informed by aggregate cultural affinities. They do not establish actual customer tastes, individual preferences, purchasing intent, or causal campaign performance.</p>
  ${directions.length < (project.selectedDirectionId ? 1 : generation.directions.length) ? '<p class="notice">Directions with unresolved review findings are excluded from this export.</p>' : ''}
  ${directions.map((direction, index) => `<section class="direction"><p class="eyebrow">Creative direction ${String(index + 1).padStart(2, "0")}</p><h2>${e(direction.title)}</h2><p class="hook">${e(direction.hook)}</p><h3>Audience hypothesis</h3><p>${e(direction.audienceHypothesis)}</p><h3>Creative hypothesis</h3><p>${e(direction.strategy)}</p><p><b>Product fact IDs used</b> ${e(direction.productFactIds?.join(", ") || "Not recorded for this historical direction")}</p>${campaign(direction)}<h3>Proposed visual direction</h3><p>${e(direction.visuals.description)}</p><div class="palette">${direction.visuals.palette.map((color) => `<div class="swatch">${e(color)}</div>`).join("")}</div>${list(direction.visuals.references)}${board(direction)}<h3>Evidence behind the direction</h3>${direction.claims.map((claim) => `<p class="claim">${e(claim.text)} ${claim.evidenceIds.map((id) => `<a href="#e-${e(id)}">[${e(id)}]</a>`).join(" ")}</p>`).join("")}<h3>Proposed test</h3><p>${e(direction.testPlan.hypothesis)}</p>${list(direction.testPlan.variants)}${pilotDetails(direction)}${details(pilotContract(direction))}<p><b>Metric</b> ${e(direction.testPlan.metric)}<br><b>Proposed success criterion</b> ${e(direction.testPlan.successCriterion)}</p><h3>Proposed channels</h3>${list(direction.channels)}<h3>Limitations</h3>${list(direction.limitations)}${annotation(direction.id)}</section>`).join("")}
  <section class="direction"><h2>Evidence and provenance</h2><p>Scores retain the provider's metric and query context. Compare rank within the same query. Reference brands can represent competitors, aesthetic references, or unverified audience proxies.</p>${evidence.map((item) => `<article class="evidence" id="e-${e(item.id)}"><h3>${e(item.entity.name)} / ${e(item.category)}</h3><p>${e(evidenceText(item))}</p><p class="parameters">${e(item.id)}<br>${e(item.context.endpoint)}<br>${e(JSON.stringify(item.context.parameters))}</p>${annotation(item.id)}</article>`).join("")}</section><footer>Prepared with PitchProof. Generated ${e(generation!.createdAt)} using ${e(generation!.model)}. Source observations remain separate from agency interpretation.</footer></main></body></html>`;
}
