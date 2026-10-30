"use client";

import { useState } from "react";
import type { Direction, Evidence, Generation, Project } from "@/lib/pitchproof-types";
import { comparisonDirection, evidenceChanges, referenceChanges, versionEvidence } from "@/lib/comparison";
import { hasReviewWarnings, reviewWarningText } from "@/lib/review-warnings";
import type { Baseline } from "@/server/providers/baseline";

type Result = { baseline: Baseline; model: string };

export function DirectionSummary({ direction }: { direction: Direction | undefined }) {
  if (!direction) return <p>Not recorded</p>;
  return <div><p>{direction.title}: {direction.campaign?.proposition ?? direction.strategy}</p>{hasReviewWarnings(direction) && <p className="inline-error" role="status">Review needed: {reviewWarningText(direction)}. This direction is excluded from exports.</p>}</div>;
}

export function Comparison({ project, generation, evidence, onEdit }: { project: Project; generation: Generation; evidence: Evidence[]; onEdit: () => void }) {
  const [result, setResult] = useState<Result | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [otherId, setOtherId] = useState("");
  const other = project.generations.find(item => item.id === otherId);
  const currentDirection = comparisonDirection(project, generation);
  const grounded = currentDirection.direction;
  const otherDirection = other ? comparisonDirection(project, other) : null;
  const currentEvidence = versionEvidence(generation, project.evidence);
  const otherEvidence = other ? versionEvidence(other, project.evidence) : null;
  const referencesDiff = other && generation.references && other.references ? referenceChanges(generation.references, other.references) : null;
  const evidenceDiff = otherEvidence && !currentEvidence.missing && !otherEvidence.missing ? evidenceChanges(currentEvidence.records, otherEvidence.records) : null;
  async function generate() {
    setBusy(true); setError(""); setResult(null);
    try {
      const response = await fetch(`/api/projects/${encodeURIComponent(project.id)}/baseline`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ generationId: generation.id }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data && typeof data === "object" && "error" in data && typeof data.error === "string" ? data.error : "Could not generate the baseline.");
      setResult(data as Result);
    } catch (failure) { setError(failure instanceof Error ? failure.message : "Could not generate the baseline."); }
    finally { setBusy(false); }
  }
  if (!grounded) return null;
  const rows = result ? [
    ["Title", result.baseline.title, grounded.title],
    ["Hook", result.baseline.hook, grounded.hook],
    ["Audience hypothesis", result.baseline.audienceHypothesis, grounded.audienceHypothesis],
    ["Proposition", result.baseline.proposition, grounded.campaign?.proposition ?? grounded.strategy],
    ["Mechanism", result.baseline.mechanism, grounded.campaign?.mechanism ?? "Not recorded"],
  ] : [];
  return <section className="comparison-panel" aria-label="Compare campaign approaches">
    <h2>Compare the approaches</h2>
    <p>Generate an LLM-only proposal from the brief for this version and entered references. Compare it with the Qloo-grounded direction shown below. The outputs are separate creative hypotheses, not a controlled measurement of the impact of Qloo.</p>
    <p className="field-hint">{currentDirection.label}</p>
    <button className="button button-outline" disabled={busy} onClick={() => void generate()}>{busy ? "Generating baseline…" : result ? "Generate another baseline" : "Generate LLM-only baseline"}</button>
    <p className="field-hint">This sends the saved brief and reference names to the configured model and uses one provider request from your allowance. It does not send Qloo observations. The baseline is not saved.</p>
    {error && <p className="notice notice-error" role="alert">{error}</p>}
    {result && <div className="comparison-results">{hasReviewWarnings(grounded) && <p className="inline-error" role="status">Review needed: {reviewWarningText(grounded)}. This direction is excluded from exports.</p>}<div className="comparison-head"><strong>LLM-only · {result.model}</strong><strong>Qloo-grounded · {generation.model}</strong></div>{rows.map(([label, baseline, qloo]) => <div className="comparison-row" key={label}><h3>{label}</h3><p>{baseline}</p><p>{qloo}</p></div>)}<div className="comparison-row"><h3>Evidence</h3><p>No Qloo observations supplied. Review all claims before use.</p><div>{grounded.claims.map((claim, index) => <p key={index}>{claim.text} {claim.evidenceIds.map(id => { const item = evidence.find(record => record.id === id); return item ? <span key={id}>[{item.entity.name}, {item.category}] </span> : <span key={id}>[Source unavailable] </span>; })}</p>)}</div></div><div className="comparison-row"><h3>Limitations</h3><p>{result.baseline.limitations.join(" ")}</p><p>{grounded.limitations.join(" ")}</p></div></div>}
    <div className="comparison-swap"><h3>Compare reference sets</h3><p>To swap a reference, edit the brief, confirm the new match, and run research again. Previous versions remain in history.</p><button className="text-button" onClick={onEdit}>Edit references</button>{project.generations.length > 1 && <><label>Compare this version with <select value={otherId} onChange={event => setOtherId(event.target.value)}><option value="">Choose a version</option>{project.generations.filter(item => item.id !== generation.id).map(item => <option value={item.id} key={item.id}>Version {project.generations.indexOf(item) + 1}</option>)}</select></label>{other && <div className="comparison-results"><div className="comparison-head"><strong>Selected version</strong><strong>Other version</strong></div><div className="comparison-row"><h3>References</h3><p>{(generation.references ?? []).map(ref => `${ref.entity?.name ?? ref.query} (${ref.role})`).join(", ") || "Not recorded"}</p><p>{(other.references ?? []).map(ref => `${ref.entity?.name ?? ref.query} (${ref.role})`).join(", ") || "Not recorded"}</p></div><div className="comparison-row"><h3>Direction</h3><div><p>{currentDirection.label}</p><DirectionSummary direction={grounded} /></div><div><p>{otherDirection?.label}</p><DirectionSummary direction={otherDirection?.direction} /></div></div><div className="comparison-row"><h3>Research evidence</h3><EvidenceList records={currentEvidence.records} missing={currentEvidence.missing} /><EvidenceList records={otherEvidence!.records} missing={otherEvidence!.missing} /></div><div className="comparison-row"><h3>Reference changes</h3>{referencesDiff ? <><div><strong>Only in selected version</strong><ReferenceList records={referencesDiff.leftOnly} /></div><div><strong>Only in other version</strong><ReferenceList records={referencesDiff.rightOnly} /></div></> : <p>Reference history is unavailable for at least one version.</p>}</div><div className="comparison-row"><h3>Evidence differences</h3>{evidenceDiff ? <><div><strong>Only in selected version</strong><EvidenceList records={evidenceDiff.leftOnly} missing={0} empty="No signals unique to this version." /></div><div><strong>Only in other version</strong><EvidenceList records={evidenceDiff.rightOnly} missing={0} empty="No signals unique to this version." /></div></> : <p>Some evidence records are unavailable, so differences cannot be calculated.</p>}</div><p className="field-hint">Differences show records unique to each column, matched by entity and category. Scores, observations and context may also differ for shared records. Other inputs, feedback, model behavior, and time may also differ. This comparison does not isolate the effect of a reference swap.</p></div>}</>}</div>
  </section>;
}


function ReferenceList({ records }: { records: NonNullable<Generation["references"]> }) {
  return <div>{records.length ? records.map((ref, index) => <p key={index}>{ref.entity?.name ?? ref.query} ({ref.role})</p>) : <p>No references unique to this version.</p>}</div>;
}

function EvidenceList({ records, missing, empty = "No evidence recorded." }: { records: Evidence[]; missing: number; empty?: string }) {
  return <div>{records.length ? records.map(record => <p key={record.id}><strong>{record.entity.name} · {record.category}</strong><br />{record.observation}</p>) : <p>{empty}</p>}{missing > 0 && <p>{missing} evidence {missing === 1 ? "record is" : "records are"} unavailable.</p>}</div>;
}
