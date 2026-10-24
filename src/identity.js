// One phone number = one person. A person is identified by their 13-digit South African ID number.
// Several businesses and both roles (entrepreneur and professional) can live on one phone number, but only for the SAME ID.
import { config } from './config.js';
import { bad, conflict, hmac, saIdValid } from './util.js';
import { audit } from './notify.js';

/** Links an ID number to the account, or checks it matches the one already linked. Only a keyed hash and the last 4 digits are stored. */
export function bindIdentity(ctx, userId, idNumber) {
  const id = String(idNumber || '').replace(/\s/g, '');
  if (!saIdValid(id)) throw bad('That is not a valid South African ID number', 'bad_id_number');
  const h = hmac(id, config.jwtSecret);
  const u = ctx.db.get('SELECT identity_hash FROM users WHERE id=?', userId);
  if (u.identity_hash) {
    if (u.identity_hash !== h) throw conflict('That ID number belongs to a different person from the one registered on this phone number. A phone number is for one person only.', 'identity_mismatch');
    return { linked: false };
  }
  // Outside demo mode, one person cannot hold two accounts on different phone numbers.
  if (!config.demo && ctx.db.get('SELECT id FROM users WHERE identity_hash=? AND id!=? AND erased_at IS NULL', h, userId))
    throw conflict('This ID number is already linked to another phone number. Contact support if you changed your number.', 'identity_taken');
  ctx.db.run('UPDATE users SET identity_hash=?, identity_last4=? WHERE id=?', h, id.slice(-4), userId);
  audit(ctx, userId, 'identity.linked', 'user', userId);
  return { linked: true };
}
