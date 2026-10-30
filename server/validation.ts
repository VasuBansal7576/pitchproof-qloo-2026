import { z } from 'zod';
import { TEXT_LIMITS, type Brief, type CommandEnvelope, type ReferenceRole } from '../lib/pitchproof-types';
import { fail } from './errors';
const text = (max: number) => z.string().trim().max(max);
const sourceUrl = text(300).refine(v => !v || /^https?:\/\//i.test(v), 'Use an http or https source URL.');
const productFacts = z.array(z.object({ id: z.string().regex(/^F[1-8]$/), text: text(300).min(1), source: z.literal('user_supplied'), sourceUrl: sourceUrl.nullable() }).strict()).max(8).refine(facts => new Set(facts.map(fact => fact.id)).size === facts.length, 'Product fact IDs must be unique.');
export const briefSchema = z.object({ product: text(TEXT_LIMITS.product), description: text(TEXT_LIMITS.description), category: text(TEXT_LIMITS.category), market: text(TEXT_LIMITS.market), audience: text(TEXT_LIMITS.audience), objective: text(TEXT_LIMITS.objective), constraints: text(TEXT_LIMITS.constraints), website: sourceUrl, productFacts: productFacts.optional(), callToAction: text(180).optional() }).strict();
export const referencesSchema = z.array(z.object({ query: text(TEXT_LIMITS.reference).min(1), role: z.enum(['competitor', 'aesthetic', 'audience']) }).strict()).length(3);
const direction = z.string().min(1).max(100);
const commandSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('update_brief'), brief: briefSchema, references: referencesSchema }),
  z.object({ action: z.literal('confirm_reference'), slot: z.number().int().min(0).max(2), token: z.string().regex(/^[a-f0-9]{64}$/) }),
  ...(['start_research', 'advance', 'retry', 'cancel'] as const).map(action => z.object({ action: z.literal(action) })),
  z.object({ action: z.literal('revise'), directionId: direction, feedback: text(TEXT_LIMITS.feedback).min(8) }),
  z.object({ action: z.literal('choose'), directionId: direction }),
  z.object({ action: z.literal('reject'), directionId: direction, reason: text(TEXT_LIMITS.feedback).min(1) }),
  z.object({ action: z.literal('accept'), directionId: direction }),
  z.object({ action: z.literal('annotate'), targetId: direction, text: text(TEXT_LIMITS.annotation) }),
] as [z.ZodDiscriminatedUnionOption<'action'>, ...z.ZodDiscriminatedUnionOption<'action'>[]]);
export type ProjectInput = { brief: Brief; references: { query: string; role: ReferenceRole }[] };
export function parseProjectInput(value: unknown): ProjectInput { return parse(z.object({ brief: briefSchema, references: referencesSchema }).strict(), value) as ProjectInput; }
export function parseCommand(value: unknown): CommandEnvelope {
  const control = parse(z.object({ expectedVersion: z.number().int().nonnegative(), commandId: z.string().min(8).max(100).regex(/^[\w-]+$/) }).passthrough(), value);
  const { expectedVersion, commandId, ...command } = control;
  return { ...parse(commandSchema, command), expectedVersion, commandId } as CommandEnvelope;
}
export function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) fail(400, 'INVALID_INPUT', result.error.issues[0]?.message ?? 'Invalid request.');
  return result.data;
}
export function parseSearch(value: unknown): { slot: number; query: string } { return parse(z.object({ slot: z.number().int().min(0).max(2), query: text(TEXT_LIMITS.reference).min(1) }).strict(), value); }
