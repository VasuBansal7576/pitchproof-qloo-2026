import { CATEGORIES, VALIDATION_FEEDBACK_CODES, type Candidate, type Category, type CommandEnvelope, type Generation, type Operation, type Project, type ResearchStep, type StageMeasurement } from '../lib/pitchproof-types';
import { suppliedFacts } from '../lib/product-contract';
import { AppError, fail, hash, now, randomToken, safeFailure, uid } from './errors';
import type { ProjectInput } from './validation';
import { Store, type DraftFence } from './store';
import { researchQloo, searchQloo } from './providers/qloo';
import { requireProviders, revisionPlan, generateDraft, restoreDraft, reviewDraft, directionsFromDraft, unavailablePilot, synthesisIdentity, CONTRACT_VERSION, modelConfiguration, type ProviderEnv, type SynthesisDraft } from './providers/synthesis';
import type { ProviderObserver } from './providers/http';
type ResearchResult = { stepId: string } & ({ evidence: Awaited<ReturnType<typeof researchQloo>>; failure: null } | { evidence: null; failure: AppError });
export function makeProject(input: ProjectInput): Project {
  const time = now(); return { id: uid(), title: input.brief.product || 'Untitled pitch', version: 0, status: 'draft', brief: input.brief, references: input.references.map(ref => ({ ...ref, entity: null })), evidence: [], generations: [], selectedDirectionId: null, decisions: [], annotations: {}, operation: null, error: null, createdAt: time, updatedAt: time };
}
export function makeOperation(project: Project, kind: 'research' | 'revision', feedback: string | null = null, parentDirectionId: string | null = null, revisionCategories?: Category[]): Operation {
  const steps: ResearchStep[] = [];
  for (const ref of project.references) {
    if (!ref.entity) fail(422, 'REFERENCES_REQUIRED', 'Confirm all three reference brands before research.');
    const categories = revisionCategories ?? (ref.role === 'audience' ? [...CATEGORIES] : ref.role === 'competitor' ? ['brand', 'place'] as Category[] : ['artist', 'movie'] as Category[]);
    for (const category of categories) steps.push({ id: uid(), category, seedIds: [ref.entity.id], seedNames: [ref.entity.name], seedRoles: [ref.role], status: 'pending', evidenceIds: [], error: null });
  }
  return { id: uid(), kind, phase: 'research', state: 'pending', steps, brief: structuredClone(project.brief), references: structuredClone(project.references), feedback, parentDirectionId, leaseToken: null, leaseUntil: 0, error: null, failureCode: null, startedAt: now() };
}
function hasDirection(project: Project, id: string): boolean { return project.generations.some(g => g.directions.some(d => d.id === id)); }
function rememberValidationFailure(operation: Operation, code: string | null | undefined): void {
  const recognized = VALIDATION_FEEDBACK_CODES.find(value => value === code);
  if (recognized) operation.validationFeedback = [...new Set([...(operation.validationFeedback ?? []), recognized])].sort();
}
function readyForResearch(project: Project): void {
  suppliedFacts(project.brief);
  if (project.operation) fail(409, 'OPERATION_ACTIVE', 'Finish or cancel the current operation first.');
  if (project.references.length !== 3 || project.references.some(r => !r.entity)) fail(422, 'REFERENCES_REQUIRED', 'Confirm all three reference brands before research.');
  if (new Set(project.references.map(r => r.entity!.id)).size !== 3) fail(422, 'DISTINCT_REFERENCES', 'Use three different confirmed reference brands.');
  if (!project.brief.product.trim() || !project.brief.description.trim() || !project.brief.market.trim() || !project.brief.audience.trim()) fail(422, 'BRIEF_REQUIRED', 'Add a product, description, target market and audience before research.');
  if (project.evidence.length > 125 || project.generations.length >= 8) fail(422, 'PROJECT_LIMIT', 'This project has reached its research history limit. Create a new project.');
}
export class PitchProof {
  constructor(readonly store: Store, readonly env: ProviderEnv) {}
  async create(owner: string, input: ProjectInput): Promise<Project> { const project = makeProject(input); await this.store.create(owner, project); return project; }
  async search(owner: string, id: string, slot: number, query: string): Promise<Candidate[]> {
    const project = await this.store.read(owner, id);
    if (!this.env.QLOO_API_KEY?.trim()) fail(503, 'QLOO_NOT_CONFIGURED', 'Cultural research is not connected yet. Your brief is saved. Open provider setup or contact the workspace owner.');
    await this.store.budget(owner, 1, undefined, this.env.DEMO_UNLIMITED_DAILY_CAP === 'true');
    const entities = await searchQloo(this.env.QLOO_API_KEY, query);
    const candidates: Candidate[] = [];
    for (const entity of entities) { const token = randomToken(); await this.store.putCandidate(owner, project, slot, query, entity, token); candidates.push({ entity, token }); }
    await this.store.db.prepare('DELETE FROM reference_candidates WHERE expires_at < ?').bind(Date.now()).run();
    return candidates;
  }
  async execute(owner: string, id: string, command: CommandEnvelope): Promise<Project> {
    let project = await this.store.read(owner, id);
    const requestHash = await hash(JSON.stringify(command));
    if (await this.store.receipt(owner, id, command.commandId, requestHash)) return project;
    if (project.version !== command.expectedVersion) fail(409, 'STALE_VERSION', 'The project changed. Reload it and try again.');
    const previousVersion = project.version;
    const previousOperationId = project.operation?.id;
    switch (command.action) {
      case 'update_brief': {
        project.references = command.references.map((ref, index) => ({ ...ref, entity: project.references[index]?.query === ref.query && project.references[index]?.role === ref.role ? project.references[index].entity : null }));
        project.brief = command.brief; project.title = command.brief.product || 'Untitled pitch'; project.operation = null; project.status = 'draft'; project.error = null; break;
      }
      case 'confirm_reference': {
        const candidate = await this.store.candidate(owner, project, command.slot, command.token);
        if (project.references.some((r, i) => i !== command.slot && r.entity?.id === candidate.entity.id)) fail(422, 'DISTINCT_REFERENCES', 'Choose a different brand for each reference.');
        project.references[command.slot] = { ...project.references[command.slot], ...candidate };
        project.operation = null; project.status = 'draft'; project.error = null; break;
      }
      case 'start_research': {
        requireProviders(this.env); readyForResearch(project); project.operation = makeOperation(project, 'research'); project.researchStartedAt ??= project.operation.startedAt; project.status = 'researching'; project.error = null; break;
      }
      case 'revise': {
        requireProviders(this.env); readyForResearch(project);
        if (!hasDirection(project, command.directionId)) fail(404, 'DIRECTION_NOT_FOUND', 'Direction not found.');
        await this.store.budget(owner, 1, undefined, this.env.DEMO_UNLIMITED_DAILY_CAP === 'true');
        const categories = await revisionPlan(this.env, command.feedback, project, command.directionId);
        project.operation = makeOperation(project, 'revision', command.feedback, command.directionId, categories); project.researchStartedAt ??= project.operation.startedAt; project.status = 'researching'; project.error = null; break;
      }
      case 'cancel': { const draft = project.operation?.kind === 'research' || project.status === 'draft'; project.operation = null; project.status = !draft && project.generations.length ? 'ready' : 'draft'; project.error = null; break; }
      case 'retry': {
        if (!project.operation || project.operation.state !== 'failed') fail(409, 'NOT_RETRYABLE', 'There is no failed operation to retry.');
        if (project.operation.failureCode === 'INSUFFICIENT_EVIDENCE') fail(422, 'INSUFFICIENT_EVIDENCE', 'This run has too little supporting evidence. Cancel it and change the reference brands or target market before researching again.');
        if (['PROJECT_LIMIT', 'DRAFT_LIMIT'].includes(project.operation.failureCode ?? '')) fail(422, 'PROJECT_LIMIT', 'This run cannot fit more history. Cancel it and start a new project before spending more provider calls.');
        requireProviders(this.env);
        for (const event of project.operation.measurements ?? []) if (event.requests === 0) rememberValidationFailure(project.operation, event.failureCode);
        rememberValidationFailure(project.operation, project.operation.failureCode);
        project.operation.failureCode = null;
        project.operation.steps = project.operation.steps.map(step => step.status === 'failed' ? { ...step, status: 'pending', error: null } : step);
        project.operation.state = 'pending'; project.operation.error = null; project.operation.leaseToken = null; project.operation.leaseUntil = 0; project.status = 'researching'; project.error = null; break;
      }
      case 'advance': {
        const operation = project.operation;
        if (!operation) fail(409, 'NO_OPERATION', 'Start research before advancing.');
        if (operation.state === 'failed') fail(409, 'RETRY_REQUIRED', 'Retry the failed step before advancing.');
        if (operation.leaseUntil > Date.now() && operation.leaseToken) fail(409, 'OPERATION_BUSY', 'A research step is already running.');
        requireProviders(this.env);
        operation.leaseToken = randomToken(); operation.leaseUntil = Date.now() + (operation.phase === 'synthesis' ? 660_000 : 90_000); operation.state = 'running'; operation.error = null; project.error = null; project.status = 'researching'; break;
      }
      case 'choose': case 'reject': {
        if (!hasDirection(project, command.directionId)) fail(404, 'DIRECTION_NOT_FOUND', 'Direction not found.');
        const decision = command.action === 'choose' ? 'selected' : 'rejected';
        if (command.action === 'choose') project.selectedDirectionId = command.directionId;
        else if (project.selectedDirectionId === command.directionId) project.selectedDirectionId = null;
        project.decisions.push({ directionId: command.directionId, decision, reason: command.action === 'reject' ? command.reason : '', createdAt: now() }); break;
      }
      case 'annotate': {
        if (!hasDirection(project, command.targetId) && !project.evidence.some(e => e.id === command.targetId)) fail(404, 'TARGET_NOT_FOUND', 'Annotation target not found.');
        if (command.text.trim()) project.annotations[command.targetId] = command.text.trim(); else delete project.annotations[command.targetId]; break;
      }
      case 'accept': {
        const generation = project.generations.at(-1);
        if (project.operation || project.status !== 'ready' || project.selectedDirectionId !== command.directionId || !generation?.directions.some(direction => direction.id === command.directionId)) fail(409, 'REVIEW_NOT_READY', 'Choose a current direction and finish research before recording your review.');
        if ([...project.decisions].reverse().find(decision => decision.directionId === command.directionId)?.decision === 'rejected') fail(409, 'REVIEW_NOT_READY', 'Choose an unrejected direction before recording your review.');
        if (project.acceptances?.some(record => record.generationId === generation.id && record.directionId === command.directionId && record.reviewedVersion === previousVersion - 1)) fail(409, 'ALREADY_REVIEWED', 'This version already has a recorded operator review.');
        const time = now(); const start = Date.parse(project.researchStartedAt ?? generation.runStartedAt ?? ''); const elapsed = Date.parse(time) - start;
        (project.acceptances ??= []).push({ generationId: generation.id, directionId: command.directionId, createdAt: time, reviewedVersion: previousVersion, elapsedMs: Number.isFinite(elapsed) && elapsed >= 0 ? elapsed : null });
        break;
      }
    }
    try { await this.store.save(owner, previousVersion, project, { commandId: command.commandId, requestHash }); }
    catch (error) { if (await this.store.receipt(owner, id, command.commandId, requestHash)) return this.store.read(owner, id); throw error; }
    if (previousOperationId && previousOperationId !== project.operation?.id) await this.store.discardDraft(owner, project.id, previousOperationId);
    if (command.action === 'advance') project = await this.advance(owner, project);
    return project;
  }
  private async advance(owner: string, claimed: Project): Promise<Project> {
    const operation = structuredClone(claimed.operation!);
    const steps = operation.phase === 'research' ? operation.steps.filter(s => s.status !== 'complete').slice(0, 3) : [];
    let results: ResearchResult[] = [];
    let generation: Generation | null = null;
    let failure: AppError | null = null;
    let failureStage: StageMeasurement['stage'] = steps.length ? 'research' : 'generation';
    let contextHash: string | null = null;
    let publication: DraftFence | undefined;
    let measurements: StageMeasurement[] = [];
    const observe = (stage: StageMeasurement['stage']): ProviderObserver => measurement => { measurements.push({ ...measurement, stage }); };
    if (steps.length) {
      const requests: Promise<ResearchResult>[] = [];
      for (const step of steps) {
        try { if (!await this.store.budget(owner, 1, { id: `${operation.id}:${operation.leaseToken}:${step.id}`, projectId: claimed.id, operationId: operation.id, leaseToken: operation.leaseToken! }, this.env.DEMO_UNLIMITED_DAILY_CAP === 'true')) fail(409, 'OPERATION_BUSY', 'This provider stage has already started. Reload saved progress.'); }
        catch (error) { requests.push(Promise.resolve({ stepId: step.id, evidence: null, failure: safeFailure(error) })); break; }
        requests.push(researchQloo(this.env.QLOO_API_KEY, operation, step, observe('research')).then(
          evidence => ({ stepId: step.id, evidence, failure: null }),
          error => ({ stepId: step.id, evidence: null, failure: safeFailure(error) }),
        ));
      }
      results = await Promise.all(requests);
      failure = results.find(result => result.failure)?.failure ?? null;
    } else {
      try {
        const records = claimed.evidence.filter(e => e.runId === operation.id);
        if (records.length < 6 || new Set(records.map(record => record.category)).size < 2) fail(422, 'INSUFFICIENT_EVIDENCE', 'Research needs at least six evidence records across two categories before synthesis.');
        contextHash = await hash(synthesisIdentity(this.env, operation, records, claimed));
        const checkpoint = await this.store.draft(owner, claimed.id, operation.id);
        let draft: SynthesisDraft | null = null;
        let repairExhausted = false;
        if (checkpoint?.contextHash === contextHash) {
          try {
            const payload = checkpoint.payload;
            if (payload && typeof payload === 'object' && 'version' in payload && payload.version === 2 && 'draft' in payload && 'repairExhausted' in payload && typeof payload.repairExhausted === 'boolean') {
              repairExhausted = payload.repairExhausted;
              draft = restoreDraft(payload.draft, operation, records, claimed, repairExhausted);
            } else draft = restoreDraft(payload, operation, records, claimed);
          } catch { repairExhausted = false; await this.store.discardDraft(owner, claimed.id, operation.id, contextHash, operation.leaseToken!); }
        } else if (checkpoint) await this.store.discardDraft(owner, claimed.id, operation.id, checkpoint.contextHash, operation.leaseToken!);
        failureStage = draft ? 'review' : 'generation';
        const units = draft ? 1 : 2;
        if (!await this.store.budget(owner, units, { id: `${operation.id}:${operation.leaseToken}:${failureStage}`, projectId: claimed.id, operationId: operation.id, leaseToken: operation.leaseToken! }, this.env.DEMO_UNLIMITED_DAILY_CAP === 'true')) fail(409, 'OPERATION_BUSY', 'This provider stage has already started. Reload saved progress.');
        const reserveExtra = async (name: string) => {
          if (!await this.store.budget(owner, 1, { id: `${operation.id}:${operation.leaseToken}:${name}`, projectId: claimed.id, operationId: operation.id, leaseToken: operation.leaseToken! }, this.env.DEMO_UNLIMITED_DAILY_CAP === 'true')) fail(409, 'OPERATION_BUSY', 'This provider attempt has already started. Reload saved progress.');
        };
        if (!draft) {
          draft = await generateDraft(this.env, operation, records, claimed, observe('generation'), () => reserveExtra('generation-repair'), attempt => reserveExtra(`generation-retry-${attempt}`), false, () => { repairExhausted = true; });
        }
        const saveCheckpoint = async () => {
          const latest = await this.store.read(owner, claimed.id);
          if (latest.operation?.id !== operation.id || latest.operation.leaseToken !== operation.leaseToken) fail(409, 'OPERATION_OBSOLETE', 'This operation is no longer active.');
          const latestRecords = latest.evidence.filter(record => record.runId === operation.id);
          if (await hash(synthesisIdentity(this.env, latest.operation, latestRecords, latest)) !== contextHash) fail(409, 'CONTEXT_CHANGED', 'The campaign context changed during generation. Your research is saved. Retry with the latest notes and decisions.');
          const capacity = structuredClone(latest);
          capacity.generations.push({ id: uid(), createdAt: now(), model: modelConfiguration(this.env).model, directions: directionsFromDraft(draft!, operation, records, claimed, repairExhausted), evidenceIds: records.map(record => record.id), parentDirectionId: operation.parentDirectionId, feedback: operation.feedback, brief: operation.brief, references: operation.references, measurements: [...(operation.measurements ?? []), ...measurements], contractVersion: CONTRACT_VERSION }); capacity.operation = null;
          this.store.serialize(capacity);
          latest.operation.modelStage = 'review'; latest.operation.measurementsTruncated ||= (latest.operation.measurements?.length ?? 0) + measurements.length > 80; latest.operation.measurements = [...(latest.operation.measurements ?? []), ...measurements].slice(-80);
          await this.store.saveDraft(owner, latest.version, latest, contextHash!, { version: 2, draft, repairExhausted }); measurements = [];
        };
        await saveCheckpoint();
        failureStage = 'review';
        let unverified = await reviewDraft(this.env, operation, records, claimed, draft, observe('review'), () => reserveExtra('review-retry'), true, repairExhausted);
        if (unverified.length && !repairExhausted) {
          if (!await this.store.budget(owner, 2, { id: `${operation.id}:${operation.leaseToken}:claim-repair`, projectId: claimed.id, operationId: operation.id, leaseToken: operation.leaseToken! }, this.env.DEMO_UNLIMITED_DAILY_CAP === 'true')) fail(409, 'OPERATION_BUSY', 'This claim repair has already started. Reload saved progress.');
          const repairOperation = { ...operation, validationFeedback: [...new Set([...(operation.validationFeedback ?? []), 'CAMPAIGN_REVIEW' as const, ...(unverified.some(issue => issue.code === 'unsupported_claim') ? ['UNSUPPORTED_PRODUCT_COPY' as const] : [])])] };
          failureStage = 'generation';
          draft = await generateDraft(this.env, repairOperation, records, claimed, observe('generation'), undefined, () => reserveExtra('claim-repair-generation-retry'), true);
          repairExhausted = true;
          await saveCheckpoint();
          failureStage = 'review';
          unverified = await reviewDraft(this.env, operation, records, claimed, draft, observe('review'), () => reserveExtra('claim-repair-review-retry'), true, true);
        }
        const directions = directionsFromDraft(draft, operation, records, claimed, repairExhausted);
        for (const issue of unverified) {
          const direction = directions[issue.directionIndex];
          direction.reviewWarnings = [...new Set([...(direction.reviewWarnings ?? []), issue.code])];
          if (issue.code === 'unsupported_claim') { direction.unverifiedClaim = true; direction.testPlan = unavailablePilot(); }
        }
        generation = { id: uid(), createdAt: now(), model: `${modelConfiguration(this.env).provider}/${modelConfiguration(this.env).model}`, directions, evidenceIds: records.map(record => record.id), parentDirectionId: operation.parentDirectionId, feedback: operation.feedback, brief: structuredClone(operation.brief), references: structuredClone(operation.references), contractVersion: CONTRACT_VERSION, runStartedAt: operation.startedAt };
        publication = { operationId: operation.id, leaseToken: operation.leaseToken!, contextHash };
      } catch (error) { failure = safeFailure(error); }
      if (failure && contextHash && ['CAMPAIGN_REVIEW', 'INVALID_CITATIONS', 'UNSUPPORTED_PRODUCT_COPY', 'INVALID_PILOT_MESSAGE', 'CONTEXT_CHANGED'].includes(failure.code)) await this.store.discardDraft(owner, claimed.id, operation.id, contextHash, operation.leaseToken!);
    }
    let persistEvidence = results.length > 0;
    for (let attempt = 0; attempt < 5; attempt++) {
      const current = await this.store.read(owner, claimed.id);
      if (current.operation?.id !== operation.id || current.operation.leaseToken !== operation.leaseToken) return current;
      const version = current.version;
      const active = current.operation;
      if (contextHash && await hash(synthesisIdentity(this.env, active, current.evidence.filter(record => record.runId === operation.id), current)) !== contextHash) {
        failure = new AppError(409, 'CONTEXT_CHANGED', 'The campaign context changed. Your research is saved. Retry with the latest notes and decisions.'); generation = null; publication = undefined;
        await this.store.discardDraft(owner, claimed.id, operation.id, contextHash, operation.leaseToken!);
      }
      const failureCode = failure?.code;
      if (failureCode && !measurements.some(measurement => measurement.status === 'failed' && measurement.stage === failureStage && measurement.failureCode === failureCode)) measurements.push({ stage: failureStage, startedAt: now(), durationMs: 0, status: 'failed', failureCode, requests: 0 });
      active.measurementsTruncated ||= (active.measurements?.length ?? 0) + measurements.length > 80; active.measurements = [...(active.measurements ?? []), ...measurements].slice(-80);
      active.leaseToken = null; active.leaseUntil = 0;
      for (const result of results) {
        const step = active.steps.find(s => s.id === result.stepId)!;
        if (result.failure) { step.status = 'failed'; step.error = result.failure.message; }
        else if (persistEvidence) {
          step.status = 'complete'; step.error = result.evidence.length ? null : 'Qloo returned no usable entities for this category and reference. This evidence gap is excluded from synthesis.';
          step.evidenceIds = result.evidence.map(e => e.id); current.evidence.push(...result.evidence);
        }
      }
      if (failure) {
        rememberValidationFailure(active, failure.code);
        active.state = 'failed'; active.error = failure.message; active.failureCode = failure.code; active.failureStage = failureStage; active.modelStage = failureStage === 'review' ? 'review' : 'generation'; current.status = 'error'; current.error = failure.message;
      } else if (results.length) {
        active.state = 'pending'; if (active.steps.every(s => s.status === 'complete')) active.phase = 'synthesis';
      } else if (generation) { generation.measurements = [...active.measurements]; generation.measurementsTruncated = active.measurementsTruncated; current.generations.push(generation); current.selectedDirectionId = null; current.operation = null; current.status = 'ready'; current.error = null; }
      try { await this.store.save(owner, version, current, undefined, generation ? publication : undefined); return current; }
      catch (error) {
        if (error instanceof AppError && error.code === 'STALE_VERSION') continue;
        if (error instanceof AppError && error.code === 'PROJECT_LIMIT' && (persistEvidence || generation)) { failure = error; persistEvidence = false; generation = null; continue; }
        throw error;
      }
    }
    return this.store.read(owner, claimed.id);
  }
}
