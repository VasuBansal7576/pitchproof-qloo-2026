import { env } from 'cloudflare:workers';
import type { Configuration } from '../lib/pitchproof-types';
import { fail, safeFailure } from './errors';
import { assertSameOrigin, requestJson, resolveActor, type Actor } from './identity';
import { PitchProof } from './pitchproof';
import { modelConfiguration } from './providers/synthesis';
import { Store } from './store';
export type ApiContext = { actor: Actor; service: PitchProof; body: unknown };
export function configuration(): Configuration { const model = modelConfiguration(env); return { qlooConfigured: !!env.QLOO_API_KEY?.trim(), modelConfigured: model.configured, modelName: model.model, modelProvider: model.provider, storageConfigured: !!env.DB }; }
export async function api(request: Request, work: (context: ApiContext) => Promise<unknown | Response>): Promise<Response> {
  let actor: Actor | undefined;
  try {
    let body: unknown = null;
    if (!['GET', 'HEAD'].includes(request.method)) { assertSameOrigin(request); body = await requestJson(request); }
    if (!env.DB) fail(503, 'STORAGE_NOT_CONFIGURED', 'Project storage is not configured. Bind the Cloudflare D1 database as DB.');
    actor = await resolveActor(request, env.DB);
    const result = await work({ actor, service: new PitchProof(new Store(env.DB), env), body });
    const response = result instanceof Response ? result : Response.json(result);
    response.headers.set('Cache-Control', 'private, no-store'); response.headers.set('X-Content-Type-Options', 'nosniff');
    if (actor.cookie) response.headers.set('Set-Cookie', actor.cookie);
    return response;
  } catch (error) {
    const failure = safeFailure(error);
    const response = Response.json({ error: failure.message, code: failure.code }, { status: failure.status, headers: { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' } });
    if (actor?.cookie) response.headers.set('Set-Cookie', actor.cookie);
    return response;
  }
}
export type IdContext = { params: Promise<{ id: string }> | { id: string } };
export async function projectId(context: IdContext): Promise<string> { const { id } = await context.params; if (!/^[a-zA-Z0-9-]{1,100}$/.test(id)) fail(404, 'NOT_FOUND', 'Project not found.'); return id; }
