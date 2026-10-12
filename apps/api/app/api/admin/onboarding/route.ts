import { startOnboardingSchema } from '@resolve/contracts';
import { pool } from '../../../../lib/db';
import { json } from '../../../../lib/http';
import { adminMutation, fieldProblem } from '../../../../lib/fleet-admin/http';
import { startRun } from '../../../../lib/fleet-admin/onboarding';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Start onboarding with step 1 (a new application, or another environment of an existing one). */
export async function POST(request: Request) {
 return adminMutation(request, 'app.register', async (principal, raw) => {
  const body = startOnboardingSchema.safeParse(raw);
  if (!body.success) return fieldProblem(400, 'INVALID_STEP', body.error.issues[0]?.message ?? 'Check the form.', { field: String(body.error.issues[0]?.path.at(-1) ?? '') });
  const runId = await startRun(pool(), principal.userId, body.data.describe, body.data.applicationId);
  return json({ runId }, 201);
 });
}
