import { actionToolArgs, actionToolResults, targetToolArgs, targetToolResults, type ActionTool, type RegistryApp, type TargetTool } from '@resolve/contracts';
import type { z } from 'zod';
import { pool } from '../db';
import { sealer } from '../sealer';
import { accessToken, setGrantState } from './grants';
import { refresher } from './oauth';

/*
 * Tenant tool client: calls a tenant MCP tool as the signed-in human, with their own grant (plan 01: reads and
 * mutations always use the human's token; no service principal). Results are validated against the contract;
 * a response that does not match is a tenant error, not data.
 */
type Tool = TargetTool | ActionTool;
const ARGS = { ...targetToolArgs, ...actionToolArgs } as Record<Tool, z.ZodType>;
const RESULTS = { ...targetToolResults, ...actionToolResults } as Record<Tool, z.ZodType>;
type ResultOf<K extends Tool> = K extends TargetTool ? z.infer<(typeof targetToolResults)[K]> : K extends ActionTool ? z.infer<(typeof actionToolResults)[K]> : never;
type ArgsOf<K extends Tool> = K extends TargetTool ? z.input<(typeof targetToolArgs)[K]> : K extends ActionTool ? z.input<(typeof actionToolArgs)[K]> : never;

/**
 * Raw RPC outcome. `sent` distinguishes "the tenant never received it" (safe to report as failed) from
 * "the tenant may have processed it" (an uncertain outcome for writes).
 */
export type RpcOutcome<T> =
 | { kind: 'ok'; data: T }
 | { kind: 'tool_error'; code: string; message: string }
 | { kind: 'not_connected' | 'reconnect_required' | 'denied' }
 | { kind: 'not_sent' }
 | { kind: 'unknown'; detail: 'timeout' | 'server_error' | 'connection_lost' | 'invalid_response' };

/** `cancel` ends the call early (e.g. the browser closed its live stream), reported as not sent or unknown like any abort. */
export async function rpc<K extends Tool>(app: RegistryApp, userId: string, tool: K, args: ArgsOf<K>, timeoutMs = 4000, cancel?: AbortSignal): Promise<RpcOutcome<ResultOf<K>>> {
 const parsedArgs = ARGS[tool].parse(args);
 const token = await accessToken(pool(), sealer(), userId, app.appKey, refresher(app));
 if (token.status !== 'ok') return token.status === 'unavailable' ? { kind: 'not_sent' } : { kind: token.status };
 // An explicit timer (not AbortSignal.timeout) is cleared as soon as the call settles, so a finished long poll does not
 // keep its request state alive until the timeout would have fired.
 const abort = new AbortController();
 const timer = setTimeout(() => abort.abort(new DOMException('Tenant call timed out', 'TimeoutError')), timeoutMs);
 const onCancel = () => abort.abort(cancel?.reason);
 cancel?.addEventListener('abort', onCancel, { once: true });
 try { return await send(app, tool, parsedArgs, token.accessToken, userId, abort.signal); }
 finally { clearTimeout(timer); cancel?.removeEventListener('abort', onCancel); }
}

async function send<K extends Tool>(app: RegistryApp, tool: K, parsedArgs: unknown, accessToken: string, userId: string, signal: AbortSignal): Promise<RpcOutcome<ResultOf<K>>> {
 let r: Response;
 try {
  r = await fetch(`${app.supportOrigin}/api/mcp`, {
   method: 'POST', signal,
   headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
   body: JSON.stringify({ jsonrpc: '2.0', id: crypto.randomUUID(), method: 'tools/call', params: { name: tool, arguments: parsedArgs } }),
  });
 } catch (e) {
  const err = e as Error & { cause?: { code?: string } };
  if (err.name === 'TimeoutError' || signal.reason?.name === 'TimeoutError') return { kind: 'unknown', detail: 'timeout' };
  if (['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN'].includes(err.cause?.code ?? '')) return { kind: 'not_sent' };
  return { kind: 'unknown', detail: 'connection_lost' };
 }
 // 401/403 are answered before the tool runs.
 if (r.status === 401) { await setGrantState(pool(), userId, app.appKey, 'reconnect_required', 'tenant_rejected_token'); return { kind: 'reconnect_required' }; }
 if (r.status === 403) return { kind: 'denied' };
 if (!r.ok) return { kind: 'unknown', detail: 'server_error' };
 let body: { result?: { isError?: boolean; content?: { type: string; text: string }[] } } | null;
 try { body = await r.json(); } catch { return { kind: 'unknown', detail: signal.aborted ? 'timeout' : 'connection_lost' }; }
 const text = body?.result?.content?.find(c => c.type === 'text')?.text ?? '';
 if (!body?.result) return { kind: 'unknown', detail: 'invalid_response' };
 if (body.result.isError) {
  const code = text.match(/^Error: ([A-Z_]+):/)?.[1] ?? (/team member|permission/i.test(text) ? 'FORBIDDEN' : 'TOOL_ERROR');
  return { kind: 'tool_error', code, message: text.replace(/^Error: (?:[A-Z_]+: )?/, '') };
 }
 let json: unknown;
 try { json = JSON.parse(text); } catch { return { kind: 'unknown', detail: 'invalid_response' }; }
 const data = RESULTS[tool].safeParse(json);
 if (!data.success) {
  console.warn(JSON.stringify({ level: 'warn', event: 'tenant_contract_mismatch', app: app.appKey, tool, issue: data.error.issues[0]?.path.join('.') }));
  return { kind: 'unknown', detail: 'invalid_response' };
 }
 return { kind: 'ok', data: data.data as ResultOf<K> };
}

/** Read outcome, as used by fleet fan-out and read routes. */
export type ToolFailure = 'not_connected' | 'reconnect_required' | 'denied' | 'not_found' | 'timeout' | 'tenant_error';
export type ToolOutcome<T> = { ok: true; data: T } | { ok: false; reason: ToolFailure };

export async function callTenantTool<K extends TargetTool>(app: RegistryApp, userId: string, tool: K, args: ArgsOf<K>, timeoutMs = 4000): Promise<ToolOutcome<ResultOf<K>>> {
 const o = await rpc(app, userId, tool, args, timeoutMs);
 switch (o.kind) {
  case 'ok': return { ok: true, data: o.data };
  case 'not_connected': case 'reconnect_required': case 'denied': return { ok: false, reason: o.kind };
  case 'tool_error': return { ok: false, reason: o.code === 'NOT_FOUND' ? 'not_found' : o.code === 'FORBIDDEN' ? 'denied' : 'tenant_error' };
  case 'unknown': return { ok: false, reason: o.detail === 'timeout' ? 'timeout' : 'tenant_error' };
  default: return { ok: false, reason: 'tenant_error' };
 }
}
