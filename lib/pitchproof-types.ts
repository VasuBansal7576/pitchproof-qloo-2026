export const CATEGORIES = ["brand", "artist", "movie", "place", "podcast"] as const;
export const TEXT_LIMITS = { product: 160, description: 2000, category: 160, market: 160, audience: 1000, objective: 1000, constraints: 1000, website: 300, reference: 150, feedback: 2000, annotation: 2000 } as const;
export type Category = (typeof CATEGORIES)[number];
export type ReferenceRole = "competitor" | "aesthetic" | "audience";
export type ProductFact = { id: string; text: string; source: "user_supplied"; sourceUrl: string | null };
export type StageMeasurement = { stage: "research" | "generation" | "review"; startedAt: string; durationMs: number; status: "success" | "failed"; failureCode: string | null; requests: number; inputBytes?: number; outputBytes?: number; httpStatus?: number; inputTokens?: number; outputTokens?: number };
export type PilotContract = { version: 1; shared: { baseEditId: string; soundtrackId: string; productFactIds: string[]; durationSeconds: 15; channel: string; audience: string; callToAction: string; landingPage: string }; arms: [{ message: string }, { message: string }] };
export type Brief = {
  product: string;
  description: string;
  category: string;
  market: string;
  audience: string;
  objective: string;
  constraints: string;
  website: string;
  productFacts?: ProductFact[];
  callToAction?: string;
};
export type Entity = {
  id: string;
  name: string;
  type: string;
  description: string;
  image: string | null;
  url: string | null;
};
export type Reference = {
  query: string;
  role: ReferenceRole;
  entity: Entity | null;
};
export type Candidate = { entity: Entity; token: string };
export type Evidence = {
  id: string;
  runId: string;
  category: Category;
  entity: Entity;
  rank: number;
  score: { value: number; metric: string } | null;
  observation: string;
  collectedAt: string;
  context: {
    referenceNames: string[];
    referenceIds: string[];
    referenceRoles: ReferenceRole[];
    market: string;
    geographyApplied: boolean;
    parameters: Record<string, string>;
    endpoint: string;
  };
};
export const REVIEW_WARNING_CODES = ['feedback_conflict', 'unsupported_claim', 'weak_campaign', 'evidence_gap', 'confounded_test'] as const;
export type ReviewWarning = typeof REVIEW_WARNING_CODES[number];
export type Direction = {
  id: string;
  title: string;
  hook: string;
  audienceHypothesis: string;
  strategy: string;
  productFactIds?: string[];
  campaign?: {
    device?: "participation" | "story" | "product_discovery";
    proposition: string;
    audienceTension: string;
    productRole: string;
    mechanism: string;
    execution: string;
    callToAction: string;
    evidenceBridge: { evidenceId: string; interpretation: string; relevance: string; uncertainty: string }[];
  };
  visuals: { description: string; palette: string[]; references: string[] };
  channels: string[];
  claims: { text: string; evidenceIds: string[] }[];
  unverifiedClaim?: true;
  reviewWarnings?: ReviewWarning[];
  testPlan: {
    hypothesis: string;
    variants: string[];
    metric: string;
    successCriterion: string;
    kind?: "concept" | "execution";
    variable?: string;
    controls?: string;
    budget?: string;
    minimumData?: string;
    inconclusive?: string;
    contract?: PilotContract;
  };
  limitations: string[];
};
export type Generation = {
  id: string;
  createdAt: string;
  model: string;
  directions: Direction[];
  evidenceIds: string[];
  parentDirectionId: string | null;
  feedback: string | null;
  brief: Brief;
  references?: Reference[];
  measurements?: StageMeasurement[];
  measurementsTruncated?: boolean;
  contractVersion?: string;
  runStartedAt?: string;
};
export type ResearchStep = {
  id: string;
  category: Category;
  seedIds: string[];
  seedNames: string[];
  seedRoles: ReferenceRole[];
  status: "pending" | "complete" | "failed";
  evidenceIds: string[];
  error: string | null;
};
export const VALIDATION_FEEDBACK_CODES = ['UNSUPPORTED_PRODUCT_COPY', 'MODEL_RESPONSE', 'INVALID_PILOT_MESSAGE', 'CAMPAIGN_REVIEW', 'INVALID_CITATIONS'] as const;
export type Operation = {
  id: string;
  kind: "research" | "revision";
  phase: "research" | "synthesis";
  state: "pending" | "running" | "failed";
  steps: ResearchStep[];
  brief: Brief;
  references: Reference[];
  feedback: string | null;
  parentDirectionId: string | null;
  leaseToken: string | null;
  leaseUntil: number;
  error: string | null;
  failureCode?: string | null;
  startedAt: string;
  modelStage?: "generation" | "review";
  failureStage?: "research" | "generation" | "review" | null;
  measurements?: StageMeasurement[];
  measurementsTruncated?: boolean;
  validationFeedback?: (typeof VALIDATION_FEEDBACK_CODES)[number][];
};
export type Project = {
  id: string;
  title: string;
  version: number;
  status: "draft" | "researching" | "ready" | "error";
  brief: Brief;
  references: Reference[];
  evidence: Evidence[];
  generations: Generation[];
  selectedDirectionId: string | null;
  decisions: { directionId: string; decision: "selected" | "rejected"; reason: string; createdAt: string }[];
  annotations: Record<string, string>;
  operation: Operation | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  researchStartedAt?: string;
  acceptances?: { generationId: string; directionId: string; createdAt: string; reviewedVersion: number; elapsedMs: number | null }[];
};
export type ProjectSummary = Pick<Project, "id" | "title" | "status" | "createdAt" | "updatedAt" | "version"> & {
  category: string;
  market: string;
  directionCount: number;
  evidenceCount: number;
};
export function projectSummary(project: Project): ProjectSummary {
  return { id: project.id, title: project.title, version: project.version, status: project.status, createdAt: project.createdAt, updatedAt: project.updatedAt, category: project.brief.category, market: project.brief.market, directionCount: project.generations.reduce((count, generation) => count + generation.directions.length, 0), evidenceCount: project.evidence.length };
}
export function mergeProjectSummaries(current: ProjectSummary[], incoming: ProjectSummary[]): ProjectSummary[] {
  const byId = new Map(current.map(project => [project.id, project]));
  for (const project of incoming) if (project.version >= (byId.get(project.id)?.version ?? -1)) byId.set(project.id, project);
  return [...byId.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 20);
}
export type Configuration = {
  qlooConfigured: boolean;
  modelConfigured: boolean;
  modelName: string;
  modelProvider: string;
  storageConfigured: boolean;
};
export type Command =
  | { action: "update_brief"; brief: Brief; references: { query: string; role: ReferenceRole }[] }
  | { action: "confirm_reference"; slot: number; token: string }
  | { action: "start_research" }
  | { action: "advance" }
  | { action: "retry" }
  | { action: "cancel" }
  | { action: "revise"; directionId: string; feedback: string }
  | { action: "choose"; directionId: string }
  | { action: "reject"; directionId: string; reason: string }
  | { action: "accept"; directionId: string }
  | { action: "annotate"; targetId: string; text: string };
export type CommandEnvelope = Command & { expectedVersion: number; commandId: string };
export type ApiFailure = { error: string; code: string; details?: unknown };
export const EMPTY_BRIEF: Brief = {
  product: "", description: "", category: "Running footwear", market: "", audience: "",
  objective: "Launch a new product", constraints: "", website: "", productFacts: [], callToAction: "",
};
export function latestGeneration(project: Project): Generation | null {
  return project.generations.at(-1) ?? null;
}
