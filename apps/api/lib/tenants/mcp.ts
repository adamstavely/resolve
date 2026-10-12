import { targetToolArgs, targetToolResults, type TargetTool, type RegistryApp } from '@resolve/contracts';
import type { z } from 'zod';
import { pool } from '../db';
import { sealer } from '../sealer';
import { accessToken, setGrantState } from './grants';
import { refresher } from './oauth';

/*
 * Tenant tool client: calls a tenant MCP tool as the signed-in human, with their own grant (plan 01: mutations
 * and reads always use the human's token; no service principal). Results are validated against the target
 * contract; a response that does not match is a tenant error, not data.
 */
export type ToolFailure = 'not_connected' | 'reconnect_required' | 'denied' | 'not_found' | 'timeout' | 'tenant_error';
export type ToolOutcome<T> = { ok: true; data: T } | { ok: false; reason: ToolFailure };

export async function callTenantTool<K extends TargetTool>(app: RegistryApp, userId: string, tool: K, args: z.input<(typeof targetToolArgs)[K]>,
 timeoutMs = 4000): Promise<ToolOutcome<z.infer<(typeof targetToolResults)[K]>>> {
 const parsedArgs = targetToolArgs[tool].parse(args);
 const token = await accessToken(pool(), sealer(), userId, app.appKey, refresher(app));
 if (token.status !== 'ok') return { ok: false, reason: token.status === 'unavailable' ? 'tenant_error' : token.status };

 let r: Response;
 try {
  r = await fetch(`${app.supportOrigin}/api/mcp`, {
   method: 'POST', signal: AbortSignal.timeout(timeoutMs),
   headers: { Authorization: `Bearer ${token.accessToken}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
   body: JSON.stringify({ jsonrpc: '2.0', id: crypto.randomUUID(), method: 'tools/call', params: { name: tool, arguments: parsedArgs } }),
  });
 } catch (e) {
  return { ok: false, reason: (e as Error)?.name === 'TimeoutError' ? 'timeout' : 'tenant_error' };
 }
 if (r.status === 401) { await setGrantState(pool(), userId, app.appKey, 'reconnect_required', 'tenant_rejected_token'); return { ok: false, reason: 'reconnect_required' }; }
 if (r.status === 403) return { ok: false, reason: 'denied' };
 if (!r.ok) return { ok: false, reason: 'tenant_error' };
 const rpc = await r.json().catch(() => null) as { result?: { isError?: boolean; content?: { type: string; text: string }[] } } | null;
 const text = rpc?.result?.content?.find(c => c.type === 'text')?.text ?? '';
 if (!rpc?.result) return { ok: false, reason: 'tenant_error' };
 if (rpc.result.isError) return { ok: false, reason: /NOT_FOUND/.test(text) ? 'not_found' : /FORBIDDEN|team member|permission/i.test(text) ? 'denied' : 'tenant_error' };
 let json: unknown;
 try { json = JSON.parse(text); } catch { return { ok: false, reason: 'tenant_error' }; }
 const data = targetToolResults[tool].safeParse(json);
 if (!data.success) {
  console.warn(JSON.stringify({ level: 'warn', event: 'tenant_contract_mismatch', app: app.appKey, tool, issue: data.error.issues[0]?.path.join('.') }));
  return { ok: false, reason: 'tenant_error' };
 }
 return { ok: true, data: data.data as z.infer<(typeof targetToolResults)[K]> };
}
