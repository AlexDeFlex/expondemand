import { conflict } from './util.js';
import { audit } from './notify.js';

/** POPIA data-subject rights: access (export) and erasure. */
export function exportMyData(ctx, user) {
  const own = (sql, ...p) => ctx.db.all(sql, ...p);
  const businesses = ctx.db.all('SELECT id,company_name,cipc_number,director_id_last4,status,created_at FROM businesses WHERE owner_id=?', user.id);
  return {
    exported_at: ctx.clock.now(),
    account: { id: user.id, role: user.role, phone: user.phone, full_name: user.full_name, created_at: user.created_at },
    roles: ctx.db.all('SELECT role FROM user_roles WHERE user_id=?', user.id).map((r) => r.role), id_number_last4: ctx.db.get('SELECT identity_last4 FROM users WHERE id=?', user.id)?.identity_last4 || null,
    businesses,
    professional: ctx.db.get('SELECT tier,profession,body,reg_number,institution,status,rating,jobs FROM professionals WHERE user_id=?', user.id) || null,
    threads: own('SELECT id,need_type,profession,description,status,created_at FROM threads WHERE owner_id=?', user.id),
    offers: own('SELECT thread_id,kind,amount_cents,note,status,created_at FROM offers WHERE professional_id=?', user.id),
    deals: own('SELECT reference,need_type,amount_cents,status,created_at FROM deals WHERE entrepreneur_id=? OR professional_id=?', user.id, user.id),
    trusted_contacts: own('SELECT name,phone,consented_at FROM trusted_contacts WHERE user_id=?', user.id),
    notifications: own('SELECT channel,type,at FROM notifications WHERE user_id=? OR phone=? ORDER BY at DESC LIMIT 200', user.id, user.phone),
    activity: own('SELECT action,entity,at FROM audit_log WHERE actor_id=? ORDER BY at DESC LIMIT 200', user.id),
    note: 'Bank account numbers are held by our payment provider; we keep only a token and the last four digits.',
  };
}

export function eraseMe(ctx, user) {
  const open = ctx.db.get(`SELECT COUNT(*) n FROM deals WHERE (entrepreneur_id=? OR professional_id=?)
    AND status IN('awaiting_payment','in_progress','disputed','terms_pending','terms_locked','under_review')`, user.id, user.id).n;
  const threads = ctx.db.get(`SELECT COUNT(*) n FROM threads WHERE owner_id=? AND status IN('open','has_offers','matched')`, user.id).n;
  if (open || threads) throw conflict('Finish or close your open requests and deals first', 'open_obligations');
  ctx.db.tx(() => {
    ctx.db.run('DELETE FROM trusted_contacts WHERE user_id=?', user.id);
    ctx.db.run(`DELETE FROM bank_accounts WHERE (owner_type='professional' AND owner_id=?) OR (owner_type='business' AND owner_id IN(SELECT id FROM businesses WHERE owner_id=?))`, user.id, user.id);
    ctx.db.run('DELETE FROM notifications WHERE user_id=? OR phone=?', user.id, user.phone);
    ctx.db.run(`UPDATE businesses SET director_id_last4='', director_id_hash='' WHERE owner_id=?`, user.id);
    ctx.db.run('UPDATE professionals SET available=0, reg_number=NULL, proof_sha256=NULL WHERE user_id=?', user.id);
    ctx.db.run('DELETE FROM user_roles WHERE user_id=?', user.id);
    ctx.db.run('UPDATE users SET phone=?, full_name=NULL, identity_hash=NULL, identity_last4=NULL, erased_at=? WHERE id=?', 'erased-' + user.id, ctx.clock.now(), user.id);
    audit(ctx, user.id, 'user.erased', 'user', user.id);
  });
  return { erased: true, retained: 'Anonymised deal and payment records are kept for tax and dispute purposes, as the law requires.' };
}
