import type { Idempotency } from './tenant-tools';

/*
 * Dispatch outcome classification shared by operator actions and broadcasts (plan 00 phase 3, plan 08).
 * A timeout after the request may have reached the tenant is uncertain, not failed, and a
 * non-idempotent action is never retried automatically.
 */
export type DispatchFailure =
 | 'not_sent'              // connection refused / DNS / no grant: the tenant never saw the request
 | 'rejected'              // tenant answered with a definite error (validation, 4xx, permission)
 | 'timeout_after_send'    // request written, no response
 | 'connection_lost_after_send'
 | 'server_error';         // 5xx: commit state unknown

export type ActionOutcome = 'failed' | 'uncertain';
export type RetryDecision = 'retry' | 'reconcile_then_retry' | 'never';

export function classify(failure: DispatchFailure): ActionOutcome {
 return failure === 'not_sent' || failure === 'rejected' ? 'failed' : 'uncertain';
}

/**
 * What the dispatcher may do next on its own. `keyed` tools replay with the same operation key after
 * reconciling; `not_idempotent` tools surface the outcome to a human and stop.
 */
export function retryDecision(idempotency: Idempotency, failure: DispatchFailure): RetryDecision {
 if (failure === 'rejected') return 'never';
 if (idempotency === 'read' || idempotency === 'idempotent') return 'retry';
 if (idempotency === 'keyed') return failure === 'not_sent' ? 'retry' : 'reconcile_then_retry';
 return failure === 'not_sent' ? 'retry' : 'never';
}
