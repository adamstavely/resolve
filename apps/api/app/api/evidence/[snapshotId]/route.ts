import type { NextRequest } from 'next/server';
import { snapshotResponse } from '../../../../lib/integrations/subject-http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** One evidence snapshot; `?download=1` exports it (observability.restricted). */
export async function GET(request: NextRequest, ctx: { params: Promise<{ snapshotId: string }> }) {
 const { snapshotId } = await ctx.params;
 return snapshotResponse(request, snapshotId, request.nextUrl.searchParams.get('download') === '1');
}
