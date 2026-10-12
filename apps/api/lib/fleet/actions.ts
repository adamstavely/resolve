import { type ActionTool, type CapabilityId, type Operation, type RegistryApp } from '@resolve/contracts';
import type { z } from 'zod';
import { pool } from '../db';
import { json, jsonMutation, problem } from '../http';
import { beginOperation, dispatch, KEYED_OPERATIONS, OperationConflict, toApi, type ActionSpec } from '../operations';
import { actionSupported } from '../tenants/protocol';
import { appRequest } from './http';

const MESSAGES: Record<string, string> = {
 CONFLICT: 'This item changed since you opened it. Refresh and try again.',
 OPERATION_CONFLICT: 'This operation was already used for different content.',
 FORBIDDEN: 'The application does not allow you to do this.',
 TENANT_DENIED: 'The application did not grant Resolve permission for this. Reconnect, or ask an administrator.',
 NOT_FOUND: 'Not found, or you do not have access to it.',
 NOT_CONNECTED: 'Connect to this application first.',
 RECONNECT_REQUIRED: 'Reconnect to this application to continue.',
 NOT_SENT: 'The application could not be reached. Nothing was sent; try again.',
};
const UNCERTAIN = 'The application did not confirm this action. It may have been applied. Check the result before trying again.';

export function operationResponse(op: Operation) {
 const status = op.state === 'succeeded' ? 200 : op.state === 'uncertain' ? 202 : op.state === 'denied' ? 403
  : op.failureCode === 'CONFLICT' || op.failureCode === 'OPERATION_CONFLICT' ? 409 : op.failureCode === 'NOT_FOUND' ? 404 : op.failureCode === 'NOT_SENT' ? 503 : 422;
 const message = op.state === 'succeeded' ? 'Done.' : op.state === 'uncertain' ? UNCERTAIN : MESSAGES[op.failureCode ?? ''] ?? 'The action failed.';
 return json({ operation: op, message }, status);
}

/**
 * Shared action handler: Origin + JSON, capability, servable/compatible app, the action's tool version, then a
 * recorded operation. A repeated operation id returns the existing result, or re-dispatches a keyed operation whose
 * outcome is uncertain or that was never sent (the user's explicit retry; the tenant replays by key).
 */
export async function runAction<S extends z.ZodType>(request: Request, appKey: string, capability: CapabilityId, tool: ActionTool, schema: S,
 build: (body: z.infer<S>, app: RegistryApp) => Omit<ActionSpec, 'tool' | 'keyed'>, operationId?: (body: z.infer<S>) => string) {
 const raw = await jsonMutation(request);
 if (raw instanceof Response) return raw;
 const ctx = await appRequest(request, capability, appKey, `action.${tool}`);
 if (ctx instanceof Response) return ctx;
 if (!(await actionSupported(ctx.app, tool))) return problem(409, 'ACTION_UNAVAILABLE', `${ctx.app.displayName} does not support this action yet.`);
 const body = schema.safeParse(raw);
 if (!body.success) return problem(400, 'INVALID_REQUEST', body.error.issues[0]?.message ?? 'Invalid request.');
 const partial = build(body.data, ctx.app);
 const spec: ActionSpec = { ...partial, tool, keyed: KEYED_OPERATIONS.has(partial.operation) };
 const id = operationId?.(body.data) ?? crypto.randomUUID();
 let begun;
 try { begun = await beginOperation(pool(), id, ctx.principal.userId, appKey, spec); }
 catch (e) { if (e instanceof OperationConflict) return problem(409, 'OPERATION_CONFLICT', MESSAGES.OPERATION_CONFLICT); throw e; }
 let row = begun.row;
 const redispatch = !begun.created && spec.keyed && (row.state === 'uncertain' || (row.state === 'failed' && row.failure_code === 'NOT_SENT'));
 if (begun.created || redispatch) row = await dispatch(pool(), ctx.app, row, spec);
 return operationResponse(toApi(row, spec.keyed));
}
