import { Pool } from 'pg';
import { LATEST_MIGRATION } from '@resolve/database';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function GET() {
 const requestId = crypto.randomUUID();
 if (!process.env.DATABASE_URL) return unavailable(requestId);
 const pool = new Pool({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 2000, max: 1 });
 try {
  const result = await pool.query('SELECT version FROM resolve_migrations WHERE version = $1', [LATEST_MIGRATION]);
  if (!result.rowCount) return unavailable(requestId);
  return Response.json({status:'ready'}, {headers:{'Cache-Control':'no-store'}});
 } catch { return unavailable(requestId); } finally { await pool.end(); }
}
function unavailable(requestId: string) {
 console.warn(JSON.stringify({level:'warn',event:'readiness_unavailable',requestId}));
 return Response.json({error:{code:'NOT_READY',message:'Database initialization is required.',requestId}}, {status:503,headers:{'Cache-Control':'no-store'}});
}
