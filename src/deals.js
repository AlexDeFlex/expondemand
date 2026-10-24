import { config } from './config.js';
import { HttpError, bad, conflict, forbidden, notFound, uid, str, need, json, parse, sha256, stableStringify, toCents } from './util.js';
import { audit } from './notify.js';
import { feeFor } from './payments.js';
import { activeAccount } from './onboarding.js';
import { settleThread, reopenThread } from './threads.js';

export function getDealFor(ctx, user, dealId) {
  const deal = ctx.db.get('SELECT * FROM deals WHERE id=?', dealId);
  if (!deal) throw notFound('Deal not found');
  const role = user.id === deal.entrepreneur_id ? 'entrepreneur' : user.id === deal.professional_id ? 'professional' : user.role === 'admin' ? 'admin' : null;
  if (!role) throw forbidden('You are not a party to this deal');   // third parties can never see a deal
  return { deal, role };
}
const other = (role) => (role === 'entrepreneur' ? 'professional' : 'entrepreneur');
const partyId = (deal, role) => (role === 'entrepreneur' ? deal.entrepreneur_id : deal.professional_id);

export function presentDeal(ctx, deal, role) {
  const pay = ctx.db.get('SELECT * FROM payments WHERE deal_id=?', deal.id);
  const affs = ctx.db.all(`SELECT * FROM affidavits WHERE deal_id=? AND status!='superseded'`, deal.id);
  const th = ctx.db.get('SELECT profession, description FROM threads WHERE id=?', deal.thread_id);
  const pro = ctx.db.get('SELECT p.*, u.full_name FROM professionals p JOIN users u ON u.id=p.user_id WHERE p.user_id=?', deal.professional_id);
  const biz = ctx.db.get('SELECT company_name FROM businesses WHERE id=?', deal.business_id);
  const proBadge = pro.tier === 1 ? (pro.body && pro.body !== 'No statutory body' ? `Tier 1 \u00b7 ${pro.body} ${pro.reg_number}` : 'Qualification verified') : pro.tier === 2 ? 'Candidate, supervised' : `Graduate \u00b7 ${pro.institution}`;
  return {
    thread_id: deal.thread_id, profession: th.profession, description: th.description, created_at: deal.created_at,
    counterparty: role === 'professional' ? { name: biz.company_name, badge: 'Verified business' } : { name: pro.full_name, badge: proBadge },
    id: deal.id, reference: deal.reference, need_type: deal.need_type, status: deal.status, terms_version: deal.terms_version,
    amount_rands: deal.amount_cents && deal.amount_cents / 100, terms: parse(deal.terms), terms_hash: deal.terms_hash,
    locked: { entrepreneur: !!deal.lock_e, professional: !!deal.lock_p },
    payment: pay && { status: pay.status, payout_status: pay.payout_status, amount_rands: pay.amount_cents / 100, platform_fee_rands: pay.fee_cents / 100, expert_receives_rands: pay.payout_cents / 100 },
    affidavits: affs.map((a) => ({ role: a.party_role, status: a.status, due: deal.affidavit_due })),
    your_role: role,
    split_preview: deal.amount_cents ? feeFor(deal.amount_cents) : null,
    delivered_at: deal.delivered_at || null, auto_release_at: deal.auto_release_at || null,
    reviews: role === 'admin' ? null : (() => {
      const mine = role, theirs = other(role), me = partyId(deal, role);
      const ver = (r) => ctx.db.get(`SELECT id FROM affidavits WHERE deal_id=? AND party_role=? AND status='verified' ORDER BY created_at DESC LIMIT 1`, deal.id, r);
      const done = (aff, who) => !!(aff && ctx.db.get(`SELECT id FROM affidavit_reviews WHERE affidavit_id=? AND reviewer_id=? AND decision='confirmed'`, aff.id, who));
      return { i_confirmed_theirs: done(ver(theirs), me), they_confirmed_mine: done(ver(mine), partyId(deal, theirs)) };
    })(),
    cancel_requested_by: deal.cancel_requested_by || null,
    can_cancel: ['awaiting_payment', 'terms_pending', 'terms_locked', 'under_review', 'in_progress', 'formalised'].includes(deal.status),
    can_remove: ['completed', 'refunded', 'cancelled'].includes(deal.status),
  };
}

/* ===================== Consultation money flow ===================== */
export async function pay(ctx, user, dealId, b) {
  const { deal, role } = getDealFor(ctx, user, dealId);
  if (role !== 'entrepreneur') throw forbidden('Only the entrepreneur pays');
  if (deal.need_type !== 'consultation') throw bad('Licensing deals are settled under their formalised terms', 'not_consultation');
  const key = String(b.idempotency_key || `pay-${dealId}`);
  const existing = ctx.db.get('SELECT * FROM payments WHERE idempotency_key=?', key);
  if (existing) return { payment_id: existing.id, status: existing.status, duplicate: true };   // safe to retry, never charges twice
  if (deal.status !== 'awaiting_payment') throw conflict('This deal is not waiting for payment', 'bad_state');
  const method = b.method;
  need(['card', 'linked_eft', 'instant_eft'].includes(method), 'method must be card, linked_eft or instant_eft', 'bad_method');
  if (method === 'linked_eft') {
    const acct = activeAccount(ctx, 'business', deal.business_id);
    if (!acct || acct.status !== 'verified') throw bad('Link and verify your business bank account first', 'no_linked_account');
  }
  const split = feeFor(deal.amount_cents);
  const res = await ctx.provider.charge({ amountCents: deal.amount_cents, method, token: b.token, ref: deal.reference });
  if (!res.ok) throw new HttpError(402, res.reason || 'Payment failed', 'payment_failed');
  try {
    return ctx.db.tx(() => {
      const d = ctx.db.get('SELECT status FROM deals WHERE id=?', dealId);
      if (d.status !== 'awaiting_payment') throw conflict('Deal state changed during payment', 'bad_state');
      const pid = uid();
      ctx.db.run(`INSERT INTO payments(id,deal_id,amount_cents,fee_cents,payout_cents,method,provider_ref,idempotency_key,status,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)`,
        pid, dealId, split.amount_cents, split.fee_cents, split.payout_cents, method, res.ref, key, 'held', ctx.clock.now());
      ctx.db.run(`UPDATE deals SET status='in_progress' WHERE id=?`, dealId);
      ctx.notify.push(deal.professional_id, 'payment.held', { deal_id: dealId, reference: deal.reference });
      audit(ctx, user.id, 'payment.held', 'deal', dealId, { method });
      return { payment_id: pid, status: 'held', split: { ...split, rate: undefined } };
    });
  } catch (e) { await ctx.provider.refund({ ref: res.ref }); throw e; }   // compensate: never keep money for a failed booking
}

export function deliver(ctx, user, dealId) {
  const { deal, role } = getDealFor(ctx, user, dealId);
  if (role !== 'professional') throw forbidden('Only the expert marks work delivered');
  if (deal.status !== 'in_progress') throw conflict('Nothing to deliver yet', 'bad_state');
  const at = ctx.clock.now() + config.autoReleaseMs;
  ctx.db.run('UPDATE deals SET delivered_at=?, auto_release_at=? WHERE id=?', ctx.clock.now(), at, dealId);
  ctx.notify.push(deal.entrepreneur_id, 'deal.delivered', { deal_id: dealId, auto_release_at: at });
  return { delivered: true, auto_release_at: at };
}

export async function confirm(ctx, user, dealId) {
  const { deal, role } = getDealFor(ctx, user, dealId);
  if (role !== 'entrepreneur') throw forbidden('Only the entrepreneur confirms');
  if (deal.status !== 'in_progress') throw conflict('Deal is not in progress', 'bad_state');
  return release(ctx, dealId, user.id);
}

/** Release held funds: state change is atomic, the payout to the expert follows and is retried if the bank fails. */
export async function release(ctx, dealId, actorId) {
  const out = ctx.db.tx(() => {
    const p = ctx.db.get(`SELECT * FROM payments WHERE deal_id=? AND status IN('held','disputed')`, dealId);
    if (!p) throw conflict('No held payment for this deal', 'no_payment');
    const now = ctx.clock.now();
    ctx.db.run(`UPDATE payments SET status='released', released_at=?, payout_status='pending' WHERE id=?`, now, p.id);
    const d = ctx.db.get('SELECT * FROM deals WHERE id=?', dealId);
    ctx.db.run(`UPDATE deals SET status='completed' WHERE id=?`, dealId);
    settleThread(ctx, d.thread_id);
    ctx.db.run('UPDATE professionals SET jobs=jobs+1 WHERE user_id=?', d.professional_id);
    audit(ctx, actorId, 'payment.released', 'deal', dealId);
    return { payment: p, deal: d };
  });
  const payout = await tryPayout(ctx, out.payment.id);
  return { released: true, split: { amount_rands: out.payment.amount_cents / 100, platform_fee_rands: out.payment.fee_cents / 100, expert_receives_rands: out.payment.payout_cents / 100 }, payout_status: payout };
}

async function tryPayout(ctx, paymentId) {
  const p = ctx.db.get('SELECT * FROM payments WHERE id=?', paymentId);
  const d = ctx.db.get('SELECT * FROM deals WHERE id=?', p.deal_id);
  const acct = activeAccount(ctx, 'professional', d.professional_id);
  // No verified account, or the account was changed in the last 48h: keep the payout pending, never send to an unverified account.
  if (!acct || acct.status !== 'verified' || acct.hold_until > ctx.clock.now()) {
    ctx.notify.push(d.professional_id, 'payout.waiting', { reason: !acct ? 'no_account' : 'account_hold' });
    return 'pending';
  }
  const r = await ctx.provider.payout({ amountCents: p.payout_cents, accountToken: acct.token, ref: d.reference });
  ctx.db.run('UPDATE payments SET payout_status=?, payout_ref=? WHERE id=?', r.ok ? 'paid' : 'failed', r.ref || null, paymentId);
  ctx.notify.push(d.professional_id, r.ok ? 'payout.paid' : 'payout.failed', { amount_rands: p.payout_cents / 100 });
  return r.ok ? 'paid' : 'failed';
}

export function dispute(ctx, user, dealId, b) {
  const { deal } = getDealFor(ctx, user, dealId);
  const reason = str(b.reason, 'reason', 10, 1000);
  if (deal.status !== 'in_progress') throw conflict('Only an in-progress deal can be disputed', 'bad_state');
  ctx.db.tx(() => {
    ctx.db.run(`UPDATE payments SET status='disputed' WHERE deal_id=? AND status='held'`, dealId);
    ctx.db.run(`UPDATE deals SET status='disputed', auto_release_at=NULL WHERE id=?`, dealId);
    audit(ctx, user.id, 'deal.disputed', 'deal', dealId, { reason });
  });
  [deal.entrepreneur_id, deal.professional_id].filter((u) => u !== user.id).forEach((u) => ctx.notify.push(u, 'deal.disputed', { deal_id: dealId }));
  return { status: 'disputed' };
}

export async function resolveDispute(ctx, admin, dealId, b) {
  const deal = ctx.db.get('SELECT * FROM deals WHERE id=?', dealId);
  if (!deal || deal.status !== 'disputed') throw conflict('Deal is not in dispute', 'bad_state');
  if (b.outcome === 'release') return release(ctx, dealId, admin.id);
  need(b.outcome === 'refund', 'outcome must be release or refund', 'bad_outcome');
  const p = ctx.db.get(`SELECT * FROM payments WHERE deal_id=? AND status='disputed'`, dealId);
  await ctx.provider.refund({ ref: p.provider_ref });
  ctx.db.tx(() => {
    ctx.db.run(`UPDATE payments SET status='refunded' WHERE id=?`, p.id);
    ctx.db.run(`UPDATE deals SET status='refunded' WHERE id=?`, dealId);
    audit(ctx, admin.id, 'deal.refunded', 'deal', dealId);
  });
  return { refunded: true, amount_rands: p.amount_cents / 100 };
}

/** Scheduled job: auto-release after the confirmation window, and retry payouts that were waiting. */
export async function runPaymentMaintenance(ctx) {
  const now = ctx.clock.now();
  let auto = 0, retried = 0;
  for (const d of ctx.db.all(`SELECT id FROM deals WHERE status='in_progress' AND auto_release_at IS NOT NULL AND auto_release_at<?`, now)) { await release(ctx, d.id, null); auto++; }
  for (const p of ctx.db.all(`SELECT id FROM payments WHERE status='released' AND payout_status IN('pending','failed')`)) {
    if (await tryPayout(ctx, p.id) === 'paid') retried++;
  }
  return { auto_released: auto, payouts_completed: retried };
}

/* ===================== Licensing: terms, affidavits, mutual review ===================== */
const needLicensing = (deal) => { if (deal.need_type !== 'licensing') throw bad('Only licensing deals use terms and affidavits', 'not_licensing'); };
const hashTerms = (deal, terms, version) => sha256(stableStringify({ reference: deal.reference, version, terms }));

export function updateTerms(ctx, user, dealId, b) {
  const { deal, role } = getDealFor(ctx, user, dealId);
  if (role === 'admin') throw forbidden();
  needLicensing(deal);
  if (!['terms_pending', 'terms_locked', 'under_review'].includes(deal.status)) throw conflict('Terms can no longer be changed', 'bad_state');
  const t = b.terms || {};
  const cur = parse(deal.terms) || {};
  const next = { ...cur };
  if ('share_percent' in cur) { const n = Number(t.share_percent); need(n > 0 && n <= 100, 'share_percent must be 1-100', 'bad_terms'); next.share_percent = n; }
  if ('monthly_retainer_cents' in cur) next.monthly_retainer_cents = toCents(t.monthly_retainer);
  if (t.scope) next.scope = str(t.scope, 'scope', 5, 500);
  supersedeAll(ctx, deal.id, user.id, 'terms_changed');
  const v = deal.terms_version + 1;
  ctx.db.run(`UPDATE deals SET terms=?, terms_version=?, terms_hash=NULL, lock_e=0, lock_p=0, status='terms_pending' WHERE id=?`, json(next), v, deal.id);
  ctx.notify.push(partyId(deal, other(role)), 'terms.changed', { deal_id: deal.id, version: v });
  return { terms_version: v, status: 'terms_pending' };
}

function supersedeAll(ctx, dealId, actorId, why) {
  const ids = ctx.db.all(`SELECT id FROM affidavits WHERE deal_id=? AND status!='superseded'`, dealId);
  ids.forEach((a) => { ctx.db.run(`UPDATE affidavits SET status='superseded' WHERE id=?`, a.id); ctx.db.run('DELETE FROM affidavit_reviews WHERE affidavit_id=?', a.id); });
  if (ids.length) audit(ctx, actorId, 'affidavits.superseded', 'deal', dealId, { why });   // old sworn statements never count for new terms
}

export function lockTerms(ctx, user, dealId) {
  const { deal, role } = getDealFor(ctx, user, dealId);
  if (role === 'admin') throw forbidden();
  needLicensing(deal);
  if (deal.status !== 'terms_pending') throw conflict('Terms are not open for locking', 'bad_state');
  return ctx.db.tx(() => {
    ctx.db.run(`UPDATE deals SET ${role === 'entrepreneur' ? 'lock_e' : 'lock_p'}=1 WHERE id=?`, dealId);
    const d = ctx.db.get('SELECT * FROM deals WHERE id=?', dealId);
    if (!(d.lock_e && d.lock_p)) { ctx.notify.push(partyId(deal, other(role)), 'terms.lock_requested', { deal_id: dealId }); return { status: 'terms_pending', waiting_for: other(role) }; }
    const hash = hashTerms(d, parse(d.terms), d.terms_version), now = ctx.clock.now();
    ctx.db.run(`UPDATE deals SET terms_hash=?, status='terms_locked', affidavit_due=? WHERE id=?`, hash, now + 7 * 24 * 3600e3, dealId);
    for (const r of ['entrepreneur', 'professional'])
      ctx.db.run(`INSERT INTO affidavits(id,deal_id,party_user_id,party_role,terms_version,terms_hash,status,created_at) VALUES(?,?,?,?,?,?,?,?)`, uid(), dealId, partyId(d, r), r, d.terms_version, hash, 'pending', now);
    audit(ctx, user.id, 'terms.locked', 'deal', dealId, { hash });
    return { status: 'terms_locked', terms_hash: hash };
  });
}

const currentAffidavit = (ctx, dealId, role) => ctx.db.get(`SELECT * FROM affidavits WHERE deal_id=? AND party_role=? AND status!='superseded' ORDER BY created_at DESC LIMIT 1`, dealId, role);

/** The affidavit text each party swears. Templates are versioned in a real build and reviewed by your lawyer. */
export function affidavitText(ctx, deal, role) {
  const ref = `${deal.reference} (terms v${deal.terms_version}, fingerprint ${String(deal.terms_hash).slice(0, 12)})`;
  if (role === 'professional') {
    const p = ctx.db.get('SELECT p.*, u.full_name FROM professionals p JOIN users u ON u.id=p.user_id WHERE p.user_id=?', deal.professional_id);
    const reg = p.body && p.body !== 'No statutory body' ? `registered with ${p.body}, number ${p.reg_number}` : `qualified as ${p.profession}`;
    return `I, ${p.full_name}, ${reg}, swear that the terms of deal ${ref} are those I propose and will abide by; that I will provide real, active oversight of the work; and that I am not lending my registration or qualification for work I do not supervise.`;
  }
  const b = ctx.db.get('SELECT * FROM businesses WHERE id=?', deal.business_id);
  return `I, a director of ${b.company_name} (CIPC ${b.cipc_number}), swear that the terms of deal ${ref} are those I propose and will abide by, and that I will not use the professional's registration or qualification beyond the agreed scope.`;
}

export function uploadAffidavit(ctx, user, dealId, b) {
  const { deal, role } = getDealFor(ctx, user, dealId);
  if (role === 'admin') throw forbidden();
  needLicensing(deal);
  if (!['terms_locked', 'under_review'].includes(deal.status)) throw conflict('Lock the terms before swearing affidavits', 'bad_state');
  const a = currentAffidavit(ctx, dealId, role);
  if (!a || !['pending', 'rejected'].includes(a.status)) throw conflict('Your affidavit is already submitted', 'bad_state');
  need(/^[a-f0-9]{64}$/.test(String(b.file_sha256 || '')), 'file_sha256 (SHA-256 of the commissioned scan) is required', 'bad_file');
  const name = str(b.commissioner_name, 'commissioner_name', 3, 100);
  const on = String(b.commissioned_on || '');
  need(/^\d{4}-\d{2}-\d{2}$/.test(on) && new Date(on).getTime() <= ctx.clock.now(), 'commissioned_on must be a past date (YYYY-MM-DD)', 'bad_date');
  ctx.db.run(`UPDATE affidavits SET status='uploaded', file_sha256=?, commissioner_name=?, commissioner_station=?, commissioned_on=?, rejection_reason=NULL WHERE id=?`,
    b.file_sha256, name, b.commissioner_station ? str(b.commissioner_station, 'commissioner_station', 2, 100) : null, on, a.id);
  audit(ctx, user.id, 'affidavit.uploaded', 'affidavit', a.id);
  return { affidavit_id: a.id, status: 'uploaded' };
}

export function verifyAffidavit(ctx, admin, affidavitId, b) {
  const a = ctx.db.get('SELECT * FROM affidavits WHERE id=?', affidavitId);
  if (!a || a.status !== 'uploaded') throw conflict('Affidavit is not waiting for review', 'bad_state');
  const deal = ctx.db.get('SELECT * FROM deals WHERE id=?', a.deal_id);
  if (a.terms_hash !== deal.terms_hash) throw conflict('Affidavit is for outdated terms', 'outdated');
  const ok = b.approve === true;
  if (!ok) need(b.reason, 'Give a rejection reason', 'no_reason');
  ctx.db.run('UPDATE affidavits SET status=?, rejection_reason=?, verified_by=?, verified_at=? WHERE id=?', ok ? 'verified' : 'rejected', ok ? null : b.reason, admin.id, ctx.clock.now(), a.id);
  audit(ctx, admin.id, ok ? 'affidavit.verified' : 'affidavit.rejected', 'affidavit', a.id);
  ctx.notify.push(a.party_user_id, ok ? 'affidavit.verified' : 'affidavit.rejected', { deal_id: a.deal_id, reason: b.reason || null });
  if (ok) {
    const both = ['entrepreneur', 'professional'].every((r) => currentAffidavit(ctx, deal.id, r)?.status === 'verified');
    if (both) {
      ctx.db.run(`UPDATE deals SET status='under_review' WHERE id=? AND status='terms_locked'`, deal.id);
      [deal.entrepreneur_id, deal.professional_id].forEach((u) => ctx.notify.push(u, 'affidavit.ready_for_review', { deal_id: deal.id }));
    }
  }
  return { id: a.id, status: ok ? 'verified' : 'rejected' };
}

/** What the OTHER party sees: redacted, current-version only, watermarked, and logged. Never the original scan. */
export function viewCounterpartyAffidavit(ctx, user, dealId) {
  const { deal, role } = getDealFor(ctx, user, dealId);
  if (role === 'admin') throw forbidden('Staff use the review queue');
  needLicensing(deal);
  const a = currentAffidavit(ctx, dealId, other(role));
  if (!a || a.status !== 'verified' || a.terms_hash !== deal.terms_hash) throw forbidden('That affidavit is not available yet');
  audit(ctx, user.id, 'affidavit.view', 'affidavit', a.id);
  const biz = ctx.db.get('SELECT * FROM businesses WHERE id=?', deal.business_id);
  const pro = ctx.db.get('SELECT p.*, u.full_name FROM professionals p JOIN users u ON u.id=p.user_id WHERE p.user_id=?', deal.professional_id);
  const deponent = a.party_role === 'professional'
    ? { role: 'professional', name: pro.full_name, registration: pro.body && pro.body !== 'No statutory body' ? { body: pro.body, number: pro.reg_number } : { qualification: pro.profession } }
    : { role: 'entrepreneur', company: biz.company_name, cipc_number: biz.cipc_number };
  return {
    deal_reference: deal.reference, terms_version: deal.terms_version, terms_hash: deal.terms_hash, deponent,
    statement: affidavitText(ctx, deal, a.party_role),
    commissioner: { name: a.commissioner_name, station: a.commissioner_station, date: a.commissioned_on },
    redacted: ['id_number', 'home_address', 'original_scan'],
    watermark: `Viewed by ${user.full_name || 'party'} for ${deal.reference} on ${new Date(ctx.clock.now()).toISOString().slice(0, 10)}`,
  };
}

export function reviewAffidavit(ctx, user, dealId, b) {
  const { deal, role } = getDealFor(ctx, user, dealId);
  if (role === 'admin') throw forbidden();
  needLicensing(deal);
  need(['confirmed', 'disputed'].includes(b.decision), 'decision must be confirmed or disputed', 'bad_decision');
  const a = currentAffidavit(ctx, dealId, other(role));
  if (!a || a.status !== 'verified') throw conflict('Nothing to review yet', 'bad_state');
  // You must have actually opened it before you can confirm it.
  if (!ctx.db.get(`SELECT id FROM audit_log WHERE actor_id=? AND action='affidavit.view' AND entity_id=?`, user.id, a.id)) throw conflict('Read the affidavit before confirming', 'not_viewed');
  if (b.decision === 'disputed') {
    str(b.comment, 'comment', 5, 500);
    ctx.db.tx(() => {
      supersedeAll(ctx, dealId, user.id, 'disputed');
      ctx.db.run(`UPDATE deals SET terms_version=terms_version+1, terms_hash=NULL, lock_e=0, lock_p=0, status='terms_pending' WHERE id=?`, dealId);
    });
    ctx.notify.push(partyId(deal, other(role)), 'terms.disputed', { deal_id: dealId });
    return { status: 'terms_pending', note: 'Terms reopened. New affidavits are needed for the new version.' };
  }
  ctx.db.run(`INSERT INTO affidavit_reviews(id,affidavit_id,reviewer_id,decision,comment,decided_at) VALUES(?,?,?,?,?,?)
              ON CONFLICT(affidavit_id,reviewer_id) DO UPDATE SET decision=excluded.decision, decided_at=excluded.decided_at`, uid(), a.id, user.id, 'confirmed', b.comment || null, ctx.clock.now());
  return tryFormalise(ctx, deal);
}

function tryFormalise(ctx, deal) {
  const cur = ['entrepreneur', 'professional'].map((r) => currentAffidavit(ctx, deal.id, r));
  const verified = cur.every((a) => a?.status === 'verified' && a.terms_hash === deal.terms_hash);
  const confirmed = verified && cur.every((a) => ctx.db.get(`SELECT id FROM affidavit_reviews WHERE affidavit_id=? AND decision='confirmed'`, a.id));
  if (!confirmed) return { status: deal.status, waiting_for: 'the other party to confirm' };
  const now = ctx.clock.now();
  ctx.db.tx(() => {
    ctx.db.run(`UPDATE deals SET status='formalised', formalised_at=? WHERE id=?`, now, deal.id);
    settleThread(ctx, deal.thread_id);   // thread is archived ~7 days after every hired expert's deal is finished
  });
  [deal.entrepreneur_id, deal.professional_id].forEach((u) => ctx.notify.push(u, 'deal.formalised', { deal_id: deal.id }));
  audit(ctx, null, 'deal.formalised', 'deal', deal.id);
  return { status: 'formalised' };
}

export const myDeals = (ctx, user) =>
  ctx.db.all('SELECT * FROM deals WHERE (entrepreneur_id=? AND hidden_e=0) OR (professional_id=? AND hidden_p=0) ORDER BY created_at DESC', user.id, user.id)
    .map((d) => presentDeal(ctx, d, d.entrepreneur_id === user.id ? 'entrepreneur' : 'professional'));

/* ===================== Cancelling and removing deals ===================== */
const BEFORE_COMMITMENT = ['awaiting_payment', 'terms_pending', 'terms_locked', 'under_review'];

/**
 * Cancel a deal. Before money moves or paperwork is formalised, either side can walk away on their own.
 * Once work is paid for, or sworn affidavits are in force, BOTH sides must agree (otherwise use a dispute).
 */
export async function cancelDeal(ctx, user, dealId, b) {
  const { deal, role } = getDealFor(ctx, user, dealId);
  if (role === 'admin') throw forbidden('Staff resolve disagreements through the dispute process');
  const reason = str(b.reason, 'reason', 5, 500);
  if (BEFORE_COMMITMENT.includes(deal.status)) return finishCancel(ctx, deal, user.id, reason);
  if (!['in_progress', 'formalised'].includes(deal.status)) throw conflict('This deal can no longer be cancelled', 'bad_state');
  if (!deal.cancel_requested_by) {
    ctx.db.run('UPDATE deals SET cancel_requested_by=?, cancel_reason=? WHERE id=?', role, reason, dealId);
    ctx.notify.push(partyId(deal, other(role)), 'deal.cancel_requested', { deal_id: dealId, reason });
    return { status: deal.status, cancel_requested_by: role, waiting_for: other(role) };
  }
  if (deal.cancel_requested_by === role) throw conflict('You already asked to cancel. Waiting for the other party to agree.', 'already_requested');
  return finishCancel(ctx, deal, user.id, deal.cancel_reason || reason);
}

/** Withdraw your own cancellation request, or decline the other party's. The deal carries on. */
export function keepDeal(ctx, user, dealId) {
  const { deal, role } = getDealFor(ctx, user, dealId);
  if (role === 'admin') throw forbidden();
  if (!deal.cancel_requested_by) throw conflict('There is no cancellation request', 'bad_state');
  ctx.db.run('UPDATE deals SET cancel_requested_by=NULL, cancel_reason=NULL WHERE id=?', dealId);
  ctx.notify.push(partyId(deal, other(role)), 'deal.cancel_withdrawn', { deal_id: dealId });
  return { status: deal.status, cancel_requested_by: null };
}

async function finishCancel(ctx, deal, actorId, reason) {
  let refunded = 0;
  if (deal.status === 'in_progress') {
    const p = ctx.db.get(`SELECT * FROM payments WHERE deal_id=? AND status='held'`, deal.id);
    if (p) { await ctx.provider.refund({ ref: p.provider_ref }); refunded = p.amount_cents; }   // refund the payer in full, then record it
  }
  const out = ctx.db.tx(() => {
    ctx.db.run(`UPDATE payments SET status='refunded' WHERE deal_id=? AND status='held'`, deal.id);
    supersedeAll(ctx, deal.id, actorId, 'deal_cancelled');   // sworn statements for a dead deal never count; the rows stay as evidence
    ctx.db.run(`UPDATE deals SET status='cancelled', cancelled_at=?, cancel_reason=?, cancel_requested_by=NULL, auto_release_at=NULL WHERE id=?`, ctx.clock.now(), reason, deal.id);
    ctx.db.run(`UPDATE offers SET status='withdrawn' WHERE id=?`, deal.offer_id);
    audit(ctx, actorId, 'deal.cancelled', 'deal', deal.id, { reason, was: deal.status, refunded_cents: refunded });
    // The place is free again: bring the request back so the entrepreneur can pick someone else.
    const t = ctx.db.get('SELECT * FROM threads WHERE id=?', deal.thread_id);
    return ['matched', 'formalised'].includes(t.status) ? reopenThread(ctx, deal.thread_id) : null;
  });
  [deal.entrepreneur_id, deal.professional_id].filter((u) => u !== actorId).forEach((u) => ctx.notify.push(u, 'deal.cancelled', { deal_id: deal.id, reason }));
  return { status: 'cancelled', refunded_rands: refunded / 100, request_reopened: !!out, ...(out || {}) };
}

/** Remove a finished deal from YOUR list. Records are kept (tax, disputes); the other party's view is unaffected. */
export function removeDeal(ctx, user, dealId) {
  const { deal, role } = getDealFor(ctx, user, dealId);
  if (role === 'admin') throw forbidden();
  if (deal.status === 'formalised') throw conflict('End this partnership first (both parties agree), then you can remove it from your list', 'cancel_first');
  if (!['completed', 'refunded', 'cancelled'].includes(deal.status)) throw conflict('Only finished deals can be removed from your list. Cancel it first.', 'bad_state');
  ctx.db.run(`UPDATE deals SET ${role === 'entrepreneur' ? 'hidden_e' : 'hidden_p'}=1 WHERE id=?`, dealId);
  audit(ctx, user.id, 'deal.removed_from_list', 'deal', dealId);
  return { removed_from_your_list: true, note: 'We keep deal and payment records for tax and dispute purposes.' };
}
