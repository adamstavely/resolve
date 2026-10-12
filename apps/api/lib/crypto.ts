import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/*
 * Authenticated encryption for tenant client secrets and per-user tokens (plan 01: KMS envelope encryption).
 * Local development uses one AES-256-GCM key from RESOLVE_ENCRYPTION_KEY. Production replaces the key source
 * with a KMS data-key adapter behind the same interface; the stored format carries the key id for rotation.
 * Associated data binds each ciphertext to its row and purpose, so a token cannot be swapped between users or apps.
 */
export interface Sealer { seal(plaintext: string, aad: string): string; open(sealed: string, aad: string): string }

export function localSealer(keyBase64: string, keyId = 'local-1'): Sealer {
 const key = Buffer.from(keyBase64, 'base64');
 if (key.length !== 32) throw new Error('RESOLVE_ENCRYPTION_KEY must be 32 bytes, base64-encoded');
 return {
  seal(plaintext, aad) {
   const iv = randomBytes(12);
   const cipher = createCipheriv('aes-256-gcm', key, iv);
   cipher.setAAD(Buffer.from(aad));
   const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
   return ['v1', keyId, iv.toString('base64url'), ct.toString('base64url'), cipher.getAuthTag().toString('base64url')].join(':');
  },
  open(sealed, aad) {
   const [v, kid, iv, ct, tag] = sealed.split(':');
   if (v !== 'v1' || kid !== keyId) throw new Error('Unsupported ciphertext version or key');
   const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
   decipher.setAAD(Buffer.from(aad));
   decipher.setAuthTag(Buffer.from(tag, 'base64url'));
   return Buffer.concat([decipher.update(Buffer.from(ct, 'base64url')), decipher.final()]).toString('utf8');
  },
 };
}

export const aad = {
 clientSecret: (appKey: string) => `tenant_client:${appKey}`,
 accessToken: (userId: string, appKey: string) => `grant:${userId}:${appKey}:access`,
 refreshToken: (userId: string, appKey: string) => `grant:${userId}:${appKey}:refresh`,
 auditContent: (eventId: string) => `audit:${eventId}:content`,
};
