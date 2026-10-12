import { config } from './config';
import { sameOrigin } from './auth/policy';
import { apiError, currentPrincipal } from './auth/session';
import { auditDenied } from './audit';

/**
 * Guard for JSON mutations: exact Origin (CSRF) and a JSON body. A cross-site form cannot send
 * application/json without a CORS preflight, which this API never grants.
 */
export async function jsonMutation(request: Request): Promise<unknown | Response> {
 if (!sameOrigin(request.headers.get('origin'), config().RESOLVE_ORIGIN)) return crossOrigin(request);
 if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) return apiError(400, 'JSON_REQUIRED', 'Send a JSON body.');
 try { return await request.json(); } catch { return apiError(400, 'INVALID_JSON', 'The request body is not valid JSON.'); }
}

/** Refuse and audit a state-changing request from another origin (the cookie owner, if any, is recorded). */
export async function crossOrigin(request: Request) {
 await auditDenied(request, (await currentPrincipal(request))?.userId ?? null, 'cross_origin', { origin: request.headers.get('origin') ?? 'none' });
 return apiError(403, 'CROSS_ORIGIN', 'Request origin is not allowed.');
}

export const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
export const problem = (status: number, code: string, message: string) => json({ error: { code, message, requestId: crypto.randomUUID() } }, status);
