import { AppError, fail } from '../errors';
import type { StageMeasurement } from '../../lib/pitchproof-types';

export type ProviderObserver = (measurement: Omit<StageMeasurement, 'stage'>) => void;

const rejections = {
  'schema-too-complex': { code: 'PROVIDER_SCHEMA_TOO_COMPLEX', message: 'rejected a response schema that is too complex. Simplify the configured output schema.' },
  'invalid-schema': { code: 'PROVIDER_INVALID_SCHEMA', message: 'rejected the configured response schema. Check its supported schema format.' },
  'unsupported-parameter': { code: 'PROVIDER_UNSUPPORTED_PARAMETER', message: 'rejected an unsupported request parameter. Check the model request configuration.' },
  'unsupported-model-endpoint': { code: 'PROVIDER_UNSUPPORTED_MODEL_ENDPOINT', message: 'does not support the configured model or endpoint. Check the model and API version.' },
  'other-bad-request': { code: 'PROVIDER_BAD_REQUEST', message: 'rejected the request (HTTP 400). Check the provider request configuration.' },
} as const;
type RejectionCategory = keyof typeof rejections;

function rejectionCategory(message: string): RejectionCategory {
  if (/schema/i.test(message) && /too complex|complexity|too many|exceed.{0,80}(?:limit|size)|too large/i.test(message)) return 'schema-too-complex';
  if (/schema/i.test(message) && /invalid|unsupported|not supported|malformed/i.test(message)) return 'invalid-schema';
  if (/(?:model|endpoint|api version)/i.test(message) && /not found|unsupported|not supported|does not support|not available/i.test(message) && !/parameter|temperature|top[_ -]?p|top[_ -]?k/i.test(message)) return 'unsupported-model-endpoint';
  if (/parameter|temperature|top[_ -]?p|top[_ -]?k|unknown name|unknown field/i.test(message) && /unsupported|not supported|does not support|deprecated|unknown|not allowed/i.test(message)) return 'unsupported-parameter';
  return 'other-bad-request';
}

async function rejectionMessage(response: Response, readBytes: (size: number) => void): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return '';
  let size = 0;
  const parts: Uint8Array[] = [];
  while (true) {
    const result = await reader.read();
    if (result.done) break;
    readBytes(result.value.byteLength);
    size += result.value.length;
    if (size > 16_384) { await reader.cancel(); return ''; }
    parts.push(result.value);
  }
  const merged = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) { merged.set(part, offset); offset += part.length; }
  try {
    const payload: unknown = JSON.parse(new TextDecoder().decode(merged));
    if (!payload || typeof payload !== 'object') return '';
    const error = 'error' in payload ? payload.error : payload;
    if (!error || typeof error !== 'object') return '';
    const descriptions: string[] = [];
    if ('message' in error && typeof error.message === 'string') descriptions.push(error.message);
    if ('details' in error && Array.isArray(error.details)) {
      for (const detail of error.details) {
        if (!detail || typeof detail !== 'object' || !Array.isArray(detail.fieldViolations)) continue;
        for (const violation of detail.fieldViolations) {
          if (violation && typeof violation === 'object' && typeof violation.description === 'string') descriptions.push(violation.description);
        }
      }
    }
    return descriptions.join(' ');
  } catch { return ''; }
}

function requestBodyBytes(body: RequestInit['body']): number | undefined {
  if (body == null) return 0;
  if (typeof body === 'string') return new TextEncoder().encode(body).byteLength;
  if (body instanceof URLSearchParams) return new TextEncoder().encode(body.toString()).byteLength;
  if (body instanceof Blob) return body.size;
  if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) return body.byteLength;
  return undefined;
}

const failureCodes = new Set<string>([
  ...Object.values(rejections).map(rejection => rejection.code),
  'PROVIDER_REDIRECT', 'PROVIDER_RATE_LIMIT', 'PROVIDER_AUTH', 'PROVIDER_ERROR',
  'PROVIDER_RESPONSE', 'PROVIDER_TIMEOUT', 'PROVIDER_UNAVAILABLE',
]);

export async function providerJson(url: URL, init: RequestInit, provider: string, timeout = 20_000, notFoundIsEmpty = false, observe?: ProviderObserver): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  const startedAt = new Date().toISOString();
  const start = performance.now();
  const inputBytes = requestBodyBytes(init.body);
  let outputBytes = 0;
  let httpStatus: number | undefined;
  let failureCode: string | null = null;
  try {
    // Workers supports manual/follow only. Never forward a provider credential
    // through a redirect, including a redirect to another provider-owned host.
    const response = await fetch(url, { ...init, signal: controller.signal, redirect: 'manual' });
    httpStatus = response.status;
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      fail(502, 'PROVIDER_REDIRECT', `${provider} returned an unexpected redirect. Check its configured endpoint.`);
    }
    if (response.status === 404 && notFoundIsEmpty) return { results: [] };
    if (response.status === 429) fail(429, 'PROVIDER_RATE_LIMIT', `${provider} is rate limited. Retry this step later.`);
    if (response.status === 401 || response.status === 403) fail(502, 'PROVIDER_AUTH', `${provider} rejected its server credential. Check the configured key.`);
    if (response.status === 400) {
      const message = await rejectionMessage(response, size => { outputBytes += size; });
      const category = rejectionCategory(message);
      const rejection = rejections[category];
      console.warn({ code: rejection.code, category });
      fail(502, rejection.code, `${provider} ${rejection.message}`);
    }
    if (!response.ok) fail(502, 'PROVIDER_ERROR', `${provider} could not complete this request (HTTP ${response.status}).`);
    const reader = response.body?.getReader();
    if (!reader) fail(502, 'PROVIDER_RESPONSE', `${provider} returned an empty response.`);
    let size = 0; const parts: Uint8Array[] = [];
    while (true) { const result = await reader.read(); if (result.done) break; outputBytes += result.value.byteLength; size += result.value.length; if (size > 1_000_000) { await reader.cancel(); fail(502, 'PROVIDER_RESPONSE', `${provider} response exceeded the limit.`); } parts.push(result.value); }
    const merged = new Uint8Array(size); let offset = 0; for (const part of parts) { merged.set(part, offset); offset += part.length; }
    try { return JSON.parse(new TextDecoder().decode(merged)); } catch { fail(502, 'PROVIDER_RESPONSE', `${provider} returned invalid JSON.`); }
  } catch (error) {
    if (error instanceof AppError) {
      failureCode = failureCodes.has(error.code) ? error.code : 'PROVIDER_ERROR';
      throw error;
    }
    failureCode = controller.signal.aborted ? 'PROVIDER_TIMEOUT' : 'PROVIDER_UNAVAILABLE';
    fail(502, failureCode, controller.signal.aborted ? `${provider} timed out. Retry this step.` : `${provider} is unavailable. Retry this step.`);
  } finally {
    clearTimeout(timer);
    controller.abort();
    try {
      observe?.(Object.freeze({
        startedAt, durationMs: Math.max(0, performance.now() - start),
        status: failureCode === null ? 'success' : 'failed', failureCode, requests: 1,
        ...(inputBytes === undefined ? {} : { inputBytes }), outputBytes,
        ...(httpStatus === undefined ? {} : { httpStatus }),
      }));
    } catch {}
  }
}
