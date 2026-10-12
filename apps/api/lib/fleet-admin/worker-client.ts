import { z } from 'zod';
import { jobRequestSchema, jobStatusSchema, migrationsResponseSchema, unboundResponseSchema, impactReportSchema, type JobRequest, type JobStatus } from '@resolve/contracts';
import { config } from '../config';

/*
 * Client for the privileged fleet worker (contract 4). Resolve sends allowlisted, validated commands with a service
 * credential and reads job status; it never sends a DSN, secret, image or environment override, and the worker
 * validates every request again. Responses are parsed strictly: an unexpected shape is a worker error, not data.
 */
export type WorkerOutcome<T> =
 | { kind: 'ok'; data: T }
 | { kind: 'refused'; code: string }
 /** The worker was not reached: nothing was submitted. */
 | { kind: 'not_sent' }
 /** The request may have reached the worker; resubmitting the same request id is safe (it dedupes). */
 | { kind: 'unknown' };

async function call<T>(path: string, schema: z.ZodType<T>, init: RequestInit = {}, timeoutMs = 5000): Promise<WorkerOutcome<T>> {
 const c = config();
 let r: Response;
 try {
  r = await fetch(c.WORKER_URL.replace(/\/$/, '') + path, {
   ...init, signal: AbortSignal.timeout(timeoutMs),
   headers: { Authorization: `Bearer ${c.WORKER_TOKEN}`, 'Content-Type': 'application/json', ...(init.headers ?? {}) },
  });
 } catch (e) {
  const code = (e as { cause?: { code?: string } }).cause?.code ?? '';
  return ['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN'].includes(code) ? { kind: 'not_sent' } : { kind: 'unknown' };
 }
 const body = await r.json().catch(() => null);
 if (r.status >= 500) return { kind: 'unknown' };
 if (!r.ok) return { kind: 'refused', code: typeof body?.error === 'string' && /^[A-Z_]{3,64}$/.test(body.error) ? body.error : `HTTP_${r.status}` };
 const parsed = schema.safeParse(body);
 if (!parsed.success) { console.warn(JSON.stringify({ level: 'warn', event: 'worker_contract_mismatch', path, issue: parsed.error.issues[0]?.path.join('.') })); return { kind: 'unknown' }; }
 return { kind: 'ok', data: parsed.data };
}

export function submitJob(request: JobRequest) {
 return call<JobStatus>('/jobs', jobStatusSchema, { method: 'POST', body: JSON.stringify(jobRequestSchema.parse(request)) });
}
export const getJob = (workerJobId: string) => call<JobStatus>(`/jobs/${workerJobId}`, jobStatusSchema);
export const resumeJob = (workerJobId: string) => call<JobStatus>(`/jobs/${workerJobId}/resume`, jobStatusSchema, { method: 'POST' });
export const cancelJob = (workerJobId: string) => call<JobStatus>(`/jobs/${workerJobId}/cancel`, jobStatusSchema, { method: 'POST' });
export const unboundInstances = () => call('/unbound', unboundResponseSchema);
export const migrationStatus = () => call('/migrations', migrationsResponseSchema);

/** The worker's report also carries each person's federated identity, so Resolve can say who would become managed. */
export const workerReportSchema = impactReportSchema.omit({ people: true }).extend({
 people: z.array(z.strictObject({ name: z.string(), role: impactReportSchema.shape.people.element.shape.role, identity: z.strictObject({ issuer: z.string(), subject: z.string() }) })),
});
export const impactReport = (workspaceKey: string) => call(`/instances/${encodeURIComponent(workspaceKey)}/report`, workerReportSchema);
