import { z } from 'zod';
import type { TenantToolName } from './tenant-tools';

/*
 * Contract 6 (plan 01): compatibility. Tenants and the worker advertise supported protocol versions
 * and tool versions (gap QB-PROTO-1). Unknown or incompatible mutation contracts are disabled with an
 * actionable reason; there is no guessed fallback.
 */
export const tenantProtocolSchema = z.strictObject({
 protocolVersions: z.array(z.number().int().positive()).min(1),
 tools: z.record(z.string(), z.number().int().positive()),
});
export type TenantProtocol = z.infer<typeof tenantProtocolSchema>;

export interface Requirement { protocol: number; tools: Partial<Record<TenantToolName, number>> }
export type CompatibilityReason = 'TENANT_PROTOCOL_UNKNOWN' | 'PROTOCOL_UNSUPPORTED' | 'TOOL_MISSING' | 'TOOL_TOO_OLD';

export interface Compatibility {
 compatible: boolean;
 reasons: { code: CompatibilityReason; tool?: TenantToolName; required?: number; actual?: number }[];
}

export function evaluateCompatibility(tenant: unknown, required: Requirement): Compatibility {
 const parsed = tenantProtocolSchema.safeParse(tenant);
 if (!parsed.success) return { compatible: false, reasons: [{ code: 'TENANT_PROTOCOL_UNKNOWN' }] };
 const reasons: Compatibility['reasons'] = [];
 if (!parsed.data.protocolVersions.includes(required.protocol)) reasons.push({ code: 'PROTOCOL_UNSUPPORTED', required: required.protocol });
 for (const [tool, min] of Object.entries(required.tools) as [TenantToolName, number][]) {
  const actual = parsed.data.tools[tool];
  if (actual === undefined) reasons.push({ code: 'TOOL_MISSING', tool, required: min });
  else if (actual < min) reasons.push({ code: 'TOOL_TOO_OLD', tool, required: min, actual });
 }
 return { compatible: reasons.length === 0, reasons };
}
