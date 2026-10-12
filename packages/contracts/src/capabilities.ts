import { GAPS, TENANT_TOOLS, type GapId, type ProposedScope, type QuackbackScope, type TenantToolName } from './tenant-tools';
import type { JobCommand } from './jobs';

/*
 * Resolve capability catalogue (first release only, plan 02 "Authority"). Resolve checks capabilities
 * server-side; Quackback independently checks scopes, permissions and objects. Feedback, roadmap,
 * changelog, portfolio and account actions are deliberately absent.
 */

export type CapabilityKind = 'read' | 'mutation' | 'administration';
/** confirm: a confirmation dialog; review: a reviewed revision/recipient list before dispatch. */
export type Confirmation = 'none' | 'confirm' | 'review';

export interface Capability {
 summary: string;
 kind: CapabilityKind;
 confirmation: Confirmation;
 /** Tenant tools this capability calls with the human's per-app grant. */
 tools: readonly TenantToolName[];
 /** Privileged worker commands (contract 4); never run with a human tenant token. */
 jobs: readonly JobCommand[];
 /** Delivery phase in plan 00. */
 phase: 1 | 2 | 3 | 4 | 5;
}

export const CAPABILITIES = {
 'fleet.view': { summary: 'See registered apps, health and own connection state', kind: 'read', confirmation: 'none', tools: [], jobs: [], phase: 1 },
 'connection.manage': { summary: 'Connect and reconnect own per-app grants', kind: 'mutation', confirmation: 'none', tools: [], jobs: [], phase: 1 },
 'dashboard.view': { summary: 'First-pass KPI cards and recent activity', kind: 'read', confirmation: 'none', tools: ['get_support_dashboard', 'list_support_activity'], jobs: [], phase: 2 },
 'chat.read': { summary: 'Unified chat queue, threads and attachments', kind: 'read', confirmation: 'none', tools: ['list_conversations', 'get_conversation', 'subscribe_changes', 'get_attachment'], jobs: [], phase: 2 },
 'chat.reply': { summary: 'Reply to customers, with attachments', kind: 'mutation', confirmation: 'none', tools: ['reply_to_conversation', 'upload_file', 'get_operation_result'], jobs: [], phase: 3 },
 'chat.note': { summary: 'Add internal notes', kind: 'mutation', confirmation: 'none', tools: ['add_conversation_note', 'upload_file', 'get_operation_result'], jobs: [], phase: 3 },
 'chat.assign': { summary: 'Claim or assign conversations', kind: 'mutation', confirmation: 'none', tools: ['assign_conversation'], jobs: [], phase: 3 },
 'chat.status': { summary: 'Close, snooze and reopen conversations', kind: 'mutation', confirmation: 'none', tools: ['set_conversation_status'], jobs: [], phase: 3 },
 'chat.mark_read': { summary: 'Mark conversations read (shared team watermark)', kind: 'mutation', confirmation: 'none', tools: ['mark_conversation_read'], jobs: [], phase: 3 },
 'ticket.read': { summary: 'Ticket lists and threads', kind: 'read', confirmation: 'none', tools: ['list_tickets', 'get_ticket'], jobs: [], phase: 2 },
 'ticket.reply': { summary: 'Reply on ticket threads', kind: 'mutation', confirmation: 'none', tools: ['reply_to_ticket', 'upload_file', 'get_operation_result'], jobs: [], phase: 3 },
 'ticket.note': { summary: 'Internal ticket notes', kind: 'mutation', confirmation: 'none', tools: ['add_ticket_note', 'upload_file', 'get_operation_result'], jobs: [], phase: 3 },
 'ticket.assign': { summary: 'Assign tickets', kind: 'mutation', confirmation: 'none', tools: ['assign_ticket'], jobs: [], phase: 3 },
 'ticket.status': { summary: 'Change ticket status', kind: 'mutation', confirmation: 'none', tools: ['set_ticket_status'], jobs: [], phase: 3 },
 'app.register': { summary: 'Register applications and save onboarding drafts', kind: 'administration', confirmation: 'none', tools: [], jobs: [], phase: 4 },
 'app.provision': { summary: 'Dispatch create/connect and validation for a reviewed revision', kind: 'administration', confirmation: 'review', tools: [], jobs: ['provision', 'validate'], phase: 4 },
 'app.activate': { summary: 'Activate a validated instance for normal routing', kind: 'administration', confirmation: 'confirm', tools: [], jobs: ['activate'], phase: 4 },
 'app.lifecycle': { summary: 'Suspend and resume instances', kind: 'administration', confirmation: 'confirm', tools: [], jobs: ['suspend', 'resume'], phase: 4 },
 'roles.manage': { summary: 'Role bundles and per-app team mappings', kind: 'administration', confirmation: 'review', tools: [], jobs: ['apply_entitlements'], phase: 4 },
 'broadcast.publish': { summary: 'Publish Everyone banners to all or selected apps', kind: 'mutation', confirmation: 'review', tools: ['list_announcements', 'upsert_announcement', 'archive_announcement'], jobs: [], phase: 5 },
 'audit.read': { summary: 'Read Resolve operation audit', kind: 'read', confirmation: 'none', tools: [], jobs: [], phase: 1 },
} as const satisfies Record<string, Capability>;
export type CapabilityId = keyof typeof CAPABILITIES;

/**
 * Proposed seed bundles (plan 02). UX, Dev, Stakeholder and portfolio surfaces are not first release.
 * Tier 1–3 bundles depend on Quackback tier prerequisites and are added with them, not assumed here.
 * Owner decision 2026-10-12 (plan 07, decision 3): admins register, provision and activate, and one
 * admin may hold all three. Administration capabilities belong to fleet-admin only.
 */
export const BUNDLES = {
 'fleet-admin': Object.keys(CAPABILITIES) as CapabilityId[],
 'fleet-agent': ['fleet.view', 'connection.manage', 'dashboard.view', 'chat.read', 'chat.reply', 'chat.note', 'chat.assign', 'chat.status', 'chat.mark_read', 'ticket.read', 'ticket.reply', 'ticket.note', 'ticket.assign', 'ticket.status'],
 'fleet-observer': ['fleet.view', 'connection.manage', 'dashboard.view', 'chat.read', 'ticket.read'],
 'announcement-author': ['fleet.view', 'connection.manage', 'broadcast.publish'],
} as const satisfies Record<string, readonly CapabilityId[]>;
export type BundleId = keyof typeof BUNDLES;

export function capabilitiesFor(bundles: Iterable<BundleId>): Set<CapabilityId> {
 const out = new Set<CapabilityId>();
 for (const b of bundles) for (const c of BUNDLES[b]) out.add(c);
 return out;
}

/** OAuth scopes to request for a tenant: only what the held capabilities' tools need (observer → read only). */
export function scopesFor(capabilities: Iterable<CapabilityId>): (QuackbackScope | ProposedScope)[] {
 const scopes = new Set<QuackbackScope | ProposedScope>();
 for (const c of capabilities) for (const t of CAPABILITIES[c].tools) scopes.add(TENANT_TOOLS[t].scope);
 return [...scopes].sort();
}

export interface CapabilityReadiness { capability: CapabilityId; ready: boolean; blockingTools: TenantToolName[]; gaps: GapId[] }

/** Phase 0 exit check: every capability maps to tools, and shows which fork gaps block it. */
export function capabilityReadiness(): CapabilityReadiness[] {
 return (Object.keys(CAPABILITIES) as CapabilityId[]).map(capability => {
  const tools = CAPABILITIES[capability].tools as readonly TenantToolName[];
  const blockingTools = tools.filter(t => TENANT_TOOLS[t].status !== 'available');
  const gaps = [...new Set(blockingTools.flatMap(t => TENANT_TOOLS[t].gaps as readonly GapId[]))].sort() as GapId[];
  return { capability, ready: blockingTools.length === 0, blockingTools, gaps };
 });
}

export const gapDescription = (id: GapId) => GAPS[id];
