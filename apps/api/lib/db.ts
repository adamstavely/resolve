import { Pool, type PoolClient } from 'pg';
import { config } from './config';

export type Queryable = Pick<Pool, 'query'> | PoolClient;

const holder = globalThis as unknown as { resolvePool?: Pool };

/** One pool per server process (survives dev hot reload). */
export function pool(): Pool {
 return (holder.resolvePool ??= new Pool({ connectionString: config().DATABASE_URL, max: 10, connectionTimeoutMillis: 3000 }));
}

export async function transaction<T>(db: Pick<Pool, 'connect'>, work: (client: PoolClient) => Promise<T>): Promise<T> {
 const client = await db.connect();
 try {
  await client.query('BEGIN');
  const result = await work(client);
  await client.query('COMMIT');
  return result;
 } catch (e) {
  await client.query('ROLLBACK');
  throw e;
 } finally {
  client.release();
 }
}
