import { projectSummary, type Entity, type Project, type ProjectSummary } from '../lib/pitchproof-types';
import { fail, hash, now } from './errors';
export type DraftFence = { operationId: string; leaseToken: string; contextHash: string };
type Reservation = { id: string; projectId: string; operationId: string; leaseToken: string };
export class Store {
  constructor(readonly db: D1Database) {}
  async read(owner: string, id: string): Promise<Project> {
    const row = await this.db.prepare('SELECT snapshot_json FROM projects WHERE id = ? AND owner_id = ?').bind(id, owner).first<{ snapshot_json: string }>();
    if (!row) fail(404, 'NOT_FOUND', 'Project not found.');
    return JSON.parse(row.snapshot_json) as Project;
  }
  async list(owner: string): Promise<ProjectSummary[]> {
    const rows = await this.db.prepare('SELECT snapshot_json FROM projects WHERE owner_id = ? ORDER BY updated_at DESC LIMIT 20').bind(owner).all<{ snapshot_json: string }>();
    return rows.results.map(row => projectSummary(JSON.parse(row.snapshot_json) as Project));
  }
  serialize(project: Project): string {
    const json = JSON.stringify(project);
    if (new TextEncoder().encode(json).length > 200_000 || project.evidence.length > 180 || project.generations.length > 8 || project.decisions.length > 100 || (project.acceptances?.length ?? 0) > 100 || Object.keys(project.annotations).length > 100) fail(422, 'PROJECT_LIMIT', 'This project reached its history limit. Create a new project for more research.');
    return json;
  }
  async create(owner: string, project: Project): Promise<void> {
    const result = await this.db.prepare('INSERT INTO projects (id, owner_id, version, snapshot_json, updated_at) SELECT ?, ?, ?, ?, ? WHERE (SELECT COUNT(*) FROM projects WHERE owner_id = ?) < 20').bind(project.id, owner, project.version, this.serialize(project), project.updatedAt, owner).run();
    if (!result.meta.changes) fail(422, 'PROJECT_LIMIT', 'You can keep up to 20 projects.');
  }
  async receipt(owner: string, id: string, commandId: string, requestHash: string): Promise<boolean> {
    const row = await this.db.prepare('SELECT request_hash FROM command_receipts WHERE project_id = ? AND owner_id = ? AND command_id = ?').bind(id, owner, commandId).first<{ request_hash: string }>();
    if (!row) return false;
    if (row.request_hash !== requestHash) fail(409, 'COMMAND_REUSED', 'This command ID was already used for a different request.');
    return true;
  }
  async save(owner: string, previousVersion: number, project: Project, receipt?: { commandId: string; requestHash: string }, publication?: DraftFence): Promise<void> {
    project.version = previousVersion + 1;
    project.updatedAt = now();
    const guard = publication ? " AND json_extract(snapshot_json, '$.operation.id') = ? AND json_extract(snapshot_json, '$.operation.leaseToken') = ? AND EXISTS (SELECT 1 FROM synthesis_drafts WHERE owner_id = ? AND project_id = ? AND operation_id = ? AND context_hash = ? AND expires_at > ?)" : '';
    const values: (string | number)[] = [project.version, this.serialize(project), project.updatedAt, project.id, owner, previousVersion];
    if (publication) values.push(publication.operationId, publication.leaseToken, owner, project.id, publication.operationId, publication.contextHash, Date.now());
    const update = this.db.prepare('UPDATE projects SET version = ?, snapshot_json = ?, updated_at = ? WHERE id = ? AND owner_id = ? AND version = ?' + guard).bind(...values);
    if (publication) {
      const results = await this.db.batch([update, this.db.prepare('DELETE FROM synthesis_drafts WHERE changes() = 1 AND owner_id = ? AND project_id = ? AND operation_id = ? AND context_hash = ?').bind(owner, project.id, publication.operationId, publication.contextHash)]);
      if (!results[0].meta.changes) fail(409, 'STALE_VERSION', 'The project changed. Reload it and try again.');
    } else if (receipt) {
      const results = await this.db.batch([update, this.db.prepare('INSERT INTO command_receipts (project_id, owner_id, command_id, request_hash, result_version, created_at) SELECT ?, ?, ?, ?, ?, ? WHERE changes() = 1').bind(project.id, owner, receipt.commandId, receipt.requestHash, project.version, now())]);
      if (!results[0].meta.changes) fail(409, 'STALE_VERSION', 'The project changed. Reload it and try again.');
    } else {
      const result = await update.run();
      if (!result.meta.changes) fail(409, 'STALE_VERSION', 'The project changed. Reload it and try again.');
    }
  }
  async draft(owner: string, projectId: string, operationId: string): Promise<{ contextHash: string; payload: unknown } | null> {
    const row = await this.db.prepare('SELECT context_hash, payload_json FROM synthesis_drafts WHERE owner_id = ? AND project_id = ? AND operation_id = ? AND expires_at > ?').bind(owner, projectId, operationId, Date.now()).first<{ context_hash: string; payload_json: string }>();
    if (!row) return null;
    try { return { contextHash: row.context_hash, payload: JSON.parse(row.payload_json) }; } catch { return null; }
  }
  async saveDraft(owner: string, previousVersion: number, project: Project, contextHash: string, payload: unknown): Promise<void> {
    const operation = project.operation;
    if (!operation?.leaseToken) fail(409, 'OPERATION_OBSOLETE', 'This operation is no longer active.');
    const json = JSON.stringify(payload);
    if (new TextEncoder().encode(json).length > 100_000) fail(422, 'DRAFT_LIMIT', 'The generated draft is too large. Shorten the brief and retry.');
    project.version = previousVersion + 1; project.updatedAt = now();
    const results = await this.db.batch([
      this.db.prepare("UPDATE projects SET version = ?, snapshot_json = ?, updated_at = ? WHERE id = ? AND owner_id = ? AND version = ? AND json_extract(snapshot_json, '$.operation.id') = ? AND json_extract(snapshot_json, '$.operation.leaseToken') = ?").bind(project.version, this.serialize(project), project.updatedAt, project.id, owner, previousVersion, operation.id, operation.leaseToken),
      this.db.prepare('INSERT INTO synthesis_drafts(owner_id,project_id,operation_id,context_hash,payload_json,expires_at) SELECT ?,?,?,?,?,? WHERE changes() = 1 ON CONFLICT(owner_id,project_id,operation_id) DO UPDATE SET context_hash=excluded.context_hash,payload_json=excluded.payload_json,expires_at=excluded.expires_at').bind(owner, project.id, operation.id, contextHash, json, Date.now() + 86_400_000),
    ]);
    if (!results[0].meta.changes) fail(409, 'STALE_VERSION', 'The project changed while generating. Retry with the latest context.');
  }
  async discardDraft(owner: string, projectId: string, operationId: string, contextHash?: string, leaseToken?: string): Promise<void> {
    let query = 'DELETE FROM synthesis_drafts WHERE owner_id = ? AND project_id = ? AND operation_id = ?';
    const values = [owner, projectId, operationId];
    if (contextHash) { query += ' AND context_hash = ?'; values.push(contextHash); }
    if (leaseToken) {
      query += " AND EXISTS (SELECT 1 FROM projects WHERE id = ? AND owner_id = ? AND json_extract(snapshot_json, '$.operation.id') = ? AND json_extract(snapshot_json, '$.operation.leaseToken') = ?)";
      values.push(projectId, owner, operationId, leaseToken);
    }
    await this.db.prepare(query).bind(...values).run();
  }
  async budget(owner: string, units = 1, reservation?: Reservation, unlimited = false): Promise<boolean> {
    if (!Number.isInteger(units) || units < 1 || units > 2) fail(500, 'INVALID_BUDGET', 'Invalid provider reservation.');
    const day = now().slice(0, 10);
    const ownerLimit = unlimited ? Number.MAX_SAFE_INTEGER : 120;
    const siteLimit = unlimited ? Number.MAX_SAFE_INTEGER : 500;
    const existing = reservation ? await this.db.prepare('SELECT units FROM provider_reservations WHERE owner_id = ? AND reservation_id = ?').bind(owner, reservation.id).first<{ units: number }>() : null;
    if (existing) { if (existing.units !== units) fail(409, 'RESERVATION_REUSED', 'This provider reservation was reused incorrectly.'); return false; }
    const fence = reservation ? " AND NOT EXISTS (SELECT 1 FROM provider_reservations WHERE owner_id = ? AND reservation_id = ?) AND EXISTS (SELECT 1 FROM projects WHERE id = ? AND owner_id = ? AND json_extract(snapshot_json, '$.operation.id') = ? AND json_extract(snapshot_json, '$.operation.leaseToken') = ? AND json_extract(snapshot_json, '$.operation.leaseUntil') > ?)" : '';
    const admission: (string | number)[] = ['__site_total__', day, units, owner, day, ownerLimit - units];
    if (reservation) admission.push(owner, reservation.id, reservation.projectId, owner, reservation.operationId, reservation.leaseToken, Date.now());
    admission.push(siteLimit - units);
    const results = await this.db.batch([
      this.db.prepare('INSERT INTO provider_usage (owner_id, day, calls) SELECT ?, ?, ? WHERE COALESCE((SELECT calls FROM provider_usage WHERE owner_id = ? AND day = ?), 0) <= ?' + fence + ' ON CONFLICT(owner_id, day) DO UPDATE SET calls = calls + excluded.calls WHERE calls <= ?').bind(...admission),
      this.db.prepare('INSERT INTO provider_usage (owner_id, day, calls) SELECT ?, ?, ? WHERE changes() = 1 ON CONFLICT(owner_id, day) DO UPDATE SET calls = calls + excluded.calls').bind(owner, day, units),
      this.db.prepare('INSERT INTO provider_reservations(owner_id,reservation_id,day,units) SELECT ?,?,?,? WHERE changes() = 1 AND ? != ?').bind(owner, reservation?.id ?? '', day, units, reservation?.id ?? '', ''),
      this.db.prepare('DELETE FROM synthesis_drafts WHERE rowid IN (SELECT rowid FROM synthesis_drafts WHERE expires_at <= ? LIMIT 100)').bind(Date.now()),
      this.db.prepare('DELETE FROM provider_reservations WHERE rowid IN (SELECT rowid FROM provider_reservations WHERE day < ? LIMIT 100)').bind(new Date(Date.now() - 172_800_000).toISOString().slice(0, 10)),
    ]);
    if (!results[0].meta.changes) {
      if (reservation && await this.db.prepare('SELECT 1 FROM provider_reservations WHERE owner_id = ? AND reservation_id = ? AND units = ?').bind(owner, reservation.id, units).first()) return false;
      const usage = await this.db.prepare('SELECT calls FROM provider_usage WHERE owner_id = ? AND day = ?').bind(owner, day).first<{ calls: number }>();
      if ((usage?.calls ?? 0) >= ownerLimit) fail(429, 'DAILY_LIMIT', 'Your daily provider request limit has been reached.');
      if (reservation) {
        const current = await this.read(owner, reservation.projectId);
        if (current.operation?.id !== reservation.operationId || current.operation.leaseToken !== reservation.leaseToken || current.operation.leaseUntil <= Date.now()) fail(409, 'OPERATION_OBSOLETE', 'This operation is no longer active.');
      }
      if ((usage?.calls ?? 0) > ownerLimit - units) fail(429, 'DAILY_LIMIT', 'Your remaining provider allowance cannot cover this stage.');
      fail(429, 'SITE_DAILY_LIMIT', 'The site has reached its daily provider request limit. Please return tomorrow.');
    }
    return true;
  }
  async putCandidate(owner: string, project: Project, slot: number, query: string, entity: Entity, token: string): Promise<void> {
    await this.db.prepare('INSERT INTO reference_candidates (token_hash, owner_id, project_id, slot, input_hash, query, entity_json, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').bind(await hash(token), owner, project.id, slot, await hash(JSON.stringify({ brief: project.brief, reference: project.references[slot] })), query, JSON.stringify(entity), Date.now() + 600_000).run();
  }
  async candidate(owner: string, project: Project, slot: number, token: string): Promise<{ entity: Entity; query: string }> {
    const row = await this.db.prepare('SELECT entity_json, query FROM reference_candidates WHERE token_hash = ? AND owner_id = ? AND project_id = ? AND slot = ? AND input_hash = ? AND expires_at > ?').bind(await hash(token), owner, project.id, slot, await hash(JSON.stringify({ brief: project.brief, reference: project.references[slot] })), Date.now()).first<{ entity_json: string; query: string }>();
    if (!row) fail(400, 'EXPIRED_CANDIDATE', 'Search again to confirm a current reference candidate.');
    return { entity: JSON.parse(row.entity_json) as Entity, query: row.query };
  }
}
