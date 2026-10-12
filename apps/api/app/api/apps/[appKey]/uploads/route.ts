import { uploadAttachment } from '../../../../../lib/fleet/files';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Upload a file for a reply or note, as the signed-in human. The tenant binds it to them and the target. */
export async function POST(request: Request, ctx: { params: Promise<{ appKey: string }> }) {
 return uploadAttachment(request, (await ctx.params).appKey);
}
