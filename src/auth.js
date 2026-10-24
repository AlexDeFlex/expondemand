import crypto from 'node:crypto';
import { config } from './config.js';
import { HttpError, bad, unauth, forbidden, uid, sha256, normPhone } from './util.js';
import { audit } from './notify.js';
import { bindIdentity } from './identity.js';

const b64 = (b) => Buffer.from(b).toString('base64url');
const sign = (data) => crypto.createHmac('sha256', config.jwtSecret).update(data).digest('base64url');

export function signToken(user, now, sid) {
  const head = b64(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64(JSON.stringify({ sub: user.id, sid, role: user.role, exp: now + config.tokenTtlMs }));
  return `${head}.${body}.${sign(head + '.' + body)}`;
}
export function readToken(token, now) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) throw unauth();
  const expected = sign(parts[0] + '.' + parts[1]);
  const a = Buffer.from(parts[2]), b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw unauth('Invalid token');
  const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
  if (payload.exp < now) throw unauth('Session expired');
  return payload;
}

export async function requestOtp(ctx, phoneRaw) {
  const phone = normPhone(phoneRaw);
  const now = ctx.clock.now();
  const row = ctx.db.get('SELECT * FROM otps WHERE phone=?', phone);
  if (row && row.locked_until > now) throw new HttpError(429, 'Too many attempts. Try again later.', 'locked');
  let windowStart = row?.window_start || 0, sent = row?.sent_count || 0;
  if (now - windowStart > 3600e3) { windowStart = now; sent = 0; }
  if (sent >= config.otpMaxSendsPerHour) throw new HttpError(429, 'Too many codes requested. Try again later.', 'rate_limited');
  if (ctx.db.get(`SELECT COUNT(*) n FROM notifications WHERE channel='sms' AND type='otp' AND at>?`, now - 24 * 3600e3).n >= config.smsDailyCap)
    throw new HttpError(503, 'We cannot send more codes right now. Please try again tomorrow.', 'sms_budget');
  const code = config.devOtp || String(crypto.randomInt(100000, 1000000));
  ctx.db.run(
    `INSERT INTO otps(phone,code_hash,expires_at,attempts,locked_until,window_start,sent_count) VALUES(?,?,?,?,?,?,?)
     ON CONFLICT(phone) DO UPDATE SET code_hash=excluded.code_hash, expires_at=excluded.expires_at, attempts=0,
       window_start=excluded.window_start, sent_count=excluded.sent_count`,
    phone, sha256(code + phone), now + config.otpTtlMs, 0, 0, windowStart, sent + 1);
  const sent_ = await ctx.notify.smsNow(phone, 'otp', { text: `${code} is your ExpOnDemand code. It expires in 5 minutes. Never share it.` });
  if (!sent_.ok) throw new HttpError(502, 'We could not send your code just now. Please try again.', 'sms_failed');
  return { sent: true, expires_in_seconds: config.otpTtlMs / 1000, ...(config.devOtp ? { dev_hint: `Dev mode: the code is ${config.devOtp}` } : {}) };
}

/** Checks a code and consumes it. Shared by sign-in and the "confirm it is you" step-up. */
function consumeOtp(ctx, phone, code) {
  const now = ctx.clock.now();
  const row = ctx.db.get('SELECT * FROM otps WHERE phone=?', phone);
  if (!row) throw bad('Request a code first', 'no_code');
  if (row.locked_until > now) throw new HttpError(429, 'Too many attempts. Try again later.', 'locked');
  if (row.expires_at < now) throw bad('That code has expired. Request a new one.', 'expired');
  if (sha256(String(code || '') + phone) !== row.code_hash) {
    const attempts = row.attempts + 1;
    const lock = attempts >= config.otpMaxAttempts ? now + config.otpLockMs : 0;
    ctx.db.run('UPDATE otps SET attempts=?, locked_until=? WHERE phone=?', attempts, lock, phone);
    throw new HttpError(401, lock ? 'Too many wrong codes. Locked for a few minutes.' : `Wrong code. ${config.otpMaxAttempts - attempts} tries left.`, 'wrong_code');
  }
  ctx.db.run('DELETE FROM otps WHERE phone=?', phone);
}

export const rolesOf = (ctx, userId) => ctx.db.all('SELECT role FROM user_roles WHERE user_id=? ORDER BY created_at', userId).map((r) => r.role);
const addRoleRow = (ctx, userId, role) => ctx.db.run('INSERT OR IGNORE INTO user_roles(user_id,role,created_at) VALUES(?,?,?)', userId, role, ctx.clock.now());

/**
 * mode 'signin': only for numbers that already have an account. mode 'signup': creates one (needs a role).
 * The code is checked first, so this never reveals whether a number is registered to someone who cannot receive its texts.
 * One phone number can hold both roles. If the person asks for a role they do not have yet, they are signed in with the one they do
 * have and told which role is missing; adding it needs their ID number (see addRole).
 */
export function verifyOtp(ctx, { phone: phoneRaw, code, role, mode }) {
  const phone = normPhone(phoneRaw);
  const now = ctx.clock.now();
  consumeOtp(ctx, phone, code);
  let user = ctx.db.get('SELECT * FROM users WHERE phone=? AND erased_at IS NULL', phone);
  let created = false;
  if (!user && mode === 'signin') throw new HttpError(404, 'No account for this number yet. Create an account first.', 'no_account');
  if (!user) {
    if (!['entrepreneur', 'professional'].includes(role)) throw bad('Choose entrepreneur or professional to create an account', 'role_required');
    user = { id: uid(), phone, role, full_name: null, created_at: now };
    ctx.db.run('INSERT INTO users(id,phone,role,created_at) VALUES(?,?,?,?)', user.id, phone, role, now);
    addRoleRow(ctx, user.id, role);
    created = true;
  }
  const roles = rolesOf(ctx, user.id);
  const active = roles.includes(role) ? role : roles[0];
  // One session per device. It lasts 30 days, so people are not asked for a code after every request.
  const sid = uid();
  ctx.db.run('INSERT INTO sessions(id,user_id,created_at,expires_at,last_otp_at,active_role) VALUES(?,?,?,?,?,?)', sid, user.id, now, now + config.tokenTtlMs, now, active);
  audit(ctx, user.id, created ? 'user.created' : 'user.login', 'user', user.id);
  const missing = ['entrepreneur', 'professional'].includes(role) && !roles.includes(role) && !roles.includes('admin') ? role : null;
  return { token: signToken(user, now, sid), user: publicUser({ ...user, role: active }), roles, created, missing_role: missing };
}

/** Switch which hat you are wearing on this device. Both roles live on the same phone number. */
export function switchRole(ctx, user, session, role) {
  if (!rolesOf(ctx, user.id).includes(role)) throw new HttpError(403, `This number is not registered as ${role === 'entrepreneur' ? 'an entrepreneur' : 'a professional'} yet`, 'role_not_registered');
  ctx.db.run('UPDATE sessions SET active_role=? WHERE id=?', role, session.id);
  audit(ctx, user.id, 'auth.switch_role', 'user', user.id, { role });
  return { role, roles: rolesOf(ctx, user.id) };
}

/** Add the second role to this phone number. Needs the ID number, which must belong to the same person. */
export function addRole(ctx, user, session, { role, id_number }) {
  if (!['entrepreneur', 'professional'].includes(role)) throw bad('role must be entrepreneur or professional', 'bad_role');
  const roles = rolesOf(ctx, user.id);
  if (roles.includes('admin')) throw new HttpError(403, 'Staff accounts cannot take other roles', 'forbidden');
  requireFresh(ctx, session);                          // identity is sensitive: a recent code is required
  bindIdentity(ctx, user.id, id_number);
  addRoleRow(ctx, user.id, role);
  ctx.db.run('UPDATE sessions SET active_role=? WHERE id=?', role, session.id);
  audit(ctx, user.id, 'auth.role_added', 'user', user.id, { role });
  return { role, roles: rolesOf(ctx, user.id) };
}

export function logout(ctx, session) {
  ctx.db.run('UPDATE sessions SET revoked_at=? WHERE id=?', ctx.clock.now(), session.id);
  return { signed_out: true };
}
export const stepUpRequest = (ctx, user) => requestOtp(ctx, user.phone);
export function stepUpVerify(ctx, user, session, code) {
  consumeOtp(ctx, user.phone, code);
  ctx.db.run('UPDATE sessions SET last_otp_at=? WHERE id=?', ctx.clock.now(), session.id);
  audit(ctx, user.id, 'auth.step_up', 'user', user.id);
  return { confirmed: true, valid_for_minutes: config.stepUpWindowMs / 60000 };
}
/** Sensitive actions (bank details) need a code from the last few minutes, even if the device is already signed in. */
export function requireFresh(ctx, session) {
  if (ctx.clock.now() - session.last_otp_at > config.stepUpWindowMs)
    throw new HttpError(403, 'For your security, confirm it is you with a new code first', 'step_up_required');
}

export const publicUser = (u) => ({ id: u.id, role: u.role, phone: u.phone.slice(0, 5) + '****' + u.phone.slice(-3), full_name: u.full_name });

export function seedAdmin(ctx) {
  if (!config.adminPhone) return;
  const phone = normPhone(config.adminPhone);
  if (!ctx.db.get('SELECT id FROM users WHERE phone=?', phone))
  { const id = uid(); ctx.db.run('INSERT INTO users(id,phone,role,created_at) VALUES(?,?,?,?)', id, phone, 'admin', ctx.clock.now()); addRoleRow(ctx, id, 'admin'); }
}

/** Express middleware factory */
export function authn(ctx) {
  return (req, _res, next) => {
    try {
      const h = req.headers.authorization || '';
      const p = readToken(h.startsWith('Bearer ') ? h.slice(7) : '', ctx.clock.now());
      const user = ctx.db.get('SELECT * FROM users WHERE id=? AND erased_at IS NULL', p.sub);
      const session = p.sid && ctx.db.get('SELECT * FROM sessions WHERE id=? AND revoked_at IS NULL AND expires_at>?', p.sid, ctx.clock.now());
      if (!user || !session) throw unauth();     // signed out, expired, or erased
      req.user = { ...user, role: session.active_role || user.role };   // the hat worn on this device right now
      req.session = session; req.roles = rolesOf(ctx, user.id);
      next();
    } catch (e) { next(e); }
  };
}
export const role = (...roles) => (req, _res, next) =>
  roles.includes(req.user.role) ? next() : next(forbidden(`This action is for ${roles.join(' or ')} accounts`));
