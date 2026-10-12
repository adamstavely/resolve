import { isIP } from 'node:net';

/*
 * Address classification for the egress check (plan 12 §9 E5: "private-network trace confirms no public
 * dependencies"). Resolve is intranet-only: every endpoint it calls must resolve to loopback or private space.
 */
export type AddressClass = 'loopback' | 'private' | 'public' | 'invalid';

const v4 = (ip: string) => ip.split('.').reduce((n, o) => (n << 8) + Number(o), 0) >>> 0;
const in4 = (ip: number, base: string, bits: number) => (ip >>> (32 - bits)) === (v4(base) >>> (32 - bits));

export function classify(address: string): AddressClass {
 const f = isIP(address);
 if (f === 4) {
  const n = v4(address);
  if (in4(n, '127.0.0.0', 8)) return 'loopback';
  if (in4(n, '10.0.0.0', 8) || in4(n, '172.16.0.0', 12) || in4(n, '192.168.0.0', 16) || in4(n, '100.64.0.0', 10)) return 'private';
  if (in4(n, '0.0.0.0', 8) || in4(n, '169.254.0.0', 16) || in4(n, '224.0.0.0', 4) || in4(n, '240.0.0.0', 4)) return 'invalid';
  return 'public';
 }
 if (f === 6) {
  const a = address.toLowerCase();
  if (a === '::1') return 'loopback';
  const mapped = a.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return classify(mapped[1]);
  if (/^f[cd]/.test(a)) return 'private';
  if (a === '::' || /^fe[89ab]/.test(a) || a.startsWith('ff')) return 'invalid';
  return 'public';
 }
 return 'invalid';
}

/** A host passes only when every address it resolves to is loopback or private. */
export function verdict(classes: AddressClass[]): 'ok' | 'public' | 'unresolved' {
 if (classes.length === 0) return 'unresolved';
 return classes.every(c => c === 'loopback' || c === 'private') ? 'ok' : 'public';
}
