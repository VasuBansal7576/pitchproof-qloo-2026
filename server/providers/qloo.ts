import type { Category, Entity, Evidence, Operation, ResearchStep } from '../../lib/pitchproof-types';
import { fail, hash, now, uid } from '../errors';
import { providerJson, type ProviderObserver } from './http';
const BASE = 'https://hackathon.api.qloo.com';
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const string = (value: unknown, max = 500): string => typeof value === 'string' ? value.replace(/[\u0000-\u001f]/g, '').slice(0, max) : '';
function url(value: unknown): string | null { const candidate = typeof value === 'string' ? value : object(value).url; if (typeof candidate !== 'string' || candidate.length > 1000) return null; try { const u = new URL(candidate); return ['https:', 'http:'].includes(u.protocol) ? u.href : null; } catch { return null; } }
export function normalizeEntity(value: unknown): Entity | null {
  const row = object(value); const properties = object(row.properties);
  const id = string(row.entity_id ?? row.id, 100); const name = string(row.name, 160);
  if (!id || !/^[\w:-]+$/.test(id) || !name) return null;
  const rawType = Array.isArray(row.types) ? row.types[0] : row.type;
  return { id, name, type: string(rawType, 100), description: string(properties.description ?? row.description, 500), image: url(properties.image ?? row.image), url: url(properties.url ?? properties.website ?? row.url) };
}
export function qlooEntities(value: unknown): unknown[] {
  const response = object(value); const results = response.results;
  if (Array.isArray(results)) return results;
  const entities = object(results).entities;
  if (Array.isArray(entities)) return entities;
  fail(502, 'QLOO_RESPONSE', 'Qloo did not return a supported entity list.');
}
export function insightsParameters(category: Category, seedIds: string[], market: string): Record<string, string> {
  const params: Record<string, string> = { 'filter.type': `urn:entity:${category}`, 'signal.interests.entities': seedIds.join(','), take: '6' };
  if (category === 'place' && market.trim()) params['filter.location.query'] = market.trim();
  return params;
}
export function normalizeEvidence(value: unknown, operation: Operation, step: ResearchStep): Evidence[] {
  const parameters = insightsParameters(step.category, step.seedIds, operation.brief.market);
  const seen = new Set<string>();
  return qlooEntities(value).slice(0, 6).flatMap((raw, index) => {
    const entity = normalizeEntity(raw); if (!entity || seen.has(entity.id)) return []; seen.add(entity.id);
    const query = object(object(raw).query); const direct = query.affinity; const nested = object(query.measurements).affinity;
    const score = typeof direct === 'number' && Number.isFinite(direct) ? { value: direct, metric: 'query.affinity' } : typeof nested === 'number' && Number.isFinite(nested) ? { value: nested, metric: 'query.measurements.affinity' } : null;
    const proxy = step.seedRoles.some(role => role !== 'audience');
    return [{ id: uid(), runId: operation.id, category: step.category, entity, rank: index + 1, score, observation: `${entity.name} ranked ${index + 1} for ${step.seedNames.join(', ')}. ${proxy ? 'Competitor and aesthetic inputs are exploratory taste proxies, not measured customers.' : 'The audience reference is a taste hypothesis, not a sampled customer segment.'} ${score ? 'The returned affinity metric is an association score, not a probability or causal result.' : 'No supported affinity score was returned.'}`, collectedAt: now(), context: { referenceNames: [...step.seedNames], referenceIds: [...step.seedIds], referenceRoles: [...step.seedRoles], market: operation.brief.market, geographyApplied: step.category === 'place' && !!operation.brief.market.trim(), parameters, endpoint: `${BASE}/v2/insights` } }];
  });
}
const cache = new Map<string, { json: string; expiresAt: number }>();
async function qlooResponse(endpoint: URL, key: string, notFoundIsEmpty: boolean, observe?: ProviderObserver): Promise<unknown> {
  const cacheKey = await hash(JSON.stringify({ method: 'GET', url: endpoint.href, headers: { 'X-Api-Key': key, Accept: 'application/json' } }));
  const entry = cache.get(cacheKey);
  if (entry && entry.expiresAt > Date.now()) {
    try { observe?.({ startedAt: now(), durationMs: 0, status: 'success', failureCode: null, requests: 0 }); } catch {}
    return JSON.parse(entry.json);
  }
  cache.delete(cacheKey);
  let httpStatus: number | undefined;
  const response = await providerJson(endpoint, { headers: { 'X-Api-Key': key, Accept: 'application/json' } }, 'Qloo', 20_000, notFoundIsEmpty, measurement => {
    httpStatus = measurement.httpStatus;
    observe?.(measurement);
  });
  qlooEntities(response);
  const json = JSON.stringify(response);
  if (httpStatus !== undefined && httpStatus >= 200 && httpStatus < 300 && new TextEncoder().encode(json).length <= 100_000) {
    if (cache.size >= 50) cache.delete(cache.keys().next().value!);
    cache.set(cacheKey, { json, expiresAt: Date.now() + 900_000 });
  }
  return response;
}
export async function searchQloo(key: string | undefined, query: string): Promise<Entity[]> {
  if (!key?.trim()) fail(503, 'QLOO_NOT_CONFIGURED', 'Cultural research is not connected yet. Your brief is saved. Open provider setup or contact the workspace owner.');
  const endpoint = new URL('/search', BASE); endpoint.search = new URLSearchParams({ query, types: 'urn:entity:brand', take: '5' }).toString();
  const response = await qlooResponse(endpoint, key, true);
  const seen = new Set<string>(); return qlooEntities(response).slice(0, 5).flatMap(raw => { const entity = normalizeEntity(raw); if (!entity || seen.has(entity.id)) return []; seen.add(entity.id); return [entity]; });
}
export async function researchQloo(key: string | undefined, operation: Operation, step: ResearchStep, observe?: ProviderObserver): Promise<Evidence[]> {
  if (!key?.trim()) fail(503, 'QLOO_NOT_CONFIGURED', 'Cultural research is not connected yet. Your brief is saved. Open provider setup or contact the workspace owner.');
  const endpoint = new URL('/v2/insights', BASE); endpoint.search = new URLSearchParams(insightsParameters(step.category, step.seedIds, operation.brief.market)).toString();
  const result = normalizeEvidence(await qlooResponse(endpoint, key, false, observe), operation, step);
  return result;
}
