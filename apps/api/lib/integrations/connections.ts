import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import {
 ELASTIC_FAMILIES, type Discovery, type ElasticConnection, type ElasticConnectionCreate, type ElasticFamily,
} from '@resolve/contracts';
import { config } from '../config';
import { aad, type Sealer } from '../crypto';
import { transaction, type Queryable } from '../db';
import { writeAudit } from '../audit';
import { checkOrigin, ElasticClient, ElasticError, type ClientPolicy } from './elastic/client';
import { probeFamily, versions } from './elastic/families';

/*
 * Elastic connections (plan 14, E0). An integration administrator registers private Elasticsearch and Kibana
 * endpoints, a space and a read-only credential; Resolve checks the hosts against ELASTIC_ALLOWED_HOSTS, seals the
 * key (or keeps only a secret-store reference), and records what each API family supports. Every change is audited
 * in the same transaction, and anything that changes what reads return bumps the connection revision.
 */

export class ConnectionError extends Error {
 constructor(readonly status: number, readonly code: string, message: string, readonly details: Record<string, string> = {}) { super(message); }
}

export const clientPolicy = (): ClientPolicy => ({ allowedHosts: config().ELASTIC_ALLOWED_HOSTS, production: process.env.NODE_ENV === 'production' });

interface Row {
 id: string; name: string; settings: { elasticsearchUrl: string; kibanaUrl: string; spaceId: string }; credential_enc: string | null; credential_ref: string | null;
 credential_rotated_at: Date; ca_pem: string | null; kill_switch: boolean; kill_switch_reason: string | null; discovery: Discovery | null;
 revision: number; version: number; created_at: Date; updated_at: Date;
}

function view(r: Row): ElasticConnection {
 return {
  id: r.id, provider: 'elastic', name: r.name, elasticsearchUrl: r.settings.elasticsearchUrl, kibanaUrl: r.settings.kibanaUrl, spaceId: r.settings.spaceId,
  credential: { kind: r.credential_ref ? 'secret_ref' : 'sealed', ref: r.credential_ref, rotatedAt: r.credential_rotated_at.toISOString() },
  hasCustomCa: !!r.ca_pem, killSwitch: r.kill_switch, killSwitchReason: r.kill_switch_reason, discovery: r.discovery,
  revision: r.revision, version: r.version, createdAt: r.created_at.toISOString(), updatedAt: r.updated_at.toISOString(),
 };
}

const HOST_MESSAGES: Record<string, string> = {
 HOST_NOT_ALLOWED: 'This host is not on the approved Elastic host list (ELASTIC_ALLOWED_HOSTS).',
 INSECURE_URL: 'Use an https URL with no user name or password.',
};

function checkEndpoints(input: { elasticsearchUrl: string; kibanaUrl: string }) {
 for (const field of ['elasticsearchUrl', 'kibanaUrl'] as const) {
  try { checkOrigin(input[field], clientPolicy()); }
  catch (e) {
   if (e instanceof ElasticError) throw new ConnectionError(400, e.code, HOST_MESSAGES[e.code] ?? 'This address is not allowed.', { field });
   throw e;
  }
 }
}

function checkSecretRef(ref: string | undefined) {
 if (ref && !process.env[ref.slice(4)]) throw new ConnectionError(400, 'SECRET_REF_UNAVAILABLE', 'That secret reference is not available to the Resolve server.', { field: 'secretRef' });
}

export async function listConnections(db: Queryable): Promise<ElasticConnection[]> {
 return ((await db.query(`SELECT * FROM integration_connections WHERE provider = 'elastic' ORDER BY name`)).rows as Row[]).map(view);
}

export async function getConnection(db: Queryable, id: string): Promise<ElasticConnection | null> {
 const r = (await db.query('SELECT * FROM integration_connections WHERE id = $1', [id])).rows[0] as Row | undefined;
 return r ? view(r) : null;
}

export async function createConnection(db: Pick<Pool, 'connect'>, seal: Sealer, actorUserId: string, input: ElasticConnectionCreate): Promise<ElasticConnection> {
 checkEndpoints(input);
 checkSecretRef(input.secretRef);
 const id = randomUUID();
 const enc = input.apiKey ? seal.seal(input.apiKey, aad.integrationCredential(id)) : null;
 return transaction(db, async tx => {
  const dup = await tx.query(`SELECT 1 FROM integration_connections WHERE provider = 'elastic' AND name = $1`, [input.name]);
  if (dup.rowCount) throw new ConnectionError(409, 'NAME_TAKEN', 'A connection with this name already exists.', { field: 'name' });
  const r = (await tx.query(
   `INSERT INTO integration_connections (id, provider, name, settings, credential_enc, credential_ref, ca_pem, created_by)
    VALUES ($1, 'elastic', $2, $3, $4, $5, $6, $7) RETURNING *`,
   [id, input.name, JSON.stringify({ elasticsearchUrl: input.elasticsearchUrl, kibanaUrl: input.kibanaUrl, spaceId: input.spaceId }), enc, input.secretRef ?? null, input.caPem ?? null, actorUserId])).rows[0] as Row;
  await writeAudit(tx, { actorUserId, operation: 'observability.connection_create', outcome: 'succeeded',
   summary: { connectionId: id, name: input.name, elasticsearchHost: new URL(input.elasticsearchUrl).host, kibanaHost: new URL(input.kibanaUrl).host, spaceId: input.spaceId, credential: input.secretRef ? 'secret_ref' : 'sealed' } });
  return view(r);
 });
}

export async function rotateCredential(db: Pick<Pool, 'connect'>, seal: Sealer, actorUserId: string, id: string, input: { apiKey?: string; secretRef?: string; version: number }) {
 checkSecretRef(input.secretRef);
 return transaction(db, async tx => {
  const enc = input.apiKey ? seal.seal(input.apiKey, aad.integrationCredential(id)) : null;
  const r = (await tx.query(
   `UPDATE integration_connections SET credential_enc = $2, credential_ref = $3, credential_rotated_at = now(), discovery = NULL,
     revision = revision + 1, version = version + 1, updated_at = now() WHERE id = $1 AND version = $4 RETURNING *`,
   [id, enc, input.secretRef ?? null, input.version])).rows[0] as Row | undefined;
  if (!r) throw await missingOrConflict(tx, id);
  await writeAudit(tx, { actorUserId, operation: 'observability.credential_rotate', outcome: 'succeeded', summary: { connectionId: id, credential: input.secretRef ? 'secret_ref' : 'sealed' } });
  return view(r);
 });
}

/** The kill switch stops every read and poll for this connection at once; evidence and audit are kept. */
export async function setKillSwitch(db: Pick<Pool, 'connect'>, actorUserId: string, id: string, input: { killSwitch: boolean; reason: string; version: number }) {
 return transaction(db, async tx => {
  const r = (await tx.query(
   `UPDATE integration_connections SET kill_switch = $2, kill_switch_reason = $3, revision = revision + 1, version = version + 1, updated_at = now()
    WHERE id = $1 AND version = $4 RETURNING *`, [id, input.killSwitch, input.killSwitch ? input.reason : null, input.version])).rows[0] as Row | undefined;
  if (!r) throw await missingOrConflict(tx, id);
  await writeAudit(tx, { actorUserId, operation: 'observability.kill_switch', outcome: 'succeeded', summary: { connectionId: id, killSwitch: input.killSwitch, reason: input.reason } });
  return view(r);
 });
}

async function missingOrConflict(db: Queryable, id: string) {
 const exists = (await db.query('SELECT 1 FROM integration_connections WHERE id = $1', [id])).rowCount;
 return exists ? new ConnectionError(409, 'CONFLICT', 'Someone else changed this connection. Reload and try again.')
  : new ConnectionError(404, 'NOT_FOUND', 'Connection not found.');
}

/** A client for a connection. Refuses while the kill switch is on; the credential is opened only here. */
export async function clientFor(db: Queryable, seal: Sealer, id: string): Promise<ElasticClient> {
 const r = (await db.query('SELECT * FROM integration_connections WHERE id = $1', [id])).rows[0] as Row | undefined;
 if (!r) throw new ConnectionError(404, 'NOT_FOUND', 'Connection not found.');
 if (r.kill_switch) throw new ConnectionError(409, 'KILL_SWITCH_ON', 'This connection is switched off. Turn the kill switch off to use it.');
 let apiKey: string;
 if (r.credential_ref) {
  const v = process.env[r.credential_ref.slice(4)];
  if (!v) throw new ConnectionError(409, 'SECRET_REF_UNAVAILABLE', 'The secret reference for this connection is not available.');
  apiKey = v;
 } else apiKey = seal.open(r.credential_enc!, aad.integrationCredential(r.id));
 return new ElasticClient({ ...r.settings, apiKey, caPem: r.ca_pem }, clientPolicy());
}

/**
 * Discovery (E0): versions and one cheap probe per API family. Unsupported and denied families are recorded, not
 * hidden, so the admin sees exactly which panels this connection can feed.
 */
export async function testConnection(db: Pick<Pool, 'connect' | 'query'>, seal: Sealer, actorUserId: string, id: string): Promise<ElasticConnection> {
 const client = await clientFor(db, seal, id);
 const checkedAt = new Date().toISOString();
 let discovery: Discovery;
 try {
  const v = await versions(client);
  const families = {} as Discovery['families'];
  for (const f of ELASTIC_FAMILIES as readonly ElasticFamily[]) families[f] = await probeFamily(client, f);
  discovery = { checkedAt, ...v, reachable: true, failure: null, families };
 } catch (e) {
  const code = e instanceof ElasticError ? e.code : 'UNEXPECTED';
  discovery = {
   checkedAt, elasticsearch: { version: null, buildFlavor: null }, kibana: { version: null, buildFlavor: null }, reachable: false, failure: code,
   families: Object.fromEntries(ELASTIC_FAMILIES.map(f => [f, { status: 'error', code }])) as Discovery['families'],
  };
 }
 return transaction(db, async tx => {
  const r = (await tx.query('UPDATE integration_connections SET discovery = $2, updated_at = now() WHERE id = $1 RETURNING *', [id, JSON.stringify(discovery)])).rows[0] as Row;
  const supported = Object.values(discovery.families).filter(f => f.status === 'supported').length;
  await writeAudit(tx, { actorUserId, operation: 'observability.connection_test', outcome: discovery.reachable ? 'succeeded' : 'failed',
   summary: { connectionId: id, reachable: discovery.reachable, failure: discovery.failure, supported, version: discovery.elasticsearch.version } });
  return view(r);
 });
}
