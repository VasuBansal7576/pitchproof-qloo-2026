import { index, integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';
export const projects = sqliteTable('projects', {
  id: text('id').primaryKey(), ownerId: text('owner_id').notNull(), version: integer('version').notNull(), snapshotJson: text('snapshot_json').notNull(), updatedAt: text('updated_at').notNull(),
}, table => [index('projects_owner_updated').on(table.ownerId, table.updatedAt)]);
export const sessions = sqliteTable('sessions', { tokenHash: text('token_hash').primaryKey(), ownerId: text('owner_id').notNull(), expiresAt: integer('expires_at').notNull() });
export const commandReceipts = sqliteTable('command_receipts', { projectId: text('project_id').notNull().references(() => projects.id), ownerId: text('owner_id').notNull(), commandId: text('command_id').notNull(), requestHash: text('request_hash').notNull(), resultVersion: integer('result_version').notNull(), createdAt: text('created_at').notNull() }, table => [primaryKey({ columns: [table.projectId, table.commandId] })]);
export const referenceCandidates = sqliteTable('reference_candidates', { tokenHash: text('token_hash').primaryKey(), ownerId: text('owner_id').notNull(), projectId: text('project_id').notNull().references(() => projects.id), slot: integer('slot').notNull(), inputHash: text('input_hash').notNull(), query: text('query').notNull(), entityJson: text('entity_json').notNull(), expiresAt: integer('expires_at').notNull() }, table => [index('candidates_expiry').on(table.expiresAt)]);
export const providerUsage = sqliteTable('provider_usage', { ownerId: text('owner_id').notNull(), day: text('day').notNull(), calls: integer('calls').notNull() }, table => [primaryKey({ columns: [table.ownerId, table.day] })]);
export const synthesisDrafts = sqliteTable('synthesis_drafts', {
  ownerId: text('owner_id').notNull(), projectId: text('project_id').notNull().references(() => projects.id), operationId: text('operation_id').notNull(), contextHash: text('context_hash').notNull(), payloadJson: text('payload_json').notNull(), expiresAt: integer('expires_at').notNull(),
}, table => [primaryKey({ columns: [table.ownerId, table.projectId, table.operationId] }), index('synthesis_drafts_expiry').on(table.expiresAt)]);
export const providerReservations = sqliteTable('provider_reservations', {
  ownerId: text('owner_id').notNull(), reservationId: text('reservation_id').notNull(), day: text('day').notNull(), units: integer('units').notNull(),
}, table => [primaryKey({ columns: [table.ownerId, table.reservationId] })]);
