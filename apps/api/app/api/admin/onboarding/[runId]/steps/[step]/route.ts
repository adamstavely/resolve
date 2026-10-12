import { saveStepSchema, STEP_SCHEMAS, type EditableStep } from '@resolve/contracts';
import { pool } from '../../../../../../../lib/db';
import { json } from '../../../../../../../lib/http';
import { adminMutation, fieldProblem } from '../../../../../../../lib/fleet-admin/http';
import { runView, saveStep } from '../../../../../../../lib/fleet-admin/onboarding';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Save one wizard step as a draft (version-checked). */
export async function PUT(request: Request, ctx: { params: Promise<{ runId: string; step: string }> }) {
 const { runId, step } = await ctx.params;
 return adminMutation(request, 'app.register', async (principal, raw) => {
  if (!(step in STEP_SCHEMAS)) return fieldProblem(404, 'NOT_FOUND', 'Unknown step.');
  const body = saveStepSchema.safeParse(raw);
  if (!body.success) return fieldProblem(400, 'INVALID_REQUEST', 'Send the step data and the version you edited.');
  await saveStep(pool(), principal.userId, runId, step as EditableStep, body.data.data, body.data.version);
  return json({ run: await runView(pool(), runId) });
 });
}
