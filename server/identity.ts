import { fail, hash, randomToken, uid } from './errors';
const COOKIE = 'pitchproof_session';
export type Actor = { owner: string; cookie: string | null };
export function assertSameOrigin(request: Request): void {
  const origin = request.headers.get('origin');
  const target = new URL(request.url);
  if (!origin || origin !== target.origin || request.headers.get('sec-fetch-site') === 'cross-site') fail(403, 'CROSS_ORIGIN', 'This action must come from the PitchProof site.');
  if (!(request.headers.get('content-type') ?? '').toLowerCase().startsWith('application/json')) fail(415, 'CONTENT_TYPE', 'Use an application/json request.');
}
export async function resolveActor(request: Request, db: D1Database): Promise<Actor> {
  const platformId = request.headers.get('oai-authenticated-user-id');
  const platformEmail = request.headers.get('oai-authenticated-user-email');
  if (platformId && platformEmail && platformId.length < 500) return { owner: `platform:${await hash(platformId)}`, cookie: null };
  const token = request.headers.get('cookie')?.split(';').map(x => x.trim()).find(x => x.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);
  if (token && /^[a-f0-9]{64}$/.test(token)) {
    const row = await db.prepare('SELECT owner_id FROM sessions WHERE token_hash = ? AND expires_at > ?').bind(await hash(token), Date.now()).first<{ owner_id: string }>();
    if (row) return { owner: row.owner_id, cookie: null };
  }
  const secret = randomToken(); const owner = `visitor:${uid()}`;
  await db.prepare('INSERT INTO sessions (token_hash, owner_id, expires_at) VALUES (?, ?, ?)').bind(await hash(secret), owner, Date.now() + 30 * 86400_000).run();
  const secure = new URL(request.url).protocol === 'https:' ? '; Secure' : '';
  return { owner, cookie: `${COOKIE}=${secret}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000${secure}` };
}
export async function requestJson(request: Request): Promise<unknown> {
  const declared = Number(request.headers.get('content-length') || '0');
  if (declared > 16_384) fail(413, 'BODY_TOO_LARGE', 'Request body exceeds 16 KB.');
  const reader = request.body?.getReader(); if (!reader) fail(400, 'INVALID_JSON', 'A JSON body is required.');
  const parts: Uint8Array[] = []; let size = 0;
  while (true) { const result = await reader.read(); if (result.done) break; size += result.value.length; if (size > 16_384) { await reader.cancel(); fail(413, 'BODY_TOO_LARGE', 'Request body exceeds 16 KB.'); } parts.push(result.value); }
  const bytes = new Uint8Array(size); let offset = 0; for (const part of parts) { bytes.set(part, offset); offset += part.length; }
  try { return JSON.parse(new TextDecoder().decode(bytes)); } catch { fail(400, 'INVALID_JSON', 'The request body must be valid JSON.'); }
}
