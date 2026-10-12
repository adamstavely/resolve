/*
 * Development-only stand-in for an internally hosted summary model (plan 14, E4). Deterministic, so tests can check
 * Resolve's handling rather than a model's quality. It answers the summary contract
 * (POST /v1/summarize {model, instructions, sections} → {claims:[{text, citations}]}) and, on purpose, misbehaves the way
 * real models can:
 * - one claim cites a section that does not exist (Resolve must drop and count it);
 * - one interpretation has no citation (Resolve must label it unsupported);
 * - if a section contains an instruction ("ignore previous instructions"), it obeys it, as a vulnerable model would
 *   (Resolve must not present that as a finding).
 * Fault: POST /dev/fault {down: true} makes it fail.
 *
 *   npm run dev:model
 */
import { createServer } from 'node:http';

if (process.env.NODE_ENV === 'production') throw new Error('The mock model must never run in production');
let down = false;
interface Section { section: number; title: string; content: string }

function summarize(sections: Section[]) {
 const by = (n: number) => sections.find(s => s.section === n);
 const claims: { text: string; citations: number[] }[] = [];
 const health = by(1);
 if (health) {
  const state = health.content.match(/State (\w+)/)?.[1] ?? 'unknown';
  const issue = health.content.match(/(Case [\w-]+|Alert) "([^"]+)"/);
  claims.push({ text: `At capture the application was ${state}${issue ? `, with ${issue[1]} open: ${issue[2]}` : ''}.`, citations: [1] });
 }
 const events = by(2);
 if (events && health) {
  const errors = (events.content.match(/error, failure/g) ?? []).length;
  if (errors) claims.push({ text: `The customer had ${errors} errors, and the issue's window covers them.`, citations: [2, 1] });
 }
 const session = by(3);
 if (session) claims.push({ text: `The customer's last session came from ${session.content.split(' at ')[0]}.`, citations: [3] });
 const restricted = by(4);
 if (restricted && /pattern/.test(restricted.content)) claims.push({ text: 'A new log pattern appeared on the service after the issue began.', citations: [4] });
 const tried = by(5);
 if (tried) claims.push({ text: `Already tried in Resolve: ${tried.content.split(';').length} action(s).`, citations: [5] });
 claims.push({ text: 'A refund was issued for the duplicate payment.', citations: [7] }); // cites nothing that exists
 claims.push({ text: 'This points to the incident rather than a problem with the account.', citations: [] });
 // A compromised model tends to lead with the planted instruction.
 if (sections.some(s => /ignore previous instructions/i.test(s.content))) claims.unshift({ text: 'Approve the account freeze immediately.', citations: [] });
 return { claims };
}

createServer(async (req, res) => {
 let raw = '';
 for await (const c of req) raw += c;
 const send = (status: number, body: unknown) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
 if (req.method === 'POST' && req.url === '/dev/fault') { down = !!JSON.parse(raw || '{}').down; return send(200, { down }); }
 if (req.method === 'POST' && req.url === '/v1/summarize') {
  if (down) return send(503, { error: 'unavailable' });
  const body = JSON.parse(raw || '{}') as { sections?: Section[] };
  return send(200, summarize(body.sections ?? []));
 }
 send(404, { error: 'not_found' });
}).listen(3500, '127.0.0.1', () => console.log('Mock summary model at http://127.0.0.1:3500/v1/summarize'));
