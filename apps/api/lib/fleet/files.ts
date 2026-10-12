import { ATTACHMENT_POLICY, type CapabilityId, type UploadedFile } from '@resolve/contracts';
import { pool } from '../db';
import { json, problem, crossOrigin } from '../http';
import { config } from '../config';
import { sameOrigin } from '../auth/policy';
import { currentPrincipal } from '../auth/session';
import { auditRead, writeAudit } from '../audit';
import { rpc } from '../tenants/mcp';
import { actionSupported } from '../tenants/protocol';
import { appRequest } from './http';

/*
 * Attachments (plan 09). Uploads and downloads go through Resolve's backend with the human's own grant; the browser
 * never receives a tenant URL or credential. Resolve checks the policy (type by extension, matching file signature,
 * size), and the tenant checks it again, scans the file, and binds the upload to the uploader and target.
 * Downloads name their parent conversation or ticket, so the tenant can refuse a guessed attachment id.
 */
export type TargetType = 'conversation' | 'ticket';

const SIGNATURES: Record<string, (b: Uint8Array) => boolean> = {
 'image/png': b => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47,
 'image/jpeg': b => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
 'image/gif': b => ascii(b, 0, 4) === 'GIF8',
 'image/webp': b => ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 12) === 'WEBP',
 'application/pdf': b => ascii(b, 0, 5) === '%PDF-',
 'application/zip': b => b[0] === 0x50 && b[1] === 0x4b && (b[2] === 0x03 || b[2] === 0x05),
};
const TEXT_TYPES = new Set(['text/plain', 'text/csv', 'application/json']);
const ascii = (b: Uint8Array, from: number, to: number) => String.fromCharCode(...b.subarray(from, to));

/** Content type from the extension (the browser's claim is not trusted), or the reason the file is refused. */
export function checkFile(name: string, bytes: Uint8Array): { contentType: string } | { code: string; message: string } {
 const ext = name.includes('.') ? name.split('.').pop()!.toLowerCase() : '';
 const contentType = Object.entries(ATTACHMENT_POLICY.types).find(([, exts]) => exts.includes(ext))?.[0];
 if (!contentType) return { code: 'FILE_TYPE_NOT_ALLOWED', message: 'This type of file cannot be attached. Use an image, PDF, text, CSV, JSON or ZIP file.' };
 if (bytes.length === 0) return { code: 'FILE_EMPTY', message: 'The file is empty.' };
 if (bytes.length > ATTACHMENT_POLICY.maxBytes) return { code: 'FILE_TOO_LARGE', message: 'Files can be at most 5 MB.' };
 if (TEXT_TYPES.has(contentType)) {
  try { new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { return { code: 'FILE_CONTENT_MISMATCH', message: 'The file is not the text file its name says it is.' }; }
  if (bytes.includes(0)) return { code: 'FILE_CONTENT_MISMATCH', message: 'The file is not the text file its name says it is.' };
 } else if (!SIGNATURES[contentType]?.(bytes)) return { code: 'FILE_CONTENT_MISMATCH', message: `The file's contents do not match its .${ext} name.` };
 return { contentType };
}

/** File names are shown and used as download names: no path parts or control characters. */
export const safeName = (name: string) => name.split(/[\\/]/).pop()!.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 255);

const UPLOAD_ERRORS: Record<string, [number, string]> = {
 FILE_REJECTED: [422, 'The application\'s malware scan refused this file. It was not attached.'],
 FILE_TOO_LARGE: [413, 'Files can be at most 5 MB.'],
 FILE_TYPE_NOT_ALLOWED: [415, 'The application does not accept this type of file.'],
 OPERATION_CONFLICT: [409, 'This upload was already used for a different file. Choose the file again.'],
 NOT_FOUND: [404, 'Not found, or you do not have access to it.'],
 FORBIDDEN: [403, 'The application does not allow you to attach files here.'],
};

/** The first of `options` the person holds; else the first, so the refusal is audited against it. */
async function capabilityFor(request: Request, options: CapabilityId[]) {
 const p = await currentPrincipal(request);
 return options.find(c => p?.capabilities.includes(c)) ?? options[0];
}

/** POST multipart/form-data: file, targetType, targetId, uploadKey (a retry with the same key returns the same file). */
export async function uploadAttachment(request: Request, appKey: string) {
 if (!sameOrigin(request.headers.get('origin'), config().RESOLVE_ORIGIN)) return crossOrigin(request);
 if (Number(request.headers.get('content-length') ?? 0) > ATTACHMENT_POLICY.maxBytes + 64 * 1024) return problem(413, 'FILE_TOO_LARGE', 'Files can be at most 5 MB.');
 let form: FormData;
 try { form = await request.formData(); } catch { return problem(400, 'INVALID_REQUEST', 'Send the file as multipart/form-data.'); }
 const targetType: TargetType = form.get('targetType') === 'ticket' ? 'ticket' : 'conversation';
 const ctx = await appRequest(request, await capabilityFor(request, targetType === 'ticket' ? ['ticket.reply', 'ticket.note'] : ['chat.reply', 'chat.note']), appKey, `${targetType}.upload`);
 if (ctx instanceof Response) return ctx;
 const file = form.get('file');
 const targetId = String(form.get('targetId') ?? '');
 const uploadKey = String(form.get('uploadKey') ?? '');
 const audit = (outcome: 'succeeded' | 'failed' | 'denied' | 'uncertain', extra: Record<string, string | number | null>) =>
  writeAudit(pool(), { actorUserId: ctx.principal.userId, operation: `${targetType}.upload`, outcome, summary: { app: appKey, target: targetId, uploadKey, ...extra } });
 if (!(file instanceof File) || !targetId || !/^[0-9a-f-]{36}$/i.test(uploadKey)) {
  await audit('failed', { code: 'INVALID_REQUEST' });
  return problem(400, 'INVALID_REQUEST', 'Choose a file to attach.');
 }
 const name = safeName(file.name);
 const bytes = new Uint8Array(await file.arrayBuffer());
 const checked = checkFile(name, bytes);
 if ('code' in checked) {
  await audit('failed', { name, size: bytes.length, code: checked.code });
  return problem(checked.code === 'FILE_TOO_LARGE' ? 413 : 415, checked.code, checked.message);
 }
 if (!(await actionSupported(ctx.app, 'upload_file'))) {
  await audit('failed', { name, code: 'ACTION_UNAVAILABLE' });
  return problem(409, 'ACTION_UNAVAILABLE', `${ctx.app.displayName} does not accept attachments from Resolve yet.`);
 }
 const o = await rpc(ctx.app, ctx.principal.userId, 'upload_file', {
  targetType, targetId, name, contentType: checked.contentType, contentBase64: Buffer.from(bytes).toString('base64'), uploadKey,
 }, 20_000);
 const base = { name, contentType: checked.contentType, size: bytes.length };
 switch (o.kind) {
  case 'ok': {
   await audit('succeeded', { ...base, fileId: o.data.fileId });
   const f: UploadedFile = { fileId: o.data.fileId, name: o.data.name, contentType: o.data.contentType, size: o.data.size, expiresAt: o.data.expiresAt };
   return json({ file: f }, 201);
  }
  case 'tool_error': {
   const [status, message] = UPLOAD_ERRORS[o.code] ?? [422, 'The application refused this file.'];
   await audit(o.code === 'FORBIDDEN' ? 'denied' : 'failed', { ...base, code: o.code });
   return problem(status, o.code, message);
  }
  case 'not_connected': case 'reconnect_required': {
   await audit('failed', { ...base, code: o.kind.toUpperCase() });
   return problem(409, o.kind.toUpperCase(), o.kind === 'not_connected' ? 'Connect to this application first.' : 'Reconnect to this application to continue.');
  }
  case 'denied': await audit('denied', { ...base, code: 'TENANT_DENIED' }); return problem(403, 'TENANT_DENIED', 'The application did not grant Resolve permission to upload files.');
  case 'not_sent': await audit('failed', { ...base, code: 'NOT_SENT' }); return problem(503, 'NOT_SENT', 'The application could not be reached. Nothing was uploaded; try again.');
  case 'unknown':
   // Safe to retry: the same upload key returns the same file rather than a second copy.
   await audit('uncertain', { ...base, code: o.detail.toUpperCase() });
   return problem(504, 'UPLOAD_UNCONFIRMED', 'The application did not confirm the upload. Try again; it will not be stored twice.');
 }
}

const DOWNLOAD_ERRORS: Record<string, [number, string]> = {
 not_connected: [409, 'Connect to this application first.'],
 reconnect_required: [409, 'Reconnect to this application to continue.'],
 denied: [403, 'You do not have access to this file in the application.'],
 NOT_FOUND: [404, 'Not found, or you do not have access to it.'],
 FORBIDDEN: [403, 'You do not have access to this file in the application.'],
};

/** GET: stream one attachment as a download. Never rendered inline, never cached, sandboxed if opened. */
export async function downloadAttachment(request: Request, appKey: string, targetType: TargetType, targetId: string, attachmentId: string) {
 const ctx = await appRequest(request, targetType === 'ticket' ? 'ticket.read' : 'chat.read', appKey, 'read.attachment');
 if (ctx instanceof Response) return ctx;
 const summary = { app: appKey, target: targetId, attachment: attachmentId };
 if (!(await actionSupported(ctx.app, 'get_attachment'))) {
  await auditRead(ctx.principal, 'attachment', { ...summary, code: 'ACTION_UNAVAILABLE' }, 'failed');
  return problem(409, 'ACTION_UNAVAILABLE', `${ctx.app.displayName} does not provide attachment downloads yet.`);
 }
 const o = await rpc(ctx.app, ctx.principal.userId, 'get_attachment', { targetType, targetId, attachmentId }, 20_000);
 if (o.kind !== 'ok') {
  const code = o.kind === 'tool_error' ? o.code : o.kind;
  const [status, message] = DOWNLOAD_ERRORS[code] ?? [502, 'The application could not provide this file. Try again shortly.'];
  await auditRead(ctx.principal, 'attachment', { ...summary, code }, status === 403 || status === 404 ? 'denied' : 'failed');
  return problem(status, code.toUpperCase(), message);
 }
 const bytes = Buffer.from(o.data.contentBase64, 'base64');
 if (bytes.length !== o.data.size || bytes.length > ATTACHMENT_POLICY.maxBytes) {
  await auditRead(ctx.principal, 'attachment', { ...summary, code: 'INVALID_RESPONSE' }, 'failed');
  return problem(502, 'TENANT_ERROR', 'The application returned a damaged file.');
 }
 await auditRead(ctx.principal, 'attachment', { ...summary, name: o.data.name, size: bytes.length });
 const type = o.data.contentType in ATTACHMENT_POLICY.types ? o.data.contentType : 'application/octet-stream';
 const name = safeName(o.data.name) || 'attachment';
 const ascii = name.replace(/[^\x20-\x7e]|["\\]/g, '_');
 return new Response(bytes, { headers: {
  'Content-Type': type,
  'Content-Length': String(bytes.length),
  'Content-Disposition': `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`,
  'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy': "sandbox; default-src 'none'",
  'Cache-Control': 'private, no-store',
 } });
}
