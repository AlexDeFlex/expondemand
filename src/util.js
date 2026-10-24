import crypto from 'node:crypto';

export class HttpError extends Error {
  constructor(status, message, code) { super(message); this.status = status; this.code = code || undefined; }
}
export const bad = (m, c) => new HttpError(400, m, c);
export const unauth = (m = 'Sign in required') => new HttpError(401, m, 'unauthenticated');
export const forbidden = (m = 'You are not allowed to do that') => new HttpError(403, m, 'forbidden');
export const notFound = (m = 'Not found') => new HttpError(404, m, 'not_found');
export const conflict = (m, c) => new HttpError(409, m, c || 'conflict');

export const uid = () => crypto.randomUUID();
export const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
export const hmac = (s, key) => crypto.createHmac('sha256', key).update(s).digest('hex');
export const json = (v) => JSON.stringify(v ?? null);
export const parse = (s) => (s ? JSON.parse(s) : null);

/** Money is always integer cents internally. Inputs from clients are rands. */
export function toCents(rands) {
  const n = Number(rands);
  if (!Number.isFinite(n) || n <= 0 || n > 1e8) throw bad('Amount must be a positive number of rands', 'bad_amount');
  return Math.round(n * 100);
}
export const rands = (cents) => cents / 100;

export function normPhone(p) {
  const s = String(p || '').replace(/[\s-]/g, '');
  const m = s.match(/^(?:\+27|0)([6-8]\d{8})$/);
  if (!m) throw bad('Enter a valid South African mobile number, e.g. 082 123 4567', 'bad_phone');
  return '+27' + m[1];
}

export const cipcValid = (s) => /^\d{4}\/\d{6}\/\d{2}$/.test(String(s || ''));

function luhn(digits) {
  let sum = 0, dbl = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = Number(digits[i]);
    if (dbl) { n *= 2; if (n > 9) n -= 9; }
    sum += n; dbl = !dbl;
  }
  return sum % 10 === 0;
}
/** South African ID: 13 digits, valid date part, Luhn checksum. */
export function saIdValid(s) {
  if (!/^\d{13}$/.test(s)) return false;
  const mm = +s.slice(2, 4), dd = +s.slice(4, 6);
  if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return false;
  return luhn(s);
}

export const normName = (s) => String(s || '').toLowerCase()
  .replace(/\b(pty|ltd|proprietary|limited|inc|cc|npc)\b/g, '').replace(/[^a-z0-9]/g, '');

export function stableStringify(v) {
  if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']';
  if (v && typeof v === 'object') return '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + stableStringify(v[k])).join(',') + '}';
  return JSON.stringify(v);
}

export const need = (cond, msg, code) => { if (!cond) throw bad(msg, code); };
export const str = (v, name, min = 1, max = 2000) => {
  const s = typeof v === 'string' ? v.trim() : '';
  if (s.length < min || s.length > max) throw bad(`${name} is required (${min}-${max} characters)`, 'bad_' + name);
  return s;
};
