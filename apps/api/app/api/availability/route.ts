import { availabilityChangeSchema } from '@resolve/contracts';
import { json, jsonMutation, problem } from '../../../lib/http';
import { fleetRequest } from '../../../lib/fleet/http';
import { fleetAvailability } from '../../../lib/fleet/availability';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Your chat availability in each application. */
export async function GET(request: Request) {
 const r = await fleetRequest(request, 'chat.availability');
 if (r instanceof Response) return r;
 return json({ apps: await fleetAvailability(r.principal, r.apps) });
}

/** Set yourself available or away in every connected application; the response says where it applied. */
export async function POST(request: Request) {
 const raw = await jsonMutation(request);
 if (raw instanceof Response) return raw;
 const r = await fleetRequest(request, 'chat.availability');
 if (r instanceof Response) return r;
 const body = availabilityChangeSchema.safeParse(raw);
 if (!body.success) return problem(400, 'INVALID_REQUEST', 'Choose available or away.');
 return json({ apps: await fleetAvailability(r.principal, r.apps, body.data.status) });
}
