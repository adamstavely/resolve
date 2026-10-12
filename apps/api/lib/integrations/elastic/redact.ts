/*
 * Redaction before anything from Elastic is cached, logged, exported or shown (plan 12 §8). Telemetry text is
 * untrusted: alert reasons, error groupings and transaction names can carry tokens, card numbers or personal data.
 * Field allowlists decide what is read at all (families.ts); these scrubbers clean the free text that remains.
 */

const RULES: [RegExp, string][] = [
 // Credentials and tokens.
 [/\b(?:Bearer|ApiKey|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '[credential]'],
 [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, '[token]'],
 [/\b(password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|session|cookie|authorization)\s*[=:]\s*(?!\[)(?:"[^"]*"|'[^']*'|[^\s,;&)\]'"]+)/gi, '$1=[redacted]'],
 [/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, '[credential]'],
 [/\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{8,}\b/g, '[credential]'],
 // Contact details: email, and international-format phone numbers.
 [/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, '[email]'],
 [/\+\d{1,3}(?:[ -]?\d){7,12}\b/g, '[phone]'],
 // IBAN-like account numbers.
 [/\b[A-Z]{2}\d{2}(?:\s?[A-Z0-9]{4}){3,7}(?:\s?[A-Z0-9]{1,3})?\b/g, '[account]'],
];

const CARD_CANDIDATE = /\b\d(?:[ -]?\d){12,18}\b/g;

function luhn(digits: string) {
 let sum = 0; let double = false;
 for (let i = digits.length - 1; i >= 0; i--) {
  let d = digits.charCodeAt(i) - 48;
  if (double) { d *= 2; if (d > 9) d -= 9; }
  sum += d; double = !double;
 }
 return sum % 10 === 0;
}

/** Scrub secrets, payment card numbers (Luhn-valid) and contact details from free text, and bound its length. */
export function redactText(input: string | null | undefined, max = 500): string | null {
 if (input === null || input === undefined) return null;
 let s = String(input).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
 for (const [re, rep] of RULES) s = s.replace(re, rep);
 s = s.replace(CARD_CANDIDATE, m => { const d = m.replace(/[ -]/g, ''); return d.length >= 13 && d.length <= 19 && luhn(d) ? '[card]' : m; });
 return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

/** Identifiers we display (trace/transaction ids, monitor ids): hex or simple tokens only, otherwise dropped. */
export function safeId(v: unknown, max = 128): string | null {
 return typeof v === 'string' && v.length <= max && /^[A-Za-z0-9._:-]+$/.test(v) ? v : null;
}
