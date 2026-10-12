import { healthSchema } from '@resolve/contracts';
export const runtime = 'nodejs';
export function GET() { return Response.json(healthSchema.parse({service:'resolve-api',version:'1',status:'ok'}), { headers: { 'Cache-Control': 'no-store' } }); }
