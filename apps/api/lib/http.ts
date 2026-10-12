import { config } from './config';
import { sameOrigin } from './auth/policy';
import { apiError } from './auth/session';

/**
 * Guard for JSON mutations: exact Origin (CSRF) and a JSON body. A cross-site form cannot send
 * application/json without a CORS preflight, which this API never grants.
 */
export async function jsonMutation(request: Request): Promise<unknown | Response> {
 if (!sameOrigin(request.headers.get('origin'), config().RESOLVE_ORIGIN)) return apiError(403, 'CROSS_ORIGIN', 'Request origin is not allowed.');
 if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) return apiError(400, 'JSON_REQUIRED', 'Send a JSON body.');
 try { return await request.json(); } catch { return apiError(400, 'INVALID_JSON', 'The request body is not valid JSON.'); }
}

export const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
export const problem = (status: number, code: string, message: string) => json({ error: { code, message, requestId: crypto.randomUUID() } }, status);
