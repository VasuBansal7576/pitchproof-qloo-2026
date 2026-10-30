"use client";

import { hasReviewWarnings, reviewWarningText } from "@/lib/review-warnings";

import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { ArrowDownToLine, ArrowLeft, ArrowRight, ArrowUpRight, BookOpen, Check, CheckCircle2, ChevronDown, ChevronRight, Circle, Clock3, ExternalLink, FileText, FlaskConical, FolderOpen, Layers3, LoaderCircle, Menu, MessageSquare, Plus, Search, Settings2, ShieldCheck, Sparkles, SquareArrowOutUpRight, X } from "lucide-react";
import { CATEGORIES, TEXT_LIMITS, EMPTY_BRIEF, latestGeneration, projectSummary, mergeProjectSummaries, type Brief, type Candidate, type Command, type Configuration, type Direction, type Evidence, type Project, type ProjectSummary, type Reference, type ReferenceRole } from "@/lib/pitchproof-types";

import { Comparison } from "@/components/pitchproof/comparison";
import { ReferenceBoard } from "@/components/pitchproof/reference-board";
import { visualReferences } from "@/lib/visual-references";
import { acceptanceSummary, summarizeMeasurements } from "@/lib/measurement";

type ReferenceInput = { query: string; role: ReferenceRole };
type Draft = { brief: Brief; references: ReferenceInput[]; factText?: string };
type Screen = "new" | "projects" | "project" | "edit";
type Feedback = { kind: "revise" | "reject"; direction: Direction };
const NEW_REFERENCES: ReferenceInput[] = [{ query: "", role: "competitor" }, { query: "", role: "aesthetic" }, { query: "", role: "audience" }];
const CATEGORY_OPTIONS = ["Running footwear", "Fashion & apparel", "Beauty & personal care", "Food & beverage", "Travel & hospitality", "Home & interiors", "Health & wellness", "Technology & lifestyle", "Arts & entertainment", "Other"];
const STATUS_LABEL: Record<Project["status"], string> = { draft: "Draft", researching: "In research", ready: "Directions ready", error: "Needs attention" };
const ROLE_LABEL: Record<ReferenceRole, string> = { competitor: "Competitor", aesthetic: "Aesthetic reference", audience: "Audience affinity" };

class RequestFailure extends Error {
  constructor(message: string, readonly status: number, readonly code: string) { super(message); }
}
async function request<T>(url: string, body?: unknown): Promise<T> {
  const response = await fetch(url, body === undefined ? { cache: "no-store" } : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const value = await response.json().catch(() => null);
  if (!response.ok) {
    const failure = value as { error?: unknown; code?: unknown } | null;
    throw new RequestFailure(typeof failure?.error === "string" ? failure.error : "The request could not be completed. Please try again.", response.status, typeof failure?.code === "string" ? failure.code : "REQUEST_FAILED");
  }
  return value as T;
}
function dateLabel(value: string) { return new Date(value).toLocaleDateString(undefined, { month: "short", day: "numeric" }); }
function dateTimeLabel(value: string) { return new Date(value).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }); }
function errorMessage(error: unknown) { return error instanceof Error ? error.message : "Something went wrong. Please try again."; }
function IconLabel({ children }: { children: ReactNode }) { return <span className="eyebrow">{children}</span>; }

function Dialog({ title, children, onClose, wide = false }: { title: string; children: ReactNode; onClose: () => void; wide?: boolean }) {
  const dialogRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    dialogRef.current?.focus();
    function keydown(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
      if (event.key !== "Tab") return;
      const elements = dialogRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], input, textarea, select, [tabindex="0"]');
      if (!elements?.length) return;
      const first = elements[0], last = elements[elements.length - 1];
      if (event.shiftKey && (document.activeElement === first || document.activeElement === dialogRef.current)) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }
    document.addEventListener("keydown", keydown);
    return () => { document.removeEventListener("keydown", keydown); document.body.style.overflow = previousOverflow; previous?.focus(); };
  }, [onClose]);
  return <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}><div className={`modal ${wide ? "modal-wide" : ""}`} role="dialog" aria-modal="true" aria-label={title} ref={dialogRef} tabIndex={-1}><div className="modal-heading"><h2>{title}</h2><button className="icon-button" aria-label="Close dialog" onClick={onClose}><X size={20} /></button></div>{children}</div></div>;
}

export default function PitchProof() {
  const [screen, setScreen] = useState<Screen>("new");
  const [project, setProject] = useState<Project | null>(null);
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [config, setConfig] = useState<Configuration | null>(null);
  const [configError, setConfigError] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [settings, setSettings] = useState(false);
  const [mobileNav, setMobileNav] = useState(false);
  const [newDraft, setNewDraft] = useState<Draft>({ brief: { ...EMPTY_BRIEF }, references: NEW_REFERENCES.map(ref => ({ ...ref })) });
  const [editDraft, setEditDraft] = useState<Draft | null>(null);
  const draft = screen === "edit" && editDraft ? editDraft : newDraft;
  const setDraft = screen === "edit" ? setEditDraft : setNewDraft;
  const [candidates, setCandidates] = useState<Record<number, Candidate[]>>({});
  const [searchingSlot, setSearchingSlot] = useState<number | null>(null);
  const [generationId, setGenerationId] = useState<string | null>(null);
  const [evidenceOpen, setEvidenceOpen] = useState<Evidence | "all" | null>(null);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [autoPaused, setAutoPaused] = useState(false);
  const [cancelRequested, setCancelRequested] = useState(false);
  const [listQuery, setListQuery] = useState("");
  const [listFilter, setListFilter] = useState("all");
  const commandLock = useRef<symbol | null>(null);
  const viewRequest = useRef(0);
  const searchRequest = useRef<symbol | null>(null);
  const activeProjectId = useRef<string | null>(null);
  const [draftLoaded, setDraftLoaded] = useState(false);

  const refreshList = useCallback(async () => {
    const data = await request<{ projects: ProjectSummary[] }>("/api/projects");
    setProjects(previous => mergeProjectSummaries(previous, data.projects));
  }, []);
  const loadConfiguration = useCallback(async () => {
    setConfigError("");
    try { setConfig(await request<Configuration>("/api/config")); }
    catch (failure) { setConfigError(errorMessage(failure)); }
  }, []);
  const openProject = useCallback(async (id: string, pushHistory = true) => {
    const requestId = ++viewRequest.current;
    commandLock.current = null; searchRequest.current = null;
    setProject(null); setLoading(true); setBusy(false); setError(""); setNotice(""); setCandidates({}); setSearchingSlot(null); setGenerationId(null); setAutoPaused(false); setCancelRequested(false); setEvidenceOpen(null); setFeedback(null); setEditDraft(null);
    activeProjectId.current = id;
    setScreen("project"); setMobileNav(false);
    if (pushHistory) window.history.pushState({}, "", `?project=${encodeURIComponent(id)}`);
    try { const data = await request<{ project: Project }>(`/api/projects/${encodeURIComponent(id)}`); if (viewRequest.current === requestId) setProject(data.project); }
    catch (failure) { if (viewRequest.current === requestId) setError(errorMessage(failure)); }
    finally { if (viewRequest.current === requestId) setLoading(false); }
  }, []);

  useEffect(() => {
    try { const saved = localStorage.getItem("pitchproof.draft"); if (saved) { const value = JSON.parse(saved); if (value?.brief && Array.isArray(value.references) && value.references.length === 3) setNewDraft(value); } } catch { /* Browser storage can be unavailable. */ }
    setDraftLoaded(true);
    const id = new URLSearchParams(window.location.search).get("project");
    const initialRequests = [loadConfiguration(), refreshList(), ...(id ? [openProject(id, false)] : [])];
    const requestId = viewRequest.current;
    void Promise.allSettled(initialRequests).then(results => {
      if (viewRequest.current !== requestId) return;
      const failed = results.find(result => result.status === "rejected");
      if (failed?.status === "rejected") setError(errorMessage(failed.reason));
      if (!id) setLoading(false);
    });
    function popState() {
      const nextId = new URLSearchParams(window.location.search).get("project");
      if (nextId) void openProject(nextId, false);
      else {
        ++viewRequest.current; commandLock.current = null; searchRequest.current = null; activeProjectId.current = null;
        setProject(null); setScreen("new"); setLoading(false); setBusy(false); setError(""); setNotice(""); setCandidates({}); setSearchingSlot(null); setGenerationId(null); setAutoPaused(false); setCancelRequested(false); setEvidenceOpen(null); setFeedback(null); setEditDraft(null);
      }
    }
    window.addEventListener("popstate", popState);
    const reconcileList = () => { void refreshList().catch(() => {}); };
    window.addEventListener("focus", reconcileList);
    return () => { window.removeEventListener("popstate", popState); window.removeEventListener("focus", reconcileList); };
  }, [loadConfiguration, openProject, refreshList]);
  useEffect(() => { if (draftLoaded) { try { localStorage.setItem("pitchproof.draft", JSON.stringify(newDraft)); } catch {  } } }, [newDraft, draftLoaded]);

  const command = useCallback(async (action: Command, current: Project = project!) => {
    if (!current || activeProjectId.current !== current.id || commandLock.current) return null;
    const requestId = viewRequest.current;
    const commandId = Symbol();
    commandLock.current = commandId; setBusy(true); setError("");
    try {
      const result = await request<{ project: Project }>(`/api/projects/${encodeURIComponent(current.id)}/commands`, { ...action, expectedVersion: current.version, commandId: crypto.randomUUID() });
      setProjects(previous => mergeProjectSummaries(previous, [projectSummary(result.project)]));
      if (viewRequest.current !== requestId) return null;
      setProject(result.project);
      if (action.action === "revise" || action.action === "start_research" || action.action === "retry") { setAutoPaused(false); setGenerationId(null); }
      if (action.action === "confirm_reference") setCandidates(previous => { const next = { ...previous }; delete next[action.slot]; return next; });
      return result.project;
    } catch (failure) {
      if (viewRequest.current !== requestId) return null;
      setAutoPaused(true);
      if (failure instanceof RequestFailure && failure.code === "OPERATION_BUSY") {
        try {
          const latest = await request<{ project: Project }>(`/api/projects/${encodeURIComponent(current.id)}`);
          if (viewRequest.current !== requestId) return null;
          setProject(latest.project);
          setAutoPaused(false);
          setNotice("This research step is being processed. We’ll resume from the saved result when its server lease completes.");
        } catch (reloadFailure) { if (viewRequest.current === requestId) setError(errorMessage(reloadFailure)); }
      } else if (failure instanceof RequestFailure && failure.status === 409) {
        try {
          const latest = await request<{ project: Project }>(`/api/projects/${encodeURIComponent(current.id)}`);
          if (viewRequest.current !== requestId) return null;
          setProject(latest.project); setError("This project changed in another session. The latest version is now loaded. Review it and try your action again.");
        } catch (reloadFailure) { if (viewRequest.current === requestId) setError(`The project changed in another session. ${errorMessage(reloadFailure)}`); }
      } else {
        if (failure instanceof RequestFailure && failure.code === "EXPIRED_CANDIDATE" && action.action === "confirm_reference") {
          setCandidates(previous => { const next = { ...previous }; delete next[action.slot]; return next; });
          setError("This brand match has expired. Search this reference again, then confirm the exact brand you want.");
        } else setError(errorMessage(failure));
      }
      return null;
    } finally { if (commandLock.current === commandId) { commandLock.current = null; setBusy(false); } }
  }, [project]);

  useEffect(() => {
    if (!cancelRequested || busy || screen !== "project") return;
    if (!project?.operation) { setCancelRequested(false); return; }
    const requestId = viewRequest.current;
    void command({ action: "cancel" }, project).finally(() => { if (viewRequest.current === requestId) setCancelRequested(false); });
  }, [cancelRequested, busy, project, screen, command]);

  useEffect(() => {
    if (screen !== "project" || !project?.operation || project.operation.state === "failed" || busy || autoPaused || cancelRequested) return;
    if (project.operation.leaseToken && project.operation.leaseUntil > Date.now()) {
      const requestId = viewRequest.current;
      let disposed = false;
      const timer = window.setTimeout(async () => {
        try {
          const latest = await request<{ project: Project }>(`/api/projects/${encodeURIComponent(project.id)}`);
          if (!disposed && viewRequest.current === requestId) {
            setProject(latest.project);
            setProjects(previous => mergeProjectSummaries(previous, [projectSummary(latest.project)]));
          }
        } catch (failure) {
          if (!disposed && viewRequest.current === requestId) { setAutoPaused(true); setError(errorMessage(failure)); }
        }
      }, Math.min(1500, project.operation.leaseUntil - Date.now() + 50));
      return () => { disposed = true; window.clearTimeout(timer); };
    }
    void command({ action: "advance" }, project);
  }, [project, busy, autoPaused, cancelRequested, command, screen]);

  function navigate(next: Screen) {
    ++viewRequest.current; commandLock.current = null; searchRequest.current = null;
    setScreen(next); setMobileNav(false); setLoading(false); setBusy(false); setError(""); setNotice(""); setCandidates({}); setSearchingSlot(null); setGenerationId(null); setAutoPaused(false); setCancelRequested(false); setEvidenceOpen(null); setFeedback(null); setEditDraft(null);
    if (next === "new" || next === "projects") { activeProjectId.current = null; setProject(null); window.history.pushState({}, "", window.location.pathname); }
    if (next === "projects") void refreshList().catch(() => {});
  }
  function editBrief() {
    if (!project) return;
    ++viewRequest.current; searchRequest.current = null;
    setEditDraft({ brief: { ...project.brief }, references: project.references.map(({ query, role }) => ({ query, role })) });
    setScreen("edit"); setError(""); setNotice(""); setCandidates({}); setSearchingSlot(null); setEvidenceOpen(null); setFeedback(null);
  }
  async function saveBrief(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (busy) return;
    if (screen === "edit" && project) {
      const updated = await command({ action: "update_brief", brief: draft.brief, references: draft.references });
      if (updated) { setCandidates({}); setEditDraft(null); setScreen("project"); setNotice("Brief saved. Confirm your references before starting research."); }
      return;
    }
    const requestId = viewRequest.current;
    const commandId = Symbol();
    commandLock.current = commandId; setBusy(true); setError("");
    try {
      const data = await request<{ project: Project }>("/api/projects", { brief: newDraft.brief, references: newDraft.references });
      void refreshList().catch(() => {});
      if (viewRequest.current !== requestId) return;
      activeProjectId.current = data.project.id; setProject(data.project); setCandidates({}); setScreen("project"); setAutoPaused(false); setGenerationId(null);
      window.history.pushState({}, "", `?project=${encodeURIComponent(data.project.id)}`);
      try { localStorage.removeItem("pitchproof.draft"); } catch {  }
      setNewDraft({ brief: { ...EMPTY_BRIEF }, references: NEW_REFERENCES.map(ref => ({ ...ref })) });
    } catch (failure) { if (viewRequest.current === requestId) setError(errorMessage(failure)); }
    finally { if (commandLock.current === commandId) { commandLock.current = null; setBusy(false); } }
  }
  async function searchReference(slot: number) {
    if (!project || searchRequest.current || busy) return;
    const requestId = viewRequest.current;
    const searchId = Symbol();
    searchRequest.current = searchId; setSearchingSlot(slot); setError("");
    try {
      const result = await request<{ candidates: Candidate[] }>(`/api/projects/${encodeURIComponent(project.id)}/search`, { slot, query: project.references[slot].query });
      if (viewRequest.current === requestId && searchRequest.current === searchId) setCandidates(previous => ({ ...previous, [slot]: result.candidates }));
    } catch (failure) { if (viewRequest.current === requestId && searchRequest.current === searchId) setError(errorMessage(failure)); }
    finally { if (searchRequest.current === searchId) { searchRequest.current = null; setSearchingSlot(null); } }
  }
  function useSample() {
    setDraft({ brief: { product: "Stride 01", description: "Hypothetical example. Stride 01 is an everyday running shoe from an independent footwear brand. A dark mesh upper and a simple silhouette are the only supplied product details. No performance, comfort, material-composition or sustainability claims are verified.", category: "Running footwear", market: "United Kingdom", audience: "Urban runners aged 25–35 who run for headspace, community and everyday progress.", objective: "Launch a new product", constraints: "A small production budget. Social-first creative. Avoid elite-performance claims and sustainability claims we cannot substantiate.", website: "", callToAction: "Explore Stride 01", productFacts: [{ id: "F1", text: "A dark mesh upper.", source: "user_supplied", sourceUrl: null }, { id: "F2", text: "A simple silhouette.", source: "user_supplied", sourceUrl: null }] }, references: [{ query: "Nike", role: "competitor" }, { query: "On", role: "aesthetic" }, { query: "Patagonia", role: "audience" }] });
    setNotice("Sample input added. All research will use live sources when you start.");
  }

  const currentGeneration = project ? latestGeneration(project) : null;
  const displayedGeneration = project?.generations.find(generation => generation.id === generationId) || currentGeneration;
  const historical = !!displayedGeneration && displayedGeneration.id !== currentGeneration?.id;
  const refsConfirmed = project?.references.length === 3 && project.references.every(reference => reference.entity);
  const onCloseSettings = useCallback(() => setSettings(false), []);
  const onCloseEvidence = useCallback(() => setEvidenceOpen(null), []);
  const onCloseFeedback = useCallback(() => setFeedback(null), []);
  const displayedEvidence = displayedGeneration && project ? project.evidence.filter(item => displayedGeneration.evidenceIds.includes(item.id)) : project?.evidence || [];

  return <div className="app-shell">
    {mobileNav && <button className="mobile-scrim" aria-label="Close navigation" onClick={() => setMobileNav(false)} />}
    <aside className={`sidebar ${mobileNav ? "sidebar-open" : ""}`} aria-label="Main navigation">
      <button className="brand" onClick={() => navigate("new")} aria-label="PitchProof home"><span className="brand-mark">p<span>.</span></span><span>PitchProof<span className="brand-period">.</span></span></button>
      <div className="studio-label"><span className="studio-avatar">S</span><span>Your creative studio<small>Independent by design</small></span></div>
      <button className="button button-accent sidebar-new" onClick={() => navigate("new")}><Plus size={17} /> New campaign</button>
      <nav className="primary-nav"><button className={screen === "projects" ? "nav-item active" : "nav-item"} onClick={() => navigate("projects")}><FolderOpen size={18} /> All campaigns<span>{projects.length.toString().padStart(2, "0")}</span></button><button className={screen === "new" || screen === "edit" ? "nav-item active" : "nav-item"} onClick={() => navigate("new")}><FileText size={18} /> Brief builder</button></nav>
      <div className="sidebar-projects"><div className="sidebar-section-label">RECENT CAMPAIGNS</div>{projects.length ? projects.slice(0, 6).map(item => <button key={item.id} className={`recent-project ${project?.id === item.id ? "current" : ""}`} onClick={() => void openProject(item.id)}><span className={`status-dot ${item.status}`} /><span>{item.title}<small>{item.category}</small></span><ChevronRight size={14} /></button>) : <div className="recent-empty">Your next good idea<br />starts with a brief.</div>}</div>
      <div className="sidebar-bottom"><div className="sidebar-note"><span className="little-star">✳</span><p>Good ideas have<br />something behind them.</p><span className="note-rule" /></div><button className="nav-item settings-nav" onClick={() => setSettings(true)}><Settings2 size={17} /> Workspace settings<span className={`connection-dot ${config?.qlooConfigured && config?.modelConfigured ? "connected" : ""}`} /></button><div className="sidebar-foot"><span>PITCHPROOF STUDIO</span><span>V.01</span></div></div>
    </aside>
    <div className="main-shell">
      <header className="topbar"><div className="breadcrumb"><button className="icon-button mobile-menu" aria-label="Open navigation" onClick={() => setMobileNav(true)}><Menu size={21} /></button><span className="breadcrumb-root">Workspace</span><ChevronRight size={13} /><span>{screen === "projects" ? "All campaigns" : screen === "new" ? "New campaign" : screen === "edit" ? "Edit brief" : project?.title || "Campaign"}</span></div><button className="topbar-settings" onClick={() => setSettings(true)}><span className={`connection-dot ${config?.qlooConfigured && config?.modelConfigured ? "connected" : ""}`} />{config?.qlooConfigured && config?.modelConfigured ? "Workspace connected" : "Provider setup"}<ArrowUpRight size={14} /></button></header>
      <main className="main-content" id="main-content">
        {(error || notice) && <div className={`notice ${error ? "notice-error" : "notice-success"}`} role={error ? "alert" : "status"}><span>{error || notice}</span><button className="icon-button" aria-label="Dismiss message" onClick={() => { setError(""); setNotice(""); }}><X size={16} /></button></div>}
        {loading ? <div className="loading-view" role="status"><LoaderCircle className="spin" size={25} /><p>Opening your workspace…</p></div> : screen === "new" || screen === "edit" ? <>
          <div className="page-heading brief-heading"><div><IconLabel><span className="red-line" /> THE START OF SOMETHING GOOD</IconLabel><h1>Big ideas.<br /><em>Solid ground.</em></h1><p className="page-description">Turn a little context into a campaign worth pitching.<br className="desktop-break" /> Start with your product. We’ll connect the cultural dots.</p></div><div className="heading-stamp" aria-hidden="true"><span>CREATIVE INSTINCT</span><span className="stamp-cross">+</span><span>CULTURAL EVIDENCE</span><div className="stamp-bottom">A BETTER PLACE TO START ↗</div></div></div>
          <WorkflowSteps active={0} />
          <div className="brief-layout"><form className="brief-form" onSubmit={saveBrief}>
            <div className="section-heading"><div className="section-number">01</div><div><h2>The campaign brief</h2><p>Give your research a direction.</p></div><span className="required-note">* Required</span></div>
            <div className="form-body"><div className="field-row"><Field label="Product or brand name" required><input required maxLength={TEXT_LIMITS.product} placeholder="e.g. Stride 01 running shoe" value={draft.brief.product} onChange={event => setDraft({ ...draft, brief: { ...draft.brief, product: event.target.value } })} /></Field><Field label="Category" required><div className="select-wrap"><select value={draft.brief.category} onChange={event => setDraft({ ...draft, brief: { ...draft.brief, category: event.target.value } })}>{CATEGORY_OPTIONS.map(category => <option key={category}>{category}</option>)}</select><ChevronDown size={15} /></div></Field></div>
            <Field label="What makes it worth talking about?" required hint="The product, its point of view, and what sets it apart."><textarea required rows={3} maxLength={TEXT_LIMITS.description} placeholder="Tell us what you’re launching and why it matters…" value={draft.brief.description} onChange={event => setDraft({ ...draft, brief: { ...draft.brief, description: event.target.value } })} /></Field>
            <div className="field-row"><Field label="Target market" required><input required maxLength={TEXT_LIMITS.market} placeholder="e.g. United Kingdom" value={draft.brief.market} onChange={event => setDraft({ ...draft, brief: { ...draft.brief, market: event.target.value } })} /></Field><Field label="Campaign objective" required><div className="select-wrap"><select value={draft.brief.objective} onChange={event => setDraft({ ...draft, brief: { ...draft.brief, objective: event.target.value } })}>{["Launch a new product", "Build brand awareness", "Reach a new audience", "Drive consideration", "Grow a community", "Reposition a brand"].map(objective => <option key={objective}>{objective}</option>)}</select><ChevronDown size={15} /></div></Field></div>
            <Field label="Who are we trying to move?" required hint="Go beyond demographics. What do they care about?"><textarea required rows={2} maxLength={TEXT_LIMITS.audience} placeholder="e.g. City runners who care more about headspace than personal bests" value={draft.brief.audience} onChange={event => setDraft({ ...draft, brief: { ...draft.brief, audience: event.target.value } })} /></Field>
            <Field label="Supplied product facts" required hint="One positive fact per line. Up to eight facts, 300 characters each. These are supplied by you, not independently verified."><textarea required rows={3} maxLength={2408} placeholder={"A dark mesh upper.\nA simple silhouette."} value={draft.factText ?? draft.brief.productFacts?.map(fact => fact.text).join("\n") ?? ""} onChange={event => setDraft({ ...draft, factText: event.target.value, brief: { ...draft.brief, productFacts: event.target.value.split("\n").map(text => text.trim()).filter(Boolean).map((text, index) => ({ id: `F${index + 1}`, text, source: "user_supplied" as const, sourceUrl: draft.brief.website || null })) } })} /></Field>
            <Field label="Shared call to action" hint="The same CTA is used in both pilot arms. Leave blank to use an Explore invitation."><input maxLength={180} placeholder={`Explore ${draft.brief.product || "your product"}`} value={draft.brief.callToAction ?? ""} onChange={event => setDraft({ ...draft, brief: { ...draft.brief, callToAction: event.target.value } })} /></Field>
            <div className="field-row"><Field label="Website" hint="Optional. Kept as brief context, not scraped."><input type="url" maxLength={TEXT_LIMITS.website} placeholder="https://yourbrand.com" value={draft.brief.website} onChange={event => setDraft({ ...draft, brief: { ...draft.brief, website: event.target.value } })} /></Field><Field label="Constraints & guardrails" hint="Optional. Budget, channels, things to avoid."><input maxLength={TEXT_LIMITS.constraints} placeholder="Anything we should know?" value={draft.brief.constraints} onChange={event => setDraft({ ...draft, brief: { ...draft.brief, constraints: event.target.value } })} /></Field></div>
            </div>
            <div className="section-heading reference-section-heading"><div className="section-number">02</div><div><h2>A little cultural context</h2><p>Three real brands to orient the research.</p></div></div>
            <div className="form-body reference-fields">{draft.references.map((reference, index) => <div className="reference-input-row" key={index}><span className="reference-index">{String(index + 1).padStart(2, "0")}</span><Field label={`Reference brand ${index + 1}`} required><input required maxLength={TEXT_LIMITS.reference} placeholder={["A brand in your competitive world", "A brand whose creative you admire", "A brand your audience connects with"][index]} value={reference.query} onChange={event => setDraft({ ...draft, references: draft.references.map((item, slot) => slot === index ? { ...item, query: event.target.value } : item) })} /></Field><Field label="Its role"><div className="select-wrap"><select aria-label={`Role for reference brand ${index + 1}`} value={reference.role} onChange={event => setDraft({ ...draft, references: draft.references.map((item, slot) => slot === index ? { ...item, role: event.target.value as ReferenceRole } : item) })}>{Object.entries(ROLE_LABEL).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select><ChevronDown size={15} /></div></Field></div>)}<p className="field-explainer"><ShieldCheck size={15} /> You’ll confirm each brand match before any research starts.</p></div>
            <div className="form-footer"><span>Your brief stays in your workspace.</span><button className="button button-dark" type="submit" disabled={busy}>{busy ? <LoaderCircle size={16} className="spin" /> : null}{screen === "edit" ? "Save brief" : "Find my references"}<ArrowRight size={17} /></button></div>
          </form><aside className="brief-aside"><div className="margin-note"><span className="margin-note-star">✳</span><h3>A sharper starting point.</h3><p>Your next pitch deserves more than a hunch. PitchProof puts cultural evidence behind your creative instinct.</p><div className="note-signature">Instinct, meet insight.</div></div><div className="how-it-works"><IconLabel>FROM BRIEF TO BELIEF</IconLabel><div><span>01</span><p><strong>Set the scene</strong>Tell us what you’re making and who it’s for.</p></div><div><span>02</span><p><strong>Follow the connections</strong>Research real affinities across brands, artists, film, places and podcasts.</p></div><div><span>03</span><p><strong>Make your case</strong>Compare three creative directions, each linked to the evidence behind it.</p></div></div><div className="sample-card"><FlaskConical size={20} /><h3>Just exploring?</h3><p>Try a running shoe brief to see how the workflow fits together.</p><button className="text-button" onClick={useSample}>Use sample brief <ArrowUpRight size={16} /></button><small>Sample input only. No pre-made results.</small></div><div className="quiet-note"><BookOpen size={16} /><p>Connections are signals for creative exploration. They aren’t proof of purchase intent.</p></div></aside></div>
        </> : screen === "projects" ? <>
          <div className="page-heading list-heading"><div><IconLabel>THE WORK, ALL IN ONE PLACE</IconLabel><h1>Your campaigns<span className="accent">.</span></h1><p className="page-description">A home for the thinking behind your next pitch.</p></div><button className="button button-dark" onClick={() => navigate("new")}><Plus size={17} /> New campaign</button></div>
          <div className="list-toolbar"><label className="search-field"><Search size={17} /><input placeholder="Find a campaign…" aria-label="Search campaigns" value={listQuery} onChange={event => setListQuery(event.target.value)} /></label><div className="filter-pills" aria-label="Filter campaigns">{["all", "draft", "ready", "error"].map(value => <button className={listFilter === value ? "selected" : ""} key={value} onClick={() => setListFilter(value)}>{value === "all" ? "All campaigns" : STATUS_LABEL[value as Project["status"]]}</button>)}</div></div>
          <div className="project-grid">{projects.filter(item => (listFilter === "all" || item.status === listFilter) && `${item.title} ${item.category} ${item.market}`.toLowerCase().includes(listQuery.toLowerCase())).map((item, index) => <button className="project-card" key={item.id} onClick={() => void openProject(item.id)}><div className="project-card-top"><span className="project-card-number">{String(index + 1).padStart(2, "0")}</span><span className={`status-pill ${item.status}`}><span className={`status-dot ${item.status}`} />{STATUS_LABEL[item.status]}</span></div><span className="project-category">{item.category}</span><h2>{item.title}</h2><p>{item.market}</p><div className="project-card-meta"><span>{item.directionCount} directions · {item.evidenceCount} signals</span><ArrowUpRight size={20} /></div><div className="project-card-date">Updated {dateLabel(item.updatedAt)}</div></button>)}</div>
          {!projects.length ? <div className="empty-state"><span className="empty-symbol">✳</span><h2>A blank page.<br /><em>A lot of possibility.</em></h2><p>Your first campaign starts with what you know.<br />We’ll help you find what connects.</p><button className="button button-dark" onClick={() => navigate("new")}>Write your first brief <ArrowRight size={17} /></button></div> : !projects.some(item => (listFilter === "all" || item.status === listFilter) && `${item.title} ${item.category} ${item.market}`.toLowerCase().includes(listQuery.toLowerCase())) ? <div className="empty-state compact"><Search size={28} /><h2>No matching campaigns.</h2><button className="text-button" onClick={() => { setListQuery(""); setListFilter("all"); }}>Clear filters <ArrowRight size={15} /></button></div> : null}
        </> : project ? <>
          <div className="project-heading"><div><button className="back-link" onClick={() => navigate("projects")}><ArrowLeft size={14} /> All campaigns</button><div className="project-title-row"><h1>{project.title}<span className="accent">.</span></h1><span className={`status-pill ${project.status}`}><span className={`status-dot ${project.status}`} />{STATUS_LABEL[project.status]}</span></div><p>{project.brief.category}<span className="meta-separator">/</span>{project.brief.market}</p></div><div className="project-actions"><button className="button button-outline" onClick={editBrief} disabled={busy || !!project.operation && project.operation.state !== "failed"}><FileText size={15} /> View & edit brief</button>{currentGeneration && !project.operation && <ExportMenu project={project} />}</div></div>
          <WorkflowSteps active={project.operation || currentGeneration ? 2 : 1} />
          {!project.operation && currentGeneration && displayedGeneration?.id === currentGeneration.id && <RunReview key={`${project.id}:${project.version}`} project={project} busy={busy} onAccept={() => void command({ action: "accept", directionId: project.selectedDirectionId! })} />}

          {!project.operation ? <details className="reference-disclosure" open={!refsConfirmed}><summary><span>Reference brands</span><span>{project.references.filter(ref => ref.entity).length} confirmed <ChevronDown size={15} /></span></summary><section className="reference-resolution"><div className="workspace-section-title"><div><IconLabel>THE RIGHT STARTING POINTS</IconLabel><h2>Let’s get acquainted.</h2><p>Choose the exact brand you mean. Research starts with the identities you confirm.</p></div><span className="count-label">{project.references.filter(ref => ref.entity).length} OF 3 CONFIRMED</span></div><div className="resolve-grid">{project.references.map((reference, slot) => <article className="resolve-card" key={slot}><div className="resolve-top"><span className="reference-index">{String(slot + 1).padStart(2, "0")}</span><span className="tag">{ROLE_LABEL[reference.role]}</span></div><h3>{reference.query}</h3>{reference.entity ? <div className="confirmed-entity"><CheckCircle2 size={20} /><div><strong>{reference.entity.name}</strong><span>{reference.entity.type}</span><p>{reference.entity.description}</p>{reference.entity.url && <a href={reference.entity.url} target="_blank" rel="noreferrer">Visit source <ExternalLink size={12} /></a>}</div></div> : <p className="resolve-description">Find this brand in the Qloo catalogue, then confirm your match.</p>}<button className="button button-outline full-width" onClick={() => void searchReference(slot)} disabled={searchingSlot !== null || busy}>{searchingSlot === slot ? <LoaderCircle className="spin" size={16} /> : <Search size={15} />}{reference.entity ? candidates[slot] ? "Search again" : "Change match" : candidates[slot] ? "Search again" : "Find brand matches"}</button>{candidates[slot] && <div className="candidate-list">{candidates[slot].length ? candidates[slot].map(candidate => <button className="candidate" key={candidate.entity.id} disabled={busy || searchingSlot !== null || candidate.entity.id === reference.entity?.id} onClick={() => void command({ action: "confirm_reference", slot, token: candidate.token })}><span className="candidate-monogram">{candidate.entity.name[0]}</span><span><strong>{candidate.entity.name}</strong><small>{candidate.entity.type}</small><span className="candidate-description">{candidate.entity.description || "No description supplied by Qloo."}</span></span><Plus size={16} /></button>) : <p className="no-match">No matches found. Edit your brief to try a more specific brand name.</p>}</div>}</article>)}</div>{!refsConfirmed && <div className="workspace-footer"><p><ShieldCheck size={16} /> Your brief is saved. Provider setup can be completed at any time.</p><button className="button button-dark" disabled={!refsConfirmed || busy} onClick={() => void command({ action: "start_research" })}>Start cultural research <ArrowRight size={17} /></button></div>}</section></details> : null}
          {refsConfirmed && !project.operation && (!currentGeneration || project.status === "draft") && <section className="research-ready"><span className="empty-symbol">✳</span><IconLabel>CONTEXT, CONNECTED</IconLabel><h2>Ready to follow<br /><em>the interesting bits.</em></h2><p>Explore cultural affinities around {project.references.map(ref => ref.entity?.name).join(", ")}.<br />Then turn those signals into three distinct campaign directions.</p><div className="confirmed-chips">{project.references.map(ref => <span key={ref.entity!.id}><Check size={13} />{ref.entity!.name}</span>)}</div><button className="button button-dark" disabled={busy} onClick={() => void command({ action: "start_research" })}>{busy ? <LoaderCircle className="spin" size={16} /> : <Sparkles size={16} />} Start cultural research <ArrowRight size={17} /></button><small>Live Qloo research · Evidence-linked creative directions</small></section>}
          {project.operation && <ResearchProgress project={project} busy={busy} cancelPending={cancelRequested} paused={autoPaused} onCancel={() => { setCancelRequested(true); setAutoPaused(true); }} onEditBrief={editBrief} onRetry={() => void command({ action: "retry" })} onContinue={() => { setAutoPaused(false); void command({ action: "advance" }); }} />}
          {project.error && !project.operation && <div className="notice notice-error" role="alert"><span>{project.error}</span><button className="text-button" onClick={() => setSettings(true)}>Check provider setup <ArrowUpRight size={14} /></button></div>}
          {displayedGeneration && <Comparison key={displayedGeneration.id} project={project} generation={displayedGeneration} evidence={displayedEvidence} onEdit={editBrief} />}
          {displayedGeneration && project.status === "draft" && <div className="historical-note"><Clock3 size={16} /> These directions use the previous brief. Start new research above to investigate your updated inputs.</div>}{displayedGeneration && <section className="directions-section"><div className="workspace-section-title directions-heading"><div><IconLabel>{historical ? "FROM YOUR CAMPAIGN HISTORY" : "THREE WAYS TO MAKE YOUR MARK"}</IconLabel><h2>Instinct, with a point of view.</h2><p>{historical ? "A previous generation, kept for context. Return to the latest generation to make decisions." : "Distinct creative territories. Real connections behind each one. Make one yours."}</p></div><div className="generation-tools"><label className="generation-select"><Clock3 size={14} /><select aria-label="Generation history" value={displayedGeneration.id} onChange={event => setGenerationId(event.target.value)}>{project.generations.map((gen, index) => <option value={gen.id} key={gen.id}>Version {index + 1}{gen.id === currentGeneration?.id ? " · Latest" : ""}</option>)}</select><ChevronDown size={14} /></label><button className="text-button" onClick={() => setEvidenceOpen("all")}><Layers3 size={15} /> {displayedEvidence.length} evidence signals <ArrowUpRight size={14} /></button></div></div>{historical && <div className="historical-note"><Clock3 size={16} /> Viewing version {project.generations.findIndex(gen => gen.id === displayedGeneration.id) + 1}. These directions are read-only.<button className="text-button" onClick={() => setGenerationId(null)}>Return to latest <ArrowRight size={14} /></button></div>}{displayedGeneration.feedback && <div className="revision-note"><MessageSquare size={16} /><p><strong>Refined from your feedback</strong>{displayedGeneration.feedback}</p></div>}<div className="direction-grid">{displayedGeneration.directions.map((direction, index) => <DirectionCard key={direction.id} direction={direction} index={index} evidence={displayedEvidence} references={displayedGeneration.references ?? []} annotation={project.annotations[direction.id] || ""} onAnnotate={async text => !!(await command({ action: "annotate", targetId: direction.id, text }))} selected={project.selectedDirectionId === direction.id} rejected={project.decisions.slice().reverse().find(decision => decision.directionId === direction.id)?.decision === "rejected"} readonly={historical || project.status === "draft" || !!project.operation} busy={busy} onEvidence={setEvidenceOpen} onChoose={() => void command({ action: "choose", directionId: direction.id })} onRevise={() => setFeedback({ kind: "revise", direction })} onReject={() => setFeedback({ kind: "reject", direction })} />)}</div><div className="generation-footnote"><span><ShieldCheck size={15} /> Agency review required. Check product facts and production before client use.</span><span>{displayedGeneration.model} · {dateTimeLabel(displayedGeneration.createdAt)}</span></div></section>}
        </> : <div className="empty-state"><h2>We couldn’t open this campaign.</h2><button className="button button-dark" onClick={() => navigate("projects")}>Back to campaigns <ArrowRight size={16} /></button></div>}
        <footer className="page-footer"><span>GOOD IDEAS. GROUNDED.</span><span>Made for the independently minded. <span className="accent">↗</span></span></footer>
      </main>
    </div>
    {settings && <Dialog title="Workspace settings" onClose={onCloseSettings}><p className="modal-intro">Connections live on the server. Your browser never stores provider keys.</p>{configError && <p className="inline-error" role="alert">{configError}</p>}<div className="config-list"><ConfigRow title="Qloo cultural intelligence" ready={!!config?.qlooConfigured} description="Brand resolution and live affinity research" variable="QLOO_API_KEY" /><ConfigRow title="Creative synthesis model" ready={!!config?.modelConfigured} description={config ? `${config.modelProvider} · ${config.modelName}` : "Configuration unavailable"} variable="MODEL_API_KEY · MODEL_PROVIDER · MODEL_NAME" /><ConfigRow title="Project storage" ready={!!config?.storageConfigured} description="Briefs, evidence and decisions persist in Cloudflare D1" variable="DB binding" /></div><div className="setup-note"><strong>Connect your workspace</strong><p>Set <code>QLOO_API_KEY</code> and <code>MODEL_API_KEY</code> as server secrets. Set <code>MODEL_PROVIDER</code> to <code>opencode</code>, <code>gemini</code>, or <code>openai</code>. Optionally set <code>MODEL_NAME</code>, then configure the <code>DB</code> D1 binding and apply the database migration.</p><p>Qloo credentials require approval from Qloo. You can save a brief while you wait for access.</p></div><div className="modal-footer"><button className="button button-outline" onClick={() => void loadConfiguration()}>Refresh status</button><button className="button button-dark" onClick={onCloseSettings}>Done <Check size={16} /></button></div></Dialog>}
    {evidenceOpen && project && <EvidenceDialog showCoverage={evidenceOpen === "all"} evidence={evidenceOpen === "all" ? displayedEvidence : [evidenceOpen]} annotations={project.annotations} busy={busy} error={error} onClose={onCloseEvidence} onAnnotate={async (targetId, text) => { const result = await command({ action: "annotate", targetId, text }); return !!result; }} />}
    {feedback && <FeedbackDialog value={feedback} busy={busy} error={error} onClose={onCloseFeedback} onSubmit={async text => { const result = await command(feedback.kind === "revise" ? { action: "revise", directionId: feedback.direction.id, feedback: text } : { action: "reject", directionId: feedback.direction.id, reason: text }); if (result) setFeedback(null); }} />}
  </div>;
}

function Field({ label, hint, required, children }: { label: string; hint?: string; required?: boolean; children: ReactNode }) {
  return <label className="field"><span className="field-label">{label}{required && <span className="required-star"> *</span>}</span>{children}{hint && <span className="field-hint">{hint}</span>}</label>;
}
function WorkflowSteps({ active }: { active: number }) {
  return <div className="workflow-steps" aria-label="Campaign workflow">{[{ name: "Build your brief", detail: "The context" }, { name: "Connect the dots", detail: "The evidence" }, { name: "Find your direction", detail: "The creative" }].map((step, index) => <div className={`workflow-step ${index === active ? "is-active" : index < active ? "is-complete" : ""}`} key={step.name}><span className="step-number">{index < active ? <Check size={15} /> : String(index + 1).padStart(2, "0")}</span><span><strong>{step.name}</strong><small>{step.detail}</small></span>{index < 2 && <ArrowRight className="step-arrow" size={15} />}</div>)}</div>;
}
function RunReview({ project, busy, onAccept }: { project: Project; busy: boolean; onAccept: () => void }) {
  const [confirmed, setConfirmed] = useState(false);
  const generation = project.generations.at(-1)!;
  const summary = summarizeMeasurements(generation.measurements);
  const review = acceptanceSummary(project);
  const choice = generation.directions.find(direction => direction.id === project.selectedDirectionId);
  const currentChoice = !!choice;
  return <details className="reference-disclosure"><summary><span>Run performance & operator review</span><span>{review.accepted ? "Review recorded" : "Review required"}<ChevronDown size={15} /></span></summary><div className="setup-note"><p>Reviewing version {project.generations.length}, proposal {choice ? `“${choice.title}”` : "not yet chosen"}.</p>{generation.measurementsTruncated && <p>Only the latest 80 recorded events are retained. Counts and bytes below are partial.</p>}<p>Automated checks include a limited review of product claims. They do not verify evidence, establish agency approval or asset rights, or assess campaign quality or results.</p><p>Current run to automated readiness: {review.automatedReadyMs === null ? "Not recorded for this historical run" : `${(review.automatedReadyMs / 1000).toFixed(1)} seconds`}. Provider attempts: {summary.requests ?? "Not recorded"}. Failed provider attempts: {summary.failedRequests ?? "Not recorded"}. Validation and quality failures: {generation.measurements ? generation.measurements.filter(event => event.requests === 0 && event.status === "failed").length : "Not recorded"}.</p>{generation.measurements && <p>{["research", "generation", "review"].map(stage => { const totals = summarizeMeasurements(generation.measurements?.filter(event => event.stage === stage)); return `${stage}: ${totals.requests ?? "Not recorded"} attempts`; }).join(" / ")}. Request durations may overlap during research and are not a wall-clock total.</p>}{review.accepted ? <p role="status">Operator acceptance recorded. Research start to this review: {review.reviewedMs === null ? "Not recorded" : `${(review.reviewedMs / 1000).toFixed(1)} seconds`}. Any project edit requires a new review.</p> : <><p>Choose a current proposal after checking its facts, production plan, citations and limitations. Recording a review accepts it for further planning and does not authorize an ad launch.</p><label><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} /> I accept the chosen proposal for further planning with its recorded limitations.</label><p><button className="button button-outline" disabled={busy || !currentChoice || !confirmed || project.status !== "ready"} onClick={onAccept}>Record operator acceptance <Check size={15} /></button></p></>}</div></details>;
}

function ResearchProgress({ project, busy, cancelPending, paused, onCancel, onRetry, onContinue, onEditBrief }: { project: Project; busy: boolean; cancelPending: boolean; paused: boolean; onCancel: () => void; onRetry: () => void; onContinue: () => void; onEditBrief: () => void }) {
  const operation = project.operation!;
  const complete = operation.steps.filter(step => step.status === "complete").length;
  const failed = operation.state === "failed";
  return <section className="research-panel" aria-live="polite"><div className="research-panel-header"><div className="research-symbol">{failed ? <Circle size={25} /> : <Sparkles size={25} />}</div><div><IconLabel>{failed ? "A CONNECTION NEEDS ATTENTION" : operation.kind === "revision" ? "REFINING YOUR CREATIVE DIRECTION" : "FOLLOWING THE CULTURAL THREADS"}</IconLabel><h2>{failed ? "Research paused." : operation.phase === "synthesis" ? operation.modelStage === "review" ? "Checking the saved proposals." : "Turning connections into ideas." : "Good ideas start with curiosity."}</h2><p>{failed ? operation.error || project.error || "A provider request failed. Your completed research is saved." : operation.phase === "synthesis" ? operation.modelStage === "review" ? "Your draft is saved privately. The automated review checks for unsupported product claims. Review evidence, feedback and test design yourself. A review retry reuses the saved draft when your context is unchanged." : "The model is developing campaign propositions. An automated check will look for unsupported product claims. Operator review of evidence, feedback and test design is still required." : `${complete} of ${operation.steps.length} research queries completed. Results are saved as they arrive.`}</p></div></div><div className="research-track"><span style={{ width: `${operation.steps.length ? complete / operation.steps.length * 100 : 0}%` }} /></div><div className="research-steps">{operation.steps.map((step, index) => <div className={`research-step ${step.status}`} key={step.id}><span>{step.status === "complete" ? <CheckCircle2 size={17} /> : step.status === "failed" ? <X size={17} /> : <Circle size={16} />}</span><div><strong>{step.category}</strong><small>{step.seedNames.join(" + ")}</small><span className="role-context">{step.seedRoles.map(role => ROLE_LABEL[role]).join(" · ")}</span>{step.error && <p className="inline-error">{step.error}</p>}</div><span className="research-step-result">{step.status === "complete" ? `${step.evidenceIds.length} signals` : step.status === "failed" ? "Needs retry" : index === complete && !paused && !failed ? "Next query" : "Queued"}</span></div>)}</div><div className="research-panel-footer"><p><ShieldCheck size={15} /> Completed research is saved as the run progresses.</p><div>{cancelPending ? <span className="working-label" role="status">Stopping after this step…</span> : failed && ["INSUFFICIENT_EVIDENCE", "PROJECT_LIMIT", "DRAFT_LIMIT", "PRODUCT_FACTS_REQUIRED"].includes(operation.failureCode ?? "") ? <button className="button button-dark" disabled={busy} onClick={onEditBrief}>Change research inputs <ArrowRight size={16} /></button> : failed ? <button className="button button-dark" disabled={busy} onClick={onRetry}>{operation.failureStage === "review" ? "Retry campaign check" : "Retry research"} <ArrowRight size={16} /></button> : paused ? <button className="button button-dark" disabled={busy} onClick={onContinue}>Continue research <ArrowRight size={16} /></button> : <span className="working-label"><LoaderCircle className="spin" size={15} /> Research in progress</span>}<button className="button button-outline" disabled={cancelPending} onClick={onCancel}>{cancelPending ? "Stop requested" : busy ? "Stop after this step" : "Cancel run"}</button></div></div></section>;
}

function CampaignReasoning({ direction, evidence, onEvidence }: { direction: Direction; evidence: Evidence[]; onEvidence: (value: Evidence) => void }) {
  const campaign = direction.campaign;
  if (!campaign) return null;
  return <>
    <h4>Why this campaign fits</h4><p>{direction.strategy}</p>
    <h4>The audience tension to validate</h4><p>{campaign.audienceTension}</p>
    <h4>The product's role</h4><p>{campaign.productRole}</p>
    <h4>A concrete ad execution</h4><p>{campaign.execution}</p>
    <h4>Call to action</h4><p>{campaign.callToAction}</p>
    <h4>Observation to interpretation</h4>
    {campaign.evidenceBridge.map(bridge => {
      const record = evidence.find(item => item.id === bridge.evidenceId);
      return <div className="claim" key={bridge.evidenceId}>
        {record && <><button className="text-button" onClick={() => onEvidence(record)}>{record.entity.name}<ArrowUpRight size={11} /></button><p><strong>Qloo observation.</strong> {record.observation}</p></>}
        <p><strong>Creative interpretation.</strong> {bridge.interpretation}</p>
        <p><strong>Relevance to this brief.</strong> {bridge.relevance}</p>
        <p><strong>What remains uncertain.</strong> {bridge.uncertainty}</p>
      </div>;
    })}
  </>;
}

function DirectionCard({ direction, index, evidence, references, annotation, onAnnotate, selected, rejected, readonly, busy, onEvidence, onChoose, onRevise, onReject }: { direction: Direction; index: number; evidence: Evidence[]; references: Reference[]; annotation: string; onAnnotate: (text: string) => Promise<boolean>; selected: boolean; rejected: boolean; readonly: boolean; busy: boolean; onEvidence: (evidence: Evidence) => void; onChoose: () => void; onRevise: () => void; onReject: () => void }) {
  const evidenceIds = Array.from(new Set(direction.claims.flatMap(claim => claim.evidenceIds)));
  const items = evidence.filter(item => evidenceIds.includes(item.id));
  const [expanded, setExpanded] = useState(false);
  return <article className={`direction-card direction-${index + 1} ${selected ? "direction-selected" : ""} ${rejected ? "direction-rejected" : ""}`}><div className="direction-art"><div className="direction-art-label"><span>CREATIVE TERRITORY</span><span>{String(index + 1).padStart(2, "0")}</span></div><span className="art-numeral" aria-hidden="true">{String(index + 1).padStart(2, "0")}</span><div className="art-caption">A DIFFERENT WAY IN <ArrowUpRight size={17} /></div>{selected && <span className="selection-badge"><Check size={13} /> Your chosen direction</span>}{rejected && !selected && <span className="selection-badge rejected-badge">Passed on</span>}</div><div className="direction-content"><IconLabel>DIRECTION {String(index + 1).padStart(2, "0")}</IconLabel><h3>{direction.title}</h3>{hasReviewWarnings(direction) && <p className="inline-error" role="status"><strong>Review needed.</strong> Automated review found {reviewWarningText(direction)} after repair. Review this direction before use. It is excluded from exports.</p>}<p className="direction-hook">“{direction.hook}”</p><div className="direction-section"><h4>The audience hypothesis</h4><p>{direction.audienceHypothesis}</p></div><div className="direction-section"><h4>{direction.campaign ? "The campaign proposition" : "The creative hypothesis"}</h4><p>{direction.campaign?.proposition ?? direction.strategy}</p>{direction.campaign && <><h4>The campaign mechanism</h4><p>{direction.campaign.mechanism}</p></>}</div><div className="direction-section"><h4>The proposed visual world</h4><p>{direction.visuals.description}</p><div className="palette" aria-label="Suggested colour palette">{direction.visuals.palette.map((color, i) => <span key={`${color}-${i}`} className="swatch" style={{ backgroundColor: /^#[a-f\d]{3,8}$/i.test(color) ? color : "#e4e0d7" }} title={color}><span>{color}</span></span>)}</div><p className="visual-reference">Proposed references · {direction.visuals.references.join(", ")}</p><ReferenceBoard references={visualReferences(direction, evidence, references)} /></div><div className="channel-tags">{direction.channels.map(channel => <span key={channel}>{channel}</span>)}</div><div className="evidence-links"><h4><Layers3 size={13} /> Behind the idea</h4><div>{items.map(item => <button key={item.id} onClick={() => onEvidence(item)}>{item.entity.name} <ArrowUpRight size={11} /></button>)}</div></div><button className="detail-toggle" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>{expanded ? "Hide the thinking" : "Explore the thinking & test plan"}<ChevronDown className={expanded ? "rotate" : ""} size={15} /></button>{expanded && <div className="expanded-direction"><CampaignReasoning direction={direction} evidence={evidence} onEvidence={onEvidence} /><h4>Supporting observations</h4>{direction.claims.map((claim, i) => <div className="claim" key={i}><p>{claim.text}</p><div>{claim.evidenceIds.map(id => { const item = evidence.find(value => value.id === id); return item ? <button className="text-button" key={id} onClick={() => onEvidence(item)}>{item.entity.name}<ArrowUpRight size={11} /></button> : <span className="field-hint" key={id}>Source unavailable</span>; })}</div></div>)}<h4>A test before a bigger bet</h4>{direction.testPlan.kind && <p className="field-hint">{direction.testPlan.kind === "concept" ? "Campaign proposition pilot" : "Execution treatment pilot"}</p>}<p>{direction.testPlan.hypothesis}</p><ul>{direction.testPlan.variants.map(variant => <li key={variant}>{variant}</li>)}</ul><dl className="test-metrics">{([ ["Variable", direction.testPlan.variable], ["Shared controls", direction.testPlan.controls], ["Proposed budget and duration", direction.testPlan.budget], ["Minimum data", direction.testPlan.minimumData] ] as const).map(([label, value]) => value ? <div key={label}><dt>{label}</dt><dd>{value}</dd></div> : null)}<dt>Measure</dt><dd>{direction.testPlan.metric}</dd><dt>Success criterion</dt><dd>{direction.testPlan.successCriterion}</dd>{direction.testPlan.inconclusive && <><dt>If inconclusive</dt><dd>{direction.testPlan.inconclusive}</dd></>}</dl>{direction.limitations.length > 0 && <div className="limitations"><h4>Keep in mind</h4><ul>{direction.limitations.map(limitation => <li key={limitation}>{limitation}</li>)}</ul></div>}</div>}<DirectionAnnotation key={direction.id} title={direction.title} annotation={annotation} busy={busy} readonly={readonly} onSave={onAnnotate} /><div className="direction-actions"><button className={`button ${selected ? "button-selected" : "button-dark"} full-width`} disabled={readonly || busy || selected} onClick={onChoose}>{selected ? <Check size={15} /> : null}{selected ? "Direction chosen" : "Choose this direction"}{!selected && <ArrowRight size={15} />}</button><div><button className="text-button" disabled={readonly || busy} onClick={onRevise}><MessageSquare size={13} /> Refine with feedback</button><button className="text-button reject-button" disabled={readonly || busy || rejected} onClick={onReject}>{rejected ? "Passed" : "Pass"}</button></div></div></div></article>;
}

function DirectionAnnotation({ title, annotation, busy, readonly, onSave }: { title: string; annotation: string; busy: boolean; readonly: boolean; onSave: (text: string) => Promise<boolean> }) {
  const [text, setText] = useState(annotation);
  const [saved, setSaved] = useState(false);
  return <details className="direction-annotation"><summary>Your agency notes{annotation ? " · Saved" : ""}</summary><form onSubmit={async event => { event.preventDefault(); const submitted = text.trim(); if (await onSave(submitted)) { setText(submitted); setSaved(true); } }}><label>Agency notes for {title}<textarea rows={3} maxLength={TEXT_LIMITS.annotation} value={text} readOnly={readonly || busy} onChange={event => { setText(event.target.value); setSaved(false); }} placeholder="Add client context, production decisions, or your interpretation." /></label><p>These notes appear in the exported brief. The generated direction and source evidence stay intact.</p><div><span role="status">{saved ? "Agency notes saved." : ""}</span><button className="button button-outline" disabled={readonly || busy || text === annotation}>Save agency notes</button></div></form></details>;
}

function ExportMenu({ project }: { project: Project }) {
  const [open, setOpen] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState("");
  const [markdown, setMarkdown] = useState("");
  const [copyStatus, setCopyStatus] = useState("");
  const root = `/api/projects/${encodeURIComponent(project.id)}/export`;
  async function downloadMarkdown(event: React.MouseEvent<HTMLAnchorElement>) {
    event.preventDefault();
    if (downloading) return;
    setDownloading(true); setError("");
    try {
      const response = await fetch(`${root}?format=markdown`, { cache: "no-store" });
      if (!response.ok || !response.headers.get("content-type")?.startsWith("text/markdown")) throw new Error("The brief could not be downloaded. Refresh the campaign and try again.");
      const text = await response.text();
      const blob = new Blob([text], { type: "text/markdown;charset=utf-8" });
      if (!blob.size || blob.size > 1_000_000) throw new Error("The export did not contain a usable brief. Please try again.");
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url; link.download = `pitchproof-${project.id}.md`;
      document.body.appendChild(link); link.click(); link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
      setMarkdown(text); setCopyStatus(""); setOpen(false);
    } catch (failure) { setError(failure instanceof Error ? failure.message : "The brief could not be downloaded. Please try again."); }
    finally { setDownloading(false); }
  }
  return <><div className="export-menu"><button className="button button-dark" aria-expanded={open} onClick={() => setOpen(!open)}><ArrowDownToLine size={15} /> Export brief <ChevronDown size={14} /></button>{open && <><button className="dropdown-scrim" aria-label="Close export menu" onClick={() => setOpen(false)} /><div className="export-dropdown"><a href={`${root}?format=html`} target="_blank" rel="noreferrer" onClick={() => setOpen(false)}><SquareArrowOutUpRight size={16} /><span>Printable campaign brief<small>Open HTML and print to PDF</small></span></a><a href={`${root}?format=markdown`} download onClick={downloadMarkdown} aria-disabled={downloading} aria-busy={downloading}><FileText size={16} /><span>{downloading ? "Preparing download…" : "Download Markdown"}<small>Editable text with evidence</small></span></a>{error && <p className="inline-error" role="alert">{error}</p>}</div></>}</div>{markdown && <Dialog title="Your editable brief" onClose={() => setMarkdown("")} wide><p className="modal-intro">Your download was requested. If your browser blocks downloads, copy the Markdown below.</p><Field label="Markdown source"><textarea readOnly rows={14} value={markdown} /></Field><div className="modal-footer"><span role="status">{copyStatus}</span><button className="button button-outline" onClick={() => setMarkdown("")}>Close</button><button className="button button-dark" onClick={async () => { try { await navigator.clipboard.writeText(markdown); setCopyStatus("Markdown copied."); } catch { setCopyStatus("Select the text above and copy it using your browser."); } }}>Copy Markdown</button></div></Dialog>}</>;
}

function ConfigRow({ title, ready, description, variable }: { title: string; ready: boolean; description: string; variable: string }) {
  return <div className="config-row"><span className={`config-icon ${ready ? "ready" : ""}`}>{ready ? <Check size={18} /> : <Settings2 size={18} />}</span><div><strong>{title}</strong><p>{description}</p><code>{variable}</code></div><span className={`config-status ${ready ? "ready" : ""}`}>{ready ? "Connected" : "Not configured"}</span></div>;
}
function FeedbackDialog({ value, busy, error, onClose, onSubmit }: { value: Feedback; busy: boolean; error: string; onClose: () => void; onSubmit: (text: string) => Promise<void> }) {
  const [text, setText] = useState("");
  return <Dialog title={value.kind === "revise" ? "Make it more yours." : "Pass on this direction"} onClose={onClose}><div className="feedback-direction"><IconLabel>{value.kind === "revise" ? "REFINING" : "PASSING ON"}</IconLabel><h3>{value.direction.title}</h3></div><p className="modal-intro">{value.kind === "revise" ? "State what must stay and what must change. We include your agency notes and rejected ideas, research fresh evidence, and check all three proposals against your feedback. This version stays in history." : "A little context helps keep the decision useful. Your direction and the original evidence will stay in your campaign history."}</p>{error && <p className="notice notice-error" role="alert">{error}</p>}<form onSubmit={event => { event.preventDefault(); void onSubmit(text); }}><Field label={value.kind === "revise" ? "Your creative feedback" : "Why isn’t it the right fit?"} required><textarea autoFocus required maxLength={TEXT_LIMITS.feedback} minLength={value.kind === "revise" ? 8 : 1} rows={5} value={text} onChange={event => setText(event.target.value)} placeholder={value.kind === "revise" ? "e.g. Keep the community angle, but make the tone warmer and focus on a smaller production budget." : "e.g. The tone is too close to our competitors."} /></Field><div className="modal-footer"><button type="button" className="button button-outline" disabled={busy} onClick={onClose}>Keep exploring</button><button className="button button-dark" disabled={busy || text.trim().length < (value.kind === "revise" ? 8 : 1)}>{busy ? <LoaderCircle className="spin" size={15} /> : null}{value.kind === "revise" ? "Create a new version" : "Save decision"}<ArrowRight size={15} /></button></div></form></Dialog>;
}
function EvidenceDialog({ evidence, showCoverage, annotations, busy, error, onClose, onAnnotate }: { evidence: Evidence[]; showCoverage: boolean; annotations: Record<string, string>; busy: boolean; error: string; onClose: () => void; onAnnotate: (id: string, text: string) => Promise<boolean> }) {
  const [selectedId, setSelectedId] = useState(evidence[0]?.id || "");
  const item = evidence.find(value => value.id === selectedId) || evidence[0];
  return <Dialog title="The evidence behind it." onClose={onClose} wide><p className="modal-intro">Original research stays intact. Add your interpretation separately.</p>{showCoverage && <div className="setup-note"><strong>Research coverage</strong><p>{CATEGORIES.map(category => `${category} · ${evidence.filter(value => value.category === category).length} signals`).join(" / ")}</p>{CATEGORIES.some(category => !evidence.some(value => value.category === category)) && <p>Categories with no collected signals are evidence gaps. They do not support market-specific conclusions.</p>}</div>}{error && <p className="notice notice-error" role="alert">{error}</p>}{!item ? <div className="empty-state compact"><p>No evidence is available for this generation.</p></div> : <div className={`evidence-dialog-layout ${evidence.length === 1 ? "single-evidence" : ""}`}>{evidence.length > 1 && <nav className="evidence-index" aria-label="Evidence signals">{evidence.map(value => <button className={value.id === item.id ? "active" : ""} key={value.id} onClick={() => setSelectedId(value.id)}><span>{value.category}</span><strong>{value.entity.name}</strong><ArrowUpRight size={12} /></button>)}</nav>}<EvidenceDetail key={item.id} item={item} annotation={annotations[item.id] || ""} busy={busy} onAnnotate={onAnnotate} /></div>}</Dialog>;
}
function EvidenceDetail({ item, annotation, busy, onAnnotate }: { item: Evidence; annotation: string; busy: boolean; onAnnotate: (id: string, text: string) => Promise<boolean> }) {
  const [text, setText] = useState(annotation);
  const [saved, setSaved] = useState(false);
  return <article className="evidence-detail"><div className="evidence-detail-title"><span className="tag">{item.category}</span><span className="evidence-rank">RESULT RANK {item.rank}</span></div><h3>{item.entity.name}</h3>{item.entity.description && <p className="entity-description">{item.entity.description}</p>}<div className="observation"><IconLabel>PROVIDER OBSERVATION</IconLabel><p>{item.observation}</p></div><dl className="provenance"><dt>Reference context</dt><dd>{item.context.referenceNames.join(", ")}</dd><dt>Reference roles</dt><dd>{item.context.referenceRoles.map(role => ROLE_LABEL[role]).join(", ")}</dd><dt>Requested market</dt><dd>{item.context.market}</dd><dt>Geographic scope</dt><dd>{item.context.geographyApplied ? "Geographic filter applied to this query" : "No geographic filter applied. Results are not market-specific."}</dd><dt>Raw query-relative score</dt><dd>{item.score ? `${item.score.value} · ${item.score.metric}` : "Not returned by provider"}<small>A provider ranking signal for this query. Not a confidence or purchase-intent percentage.</small></dd><dt>Collected</dt><dd>{dateTimeLabel(item.collectedAt)}</dd><dt>Provider endpoint</dt><dd className="mono-value">{item.context.endpoint}</dd><dt>Query parameters</dt><dd className="query-parameters">{Object.entries(item.context.parameters).map(([key, value]) => <span key={key}><code>{key}</code> {value}</span>)}</dd><dt>Research run</dt><dd className="mono-value">{item.runId}</dd></dl>{item.entity.url && <a className="text-button source-link" href={item.entity.url} target="_blank" rel="noreferrer">Open entity source <ExternalLink size={13} /></a>}<form className="annotation-form" onSubmit={async event => { event.preventDefault(); const success = await onAnnotate(item.id, text); if (success) setSaved(true); }}><Field label="Your studio notes" hint="Your annotation does not change the original evidence."><textarea rows={3} maxLength={TEXT_LIMITS.annotation} placeholder="What does this connection mean for the campaign?" value={text} onChange={event => { setText(event.target.value); setSaved(false); }} /></Field><div><span role="status">{saved ? "Note saved to this campaign." : ""}</span><button className="button button-outline" disabled={busy || text === annotation}>{busy ? <LoaderCircle className="spin" size={14} /> : <Check size={14} />} Save note</button></div></form></article>;
}
