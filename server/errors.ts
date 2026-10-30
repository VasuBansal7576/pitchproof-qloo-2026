export class AppError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}
export function fail(status: number, code: string, message: string): never { throw new AppError(status, code, message); }
export function safeFailure(error: unknown): AppError {
  return error instanceof AppError ? error : new AppError(500, 'INTERNAL_ERROR', 'The request could not be completed. Please try again.');
}
export const uid = () => crypto.randomUUID();
export const now = () => new Date().toISOString();
export async function hash(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes), x => x.toString(16).padStart(2, '0')).join('');
}
export function randomToken(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)), x => x.toString(16).padStart(2, '0')).join('');
}
