import { config } from './config.js';
import { HttpError, bad, conflict, forbidden, notFound, uid, str, need, toCents, json, parse } from './util.js';
import { audit } from './notify.js';
import { getProfession } from './professions.js';
import { canPost } from './onboarding.js';
import { feeFor } from './payments.js';

/** The matching rule. One function, used for the feed, the notifications and offer validation. */
export function isEligible(pro, thread) {
  if (!pro || pro.status !== 'verified' || !pro.available) return false;
  if (pro.user_id === thread.owner_id) return false;            // you cannot hire yourself: one person, two hats, never both sides of a deal
  if (pro.profession !== thread.profession) return false;
  if (thread.requires_registration) return pro.tier === 1;   // regulated work: registered professionals only
  return true;                                                // consultations: any verified expert (tier 3 included)
}

export function createThread(ctx, user, b) {
  const gate = canPost(ctx, user.id, b.business_id);
  if (!gate.ok) throw new HttpError(403, gate.reason, 'gate_' + gate.step);
  const biz = gate.business;
  const active = ctx.db.get(`SELECT COUNT(*) n FROM threads WHERE business_id=? AND status IN('open','has_offers','matched')`, biz.id).n;
  if (active >= config.maxActiveThreadsPerBusiness) throw conflict(`You can have ${config.maxActiveThreadsPerBusiness} active requests at a time`, 'too_many_threads');
  const needType = b.need_type;
  need(['consultation', 'licensing'].includes(needType), 'need_type must be consultation or licensing', 'bad_need');
  const prof = getProfession(b.profession);
  need(prof, 'Pick a profession from the list', 'bad_profession');
  const description = str(b.description, 'description', 10, 2000);
  // Consultations do not require a registered professional unless the entrepreneur asks for one.
  // Licensing cover requires registration whenever the profession has a statutory body.
  let requires = needType === 'licensing' ? prof.registered : false;
  if (b.requires_registration === true) { need(prof.registered, 'That profession has no registration body to require', 'no_registration'); requires = true; }
  if (needType === 'licensing' && b.requires_registration === false && prof.registered) requires = true; // cannot waive for licensing
  let min = null, max = null, engagement = null, terms = null;
  if (needType === 'consultation') {
    min = toCents(b.budget_min); max = toCents(b.budget_max);
    need(min <= max, 'Budget “from” must not exceed “to”', 'bad_budget');
  } else {
    need(['partnership', 'employment'].includes(b.engagement), 'engagement must be partnership or employment', 'bad_engagement');
    engagement = b.engagement;
    const t = b.terms || {};
    if (engagement === 'partnership') {
      const pct = Number(t.share_percent);
      need(pct > 0 && pct <= 100, 'share_percent must be between 1 and 100', 'bad_terms');
      terms = { share_percent: pct, scope: str(t.scope, 'scope', 5, 500) };
    } else {
      terms = { monthly_retainer_cents: toCents(t.monthly_retainer), contract: ['fixed_term', 'permanent'].includes(t.contract) ? t.contract : 'fixed_term', scope: str(t.scope, 'scope', 5, 500) };
    }
  }
  // A consultation can hire several experts ("I need more consultants"). Licensing cover is one registered professional per deal.
  const positions = needType === 'consultation' ? Math.min(config.maxPositions, Math.max(1, Math.floor(Number(b.positions) || 1))) : 1;
  const now = ctx.clock.now(), id = uid();
  ctx.db.run(`INSERT INTO threads(id,business_id,owner_id,need_type,profession,description,requires_registration,urgency,budget_min,budget_max,engagement,terms,status,created_at,expires_at,positions)
              VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, id, biz.id, user.id, needType, prof.name, description, requires ? 1 : 0,
    ['now', 'today', 'this_week'].includes(b.urgency) ? b.urgency : 'this_week', min, max, engagement, terms ? json(terms) : null, 'open', now, now + config.threadTtlMs, positions);
  const thread = ctx.db.get('SELECT * FROM threads WHERE id=?', id);
  // Step 2 of the flow: alert ONLY eligible professionals in that niche.
  const pros = ctx.db.all(`SELECT * FROM professionals WHERE profession=? AND status='verified'`, prof.name).filter((p) => isEligible(p, thread));
  for (const p of pros) ctx.notify.push(p.user_id, 'thread.new', { thread_id: id, profession: prof.name, need_type: needType });
  audit(ctx, user.id, 'thread.created', 'thread', id, { notified: pros.length });
  return { ...present(thread), notified: pros.length };
}

const present = (t) => ({
  id: t.id, need_type: t.need_type, profession: t.profession, description: t.description, urgency: t.urgency,
  requires_registration: !!t.requires_registration, budget_min_rands: t.budget_min && t.budget_min / 100, budget_max_rands: t.budget_max && t.budget_max / 100,
  engagement: t.engagement, terms: parse(t.terms), positions: t.positions, status: t.status, expires_at: t.expires_at, created_at: t.created_at,
});

/** Professional's feed: only threads they are eligible for. Never shows who the business is until they bid. */
export function feed(ctx, user) {
  const pro = ctx.db.get('SELECT * FROM professionals WHERE user_id=?', user.id);
  if (!pro || pro.status !== 'verified') return [];
  return ctx.db.all(`SELECT t.*, b.company_name FROM threads t JOIN businesses b ON b.id=t.business_id
                     WHERE t.status IN('open','has_offers') AND t.expires_at>? AND t.profession=? ORDER BY t.created_at DESC`, ctx.clock.now(), pro.profession)
    .filter((t) => isEligible(pro, t))
    .map((t) => ({ ...present(t), business: { company_name: t.company_name, verified: true } }));
}

export function myThreads(ctx, user) {
  return ctx.db.all('SELECT * FROM threads WHERE owner_id=? ORDER BY created_at DESC', user.id).map((t) => ({ ...present(t), filled: filled(ctx, t.id), offers: offersFor(ctx, t.id) }));
}

function offersFor(ctx, threadId) {
  return ctx.db.all(`SELECT o.*, p.tier, p.body, p.reg_number, p.institution, p.rating, p.jobs, u.full_name
                     FROM offers o JOIN professionals p ON p.user_id=o.professional_id JOIN users u ON u.id=o.professional_id
                     WHERE o.thread_id=? AND o.status IN('pending','accepted') ORDER BY o.updated_at DESC`, threadId).map((o) => ({
    id: o.id, kind: o.kind, round: o.round, status: o.status, amount_rands: o.amount_cents && o.amount_cents / 100, terms: parse(o.terms), note: o.note,
    professional: { id: o.professional_id, name: o.full_name, tier: o.tier, rating: o.rating, jobs: o.jobs,
      badge: o.tier === 1 ? (o.body && o.body !== 'No statutory body' ? `Tier 1 · ${o.body} ${o.reg_number}` : 'Qualification verified') : o.tier === 2 ? 'Candidate, supervised' : `Graduate · ${o.institution}` },
  }));
}

export function submitOffer(ctx, user, threadId, b) {
  const pro = ctx.db.get('SELECT * FROM professionals WHERE user_id=?', user.id);
  const t = ctx.db.get('SELECT * FROM threads WHERE id=?', threadId);
  if (!t) throw notFound();
  if (!['open', 'has_offers'].includes(t.status) || t.expires_at < ctx.clock.now()) throw conflict('This request is closed', 'thread_closed');
  if (t.owner_id === user.id) throw new HttpError(403, 'You cannot respond to your own request', 'own_request');
  if (!isEligible(pro, t)) throw forbidden(t.requires_registration ? 'This request needs a registered (Tier 1) professional in this field' : 'You are not eligible for this request');
  need(['interested', 'counter'].includes(b.kind), 'kind must be interested or counter', 'bad_kind');
  const note = b.note ? str(b.note, 'note', 1, 500) : null;
  let amount = null, terms = null;
  if (t.need_type === 'consultation') amount = b.kind === 'interested' ? t.budget_max : toCents(b.amount);
  else terms = b.kind === 'interested' ? parse(t.terms) : (b.terms || need(false, 'Counter-offers on licensing need terms', 'bad_terms'));
  const now = ctx.clock.now();
  return ctx.db.tx(() => {
    const existing = ctx.db.get('SELECT * FROM offers WHERE thread_id=? AND professional_id=?', threadId, user.id);
    if (!existing) {
      const count = ctx.db.get(`SELECT COUNT(*) n FROM offers WHERE thread_id=? AND status IN('pending')`, threadId).n;
      if (count >= config.maxOffersPerThread) throw conflict('This request already has the maximum number of offers', 'offer_limit');
      const id = uid();
      ctx.db.run(`INSERT INTO offers(id,thread_id,professional_id,kind,amount_cents,terms,note,round,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
        id, threadId, user.id, b.kind, amount, terms ? json(terms) : null, note, 1, 'pending', now, now);
    } else {
      if (!['pending', 'expired'].includes(existing.status)) throw conflict('Your offer is no longer open');
      if (existing.round >= config.maxCounterRounds) throw conflict(`Counter-offers are limited to ${config.maxCounterRounds} rounds`, 'round_limit');
      ctx.db.run(`UPDATE offers SET status='pending', kind=?, amount_cents=?, terms=?, note=?, round=round+1, updated_at=? WHERE id=?`, b.kind, amount, terms ? json(terms) : null, note, now, existing.id);
    }
    ctx.db.run(`UPDATE threads SET status='has_offers' WHERE id=?`, threadId);
    ctx.notify.push(t.owner_id, 'offer.new', { thread_id: threadId });
    const offer = ctx.db.get('SELECT * FROM offers WHERE thread_id=? AND professional_id=?', threadId, user.id);
    return { offer_id: offer.id, round: offer.round, you_receive: amount ? feeFor(amount) : null };
  });
}

/** How many experts are currently hired on a request (cancelled and refunded deals free their place). */
export const filled = (ctx, threadId) =>
  ctx.db.get(`SELECT COUNT(*) n FROM deals WHERE thread_id=? AND status NOT IN('cancelled','refunded')`, threadId).n;

/** Entrepreneur picks. Atomic: a place can only be filled once. Creates one deal per hired expert. */
export function pickOffer(ctx, user, threadId, offerId) {
  const now = ctx.clock.now();
  return ctx.db.tx(() => {
    const t = ctx.db.get('SELECT * FROM threads WHERE id=?', threadId);
    if (!t) throw notFound();
    if (t.owner_id !== user.id) throw forbidden();
    const n = filled(ctx, threadId);
    if (n >= t.positions) throw conflict('You already hired everyone you asked for. Add another position to hire more.', 'positions_full');
    if (!['open', 'has_offers'].includes(t.status)) throw conflict('This request is closed. Add a position to reopen it.', 'thread_closed');
    const o = ctx.db.get(`SELECT * FROM offers WHERE id=? AND thread_id=? AND status='pending'`, offerId, threadId);
    if (!o) throw notFound('Offer not found');
    ctx.db.run(`UPDATE offers SET status='accepted' WHERE id=?`, offerId);
    const full = n + 1 >= t.positions;
    if (full) {
      // Everyone needed is hired: park the other offers (they can be revived if you add a position) and tell those experts.
      ctx.db.all(`SELECT professional_id FROM offers WHERE thread_id=? AND id!=? AND status='pending'`, threadId, offerId)
        .forEach((l) => ctx.notify.push(l.professional_id, 'thread.closed', { thread_id: threadId }));
      ctx.db.run(`UPDATE offers SET status='expired' WHERE thread_id=? AND id!=? AND status='pending'`, threadId, offerId);
      ctx.db.run(`UPDATE threads SET status='matched', chosen_offer_id=? WHERE id=?`, offerId, threadId);
    } else {
      const left = ctx.db.get(`SELECT COUNT(*) n FROM offers WHERE thread_id=? AND status='pending'`, threadId).n;
      ctx.db.run(`UPDATE threads SET status=?, chosen_offer_id=? WHERE id=?`, left ? 'has_offers' : 'open', offerId, threadId);
    }
    const seq = ctx.db.get('SELECT COUNT(*)+1 n FROM deals').n;
    const reference = `DEAL-${new Date(now).getUTCFullYear()}-${String(seq).padStart(6, '0')}`;
    const consult = t.need_type === 'consultation';
    const dealId = uid();
    ctx.db.run(`INSERT INTO deals(id,thread_id,offer_id,business_id,entrepreneur_id,professional_id,reference,need_type,amount_cents,terms,status,created_at)
                VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`, dealId, threadId, offerId, t.business_id, t.owner_id, o.professional_id, reference, t.need_type,
      o.amount_cents, o.terms || t.terms, consult ? 'awaiting_payment' : 'terms_pending', now);
    ctx.notify.push(o.professional_id, 'offer.picked', { deal_id: dealId, reference });
    audit(ctx, user.id, 'offer.picked', 'thread', threadId, { offer: offerId, deal: dealId });
    return { deal_id: dealId, reference, status: consult ? 'awaiting_payment' : 'terms_pending', next: consult ? 'pay' : 'lock_terms',
      positions: t.positions, filled: n + 1, still_hiring: !full };
  });
}

/** "I need more consultants": add places and bring the request back. Earlier offers come back so you can pick again. */
export function addPosition(ctx, user, threadId, b) {
  const t = ctx.db.get('SELECT * FROM threads WHERE id=?', threadId);
  if (!t) throw notFound();
  if (t.owner_id !== user.id) throw forbidden();
  if (t.need_type !== 'consultation') throw bad('Licensing cover is arranged one registered professional at a time. Post a new request for another.', 'one_licensing');
  if (['closed', 'expired'].includes(t.status)) throw conflict('That request has ended. Post a new one.', 'thread_ended');
  const gate = canPost(ctx, user.id, t.business_id);
  if (!gate.ok) throw new HttpError(403, gate.reason, 'gate_' + gate.step);
  const count = Math.floor(Number(b.count) || 1);
  need(count >= 1, 'count must be at least 1', 'bad_count');
  if (t.positions + count > config.maxPositions) throw conflict(`You can hire up to ${config.maxPositions} experts per request`, 'too_many_positions');
  return ctx.db.tx(() => {
    ctx.db.run('UPDATE threads SET positions=positions+? WHERE id=?', count, threadId);
    audit(ctx, user.id, 'thread.position_added', 'thread', threadId, { count });
    return { positions: t.positions + count, ...reopenThread(ctx, threadId) };
  });
}

/** Reopen a thread: revive offers that were parked, alert eligible experts who have not offered yet. */
export function reopenThread(ctx, threadId) {
  const now = ctx.clock.now();
  const t = ctx.db.get('SELECT * FROM threads WHERE id=?', threadId);
  const parked = ctx.db.all(`SELECT id, professional_id FROM offers WHERE thread_id=? AND status='expired'`, threadId);
  parked.forEach((o) => { ctx.db.run(`UPDATE offers SET status='pending', updated_at=? WHERE id=?`, now, o.id); ctx.notify.push(o.professional_id, 'offer.reopened', { thread_id: threadId }); });
  const pending = ctx.db.get(`SELECT COUNT(*) n FROM offers WHERE thread_id=? AND status='pending'`, threadId).n;
  ctx.db.run(`UPDATE threads SET status=?, expires_at=?, formalised_at=NULL WHERE id=?`, pending ? 'has_offers' : 'open', now + config.threadTtlMs, threadId);
  const fresh = ctx.db.all(`SELECT * FROM professionals WHERE profession=? AND status='verified'`, t.profession)
    .filter((p) => isEligible(p, t) && !ctx.db.get('SELECT id FROM offers WHERE thread_id=? AND professional_id=?', threadId, p.user_id));
  fresh.forEach((p) => ctx.notify.push(p.user_id, 'thread.new', { thread_id: threadId, profession: t.profession, need_type: t.need_type }));
  return { revived_offers: parked.length, newly_alerted: fresh.length };
}

/** Once every hired expert's deal is finished, the thread counts as formalised (and is archived a week later). */
export function settleThread(ctx, threadId) {
  const t = ctx.db.get('SELECT * FROM threads WHERE id=?', threadId);
  if (!t || t.status !== 'matched') return;
  const rows = ctx.db.all(`SELECT status FROM deals WHERE thread_id=? AND status NOT IN('cancelled','refunded')`, threadId);
  if (rows.length && rows.every((d) => ['completed', 'formalised'].includes(d.status)))
    ctx.db.run(`UPDATE threads SET status='formalised', formalised_at=? WHERE id=?`, ctx.clock.now(), threadId);
}

/** Stop looking. Experts already hired keep their deals. */
export function closeThread(ctx, user, threadId) {
  const t = ctx.db.get('SELECT * FROM threads WHERE id=?', threadId);
  if (!t) throw notFound();
  if (t.owner_id !== user.id) throw forbidden();
  if (!['open', 'has_offers'].includes(t.status)) throw conflict('This request is already closed', 'thread_closed');
  const status = filled(ctx, threadId) > 0 ? 'matched' : 'closed';
  ctx.db.tx(() => {
    ctx.db.run('UPDATE threads SET status=? WHERE id=?', status, threadId);
    ctx.db.all(`SELECT professional_id FROM offers WHERE thread_id=? AND status='pending'`, threadId).forEach((o) => ctx.notify.push(o.professional_id, 'thread.closed', { thread_id: threadId }));
    ctx.db.run(`UPDATE offers SET status='declined' WHERE thread_id=? AND status='pending'`, threadId);
  });
  return { id: threadId, status };
}

/** Scheduled job: expire stale threads, archive finished ones. Archive, never delete: evidence for disputes. */
export function runThreadMaintenance(ctx) {
  const now = ctx.clock.now();
  const stale = ctx.db.all(`SELECT id FROM threads WHERE status IN('open','has_offers') AND expires_at<?`, now);
  stale.forEach((t) => {
    ctx.db.run('UPDATE threads SET status=? WHERE id=?', filled(ctx, t.id) > 0 ? 'matched' : 'expired', t.id);
    ctx.db.run(`UPDATE offers SET status='expired' WHERE thread_id=? AND status='pending'`, t.id);
  });
  const done = ctx.db.run(`UPDATE threads SET status='closed' WHERE status='formalised' AND formalised_at<?`, now - config.threadArchiveAfterFormaliseMs);
  return { expired: stale.length, archived: Number(done.changes) };
}

/** A professional's own offers, with the request they bid on and the deal if they were picked. */
export function myOffers(ctx, user) {
  return ctx.db.all(`SELECT o.*, t.profession, t.description, t.need_type, t.status tstatus, b.company_name, d.id deal_id
                     FROM offers o JOIN threads t ON t.id=o.thread_id JOIN businesses b ON b.id=t.business_id LEFT JOIN deals d ON d.offer_id=o.id
                     WHERE o.professional_id=? ORDER BY o.updated_at DESC`, user.id).map((o) => ({
    id: o.id, thread_id: o.thread_id, profession: o.profession, description: o.description, need_type: o.need_type, business: o.company_name,
    kind: o.kind, round: o.round, status: o.status, amount_rands: o.amount_cents && o.amount_cents / 100, terms: parse(o.terms), note: o.note, deal_id: o.deal_id || null }));
}
