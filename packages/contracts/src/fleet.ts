import { z } from 'zod';
import { appKeySchema, isoDateTimeSchema } from './common';

/*
 * Fleet aggregation envelopes (plan 01 "Aggregation", plan 11). Every result carries app provenance;
 * partial failures are explicit; an unavailable metric is never reported as zero.
 */
export const UNAVAILABLE_REASONS = ['not_connected', 'reconnect_required', 'denied', 'timeout', 'tenant_error', 'incompatible', 'suspended', 'dormant'] as const;

export const appResultSchema = <T extends z.ZodType>(data: T) => z.discriminatedUnion('status', [
 z.strictObject({ status: z.literal('ok'), appKey: appKeySchema, fetchedAt: isoDateTimeSchema, data }),
 z.strictObject({ status: z.literal('unavailable'), appKey: appKeySchema, reason: z.enum(UNAVAILABLE_REASONS), retryable: z.boolean() }),
]);

export const metricValueSchema = z.discriminatedUnion('status', [
 z.strictObject({ status: z.literal('available'), value: z.number().int().nonnegative(), asOf: isoDateTimeSchema }),
 z.strictObject({ status: z.literal('unavailable'), reason: z.enum(['not_permitted', 'not_implemented', 'app_unavailable']) }),
]);
export type MetricValue = z.infer<typeof metricValueSchema>;

export interface FleetMetric {
 /** Sum over apps that reported a value; null when none did. */
 value: number | null;
 included: string[];
 missing: { appKey: string; reason: string }[];
 /** True only when every requested app contributed. */
 complete: boolean;
}

/** Combine per-app metric values without turning missing data into zero. */
export function sumMetric(values: { appKey: string; metric: MetricValue }[]): FleetMetric {
 const included: string[] = []; const missing: FleetMetric['missing'] = []; let total = 0;
 for (const { appKey, metric } of values) {
  if (metric.status === 'available') { included.push(appKey); total += metric.value; }
  else missing.push({ appKey, reason: metric.reason });
 }
 return { value: included.length ? total : null, included, missing, complete: missing.length === 0 && included.length > 0 };
}
