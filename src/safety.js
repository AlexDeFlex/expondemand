import { bad, conflict, forbidden, notFound, uid, str, need, json, parse, normPhone } from './util.js';
import { config } from './config.js';
import { audit } from './notify.js';
import { getDealFor } from './deals.js';

/* ---------- Trusted contacts: the contact must opt in before we ever message them with location ---------- */
export function addTrustedContact(ctx, user, b) {
  const name = str(b.name, 'name', 2, 80), phone = normPhone(b.phone);
  const n = ctx.db.get('SELECT COUNT(*) n FROM trusted_contacts WHERE user_id=?', user.id).n;
  need(n < 3, 'You can name up to 3 trusted contacts', 'too_many_contacts');
  const id = uid();
  ctx.db.run('INSERT INTO trusted_contacts(id,user_id,name,phone,consented_at) VALUES(?,?,?,?,NULL)', id, user.id, name, phone);
  ctx.notify.sms(phone, 'contact.invite', { text: `${user.full_name || 'Someone'} named you as a safety contact on ExpOnDemand. Reply YES to agree. Reply STOP to decline.` });
  return { id, status: 'invited' };
}
export function consentContact(ctx, contactId, phone) {
  const c = ctx.db.get('SELECT * FROM trusted_contacts WHERE id=?', contactId);
  if (!c || c.phone !== normPhone(phone)) throw notFound();
  ctx.db.run('UPDATE trusted_contacts SET consented_at=? WHERE id=?', ctx.clock.now(), contactId);
  return { id: contactId, status: 'consented' };
}
export const listContacts = (ctx, user) =>
  ctx.db.all('SELECT id,name,phone,consented_at FROM trusted_contacts WHERE user_id=?', user.id).map((c) => ({ id: c.id, name: c.name, phone: c.phone.slice(0, 5) + '****' + c.phone.slice(-3), consented: !!c.consented_at }));

/* ---------- Risk: switch safety mode on only when it matters, so low-risk meetings stay fast ---------- */
export function assessRisk(ctx, deal, m) {
  let score = 0; const reasons = [];
  const prior = ctx.db.get(`SELECT COUNT(*) n FROM meetings mt JOIN deals d ON d.id=mt.deal_id
                            WHERE mt.status='completed' AND d.entrepreneur_id=? AND d.professional_id=?`, deal.entrepreneur_id, deal.professional_id).n;
  if (!prior) { score += 2; reasons.push('First meeting between these two parties'); }
  if (['private', 'unknown'].includes(m.venue_type)) { score += 2; reasons.push('Private or unlisted location'); }
  const sast = new Date(m.scheduled_at + 2 * 3600e3), h = sast.getUTCHours(), dow = sast.getUTCDay();
  if (h < 8 || h >= 18 || dow === 0 || dow === 6) { score += 1; reasons.push('Outside business hours'); }
  if ((deal.amount_cents || 0) >= config.highValueCents) { score += 1; reasons.push('High-value deal'); }
  const reports = ctx.db.get(`SELECT COUNT(*) n FROM safety_reports WHERE reported_id IN(?,?)`, deal.entrepreneur_id, deal.professional_id).n;
  if (reports) { score += 3; reasons.push('Past safety reports on one of the parties'); }
  if (['police_station', 'commissioner'].includes(m.venue_type)) { score -= 2; reasons.push('Safer venue lowers the risk'); }
  return { risk: score >= 4 ? 'high' : score >= 2 ? 'medium' : 'low', score, reasons };
}

export function proposeMeeting(ctx, user, dealId, b) {
  const { deal, role } = getDealFor(ctx, user, dealId);
  if (role === 'admin') throw forbidden();
  if (['refunded', 'cancelled'].includes(deal.status)) throw conflict('This deal is closed', 'bad_state');
  need(['police_station', 'commissioner', 'office', 'public', 'private', 'unknown'].includes(b.venue_type), 'Invalid venue_type', 'bad_venue');
  const at = Date.parse(b.scheduled_at);
  need(Number.isFinite(at) && at > ctx.clock.now(), 'scheduled_at must be a future date-time', 'bad_time');
  const mins = Number(b.duration_min || 60);
  need(mins >= 15 && mins <= 480, 'duration_min must be 15-480', 'bad_duration');
  const r = assessRisk(ctx, deal, { venue_type: b.venue_type, scheduled_at: at });
  const safety = r.risk !== 'low' || b.safety_mode === true;
  const id = uid();
  ctx.db.tx(() => {
    ctx.db.run(`INSERT INTO meetings(id,deal_id,proposed_by,scheduled_at,expected_end,venue_type,venue_name,risk,safety_mode,status,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
      id, dealId, user.id, at, at + mins * 60e3, b.venue_type, b.venue_name || null, r.risk, safety ? 1 : 0, 'proposed', ctx.clock.now());
    [deal.entrepreneur_id, deal.professional_id].forEach((u) => ctx.db.run('INSERT INTO meeting_participants(meeting_id,user_id,confirmed_at) VALUES(?,?,?)', id, u, u === user.id ? ctx.clock.now() : null));
  });
  const otherId = user.id === deal.entrepreneur_id ? deal.professional_id : deal.entrepreneur_id;
  ctx.notify.push(otherId, 'meeting.proposed', { meeting_id: id, risk: r.risk });
  return { meeting_id: id, ...r, safety_mode: safety,
    tip: r.risk !== 'low' && !['police_station', 'commissioner'].includes(b.venue_type) ? 'A police station or Commissioner of Oaths office is safer, and doubles as the affidavit venue.' : null };
}

const getMeeting = (ctx, user, id) => {
  const m = ctx.db.get('SELECT * FROM meetings WHERE id=?', id);
  const part = m && ctx.db.get('SELECT * FROM meeting_participants WHERE meeting_id=? AND user_id=?', id, user.id);
  if (!m || !part) throw notFound('Meeting not found');
  return { m, part };
};

export function confirmMeeting(ctx, user, id) {
  const { m, part } = getMeeting(ctx, user, id);
  if (m.status !== 'proposed') throw conflict('Meeting is not waiting for confirmation', 'bad_state');
  if (m.proposed_by === user.id) throw conflict('The other party confirms your proposal', 'bad_state');
  ctx.db.run('UPDATE meeting_participants SET confirmed_at=? WHERE meeting_id=? AND user_id=?', ctx.clock.now(), id, user.id);
  ctx.db.run(`UPDATE meetings SET status='confirmed' WHERE id=?`, id);
  return { status: 'confirmed', safety_mode: !!m.safety_mode, reminder: '1 hour before, we will ask you to confirm you are still going.' };
}
export function arrive(ctx, user, id) {
  const { m } = getMeeting(ctx, user, id);
  if (!['confirmed', 'in_progress'].includes(m.status)) throw conflict('Both parties must confirm first', 'bad_state');
  ctx.db.run('UPDATE meeting_participants SET arrived_at=? WHERE meeting_id=? AND user_id=?', ctx.clock.now(), id, user.id);
  ctx.db.run(`UPDATE meetings SET status='in_progress' WHERE id=?`, id);
  ctx.db.run(`INSERT INTO safety_events(meeting_id,user_id,type,at) VALUES(?,?,?,?)`, id, user.id, 'arrived', ctx.clock.now());
  return { status: 'in_progress', expected_end: m.expected_end };
}
export function checkout(ctx, user, id) {
  const { m } = getMeeting(ctx, user, id);
  if (m.status !== 'in_progress') throw conflict('Meeting is not in progress', 'bad_state');
  ctx.db.run('UPDATE meeting_participants SET checked_out_at=? WHERE meeting_id=? AND user_id=?', ctx.clock.now(), id, user.id);
  ctx.db.run(`INSERT INTO safety_events(meeting_id,user_id,type,at) VALUES(?,?,?,?)`, id, user.id, 'checked_out', ctx.clock.now());
  const open = ctx.db.get('SELECT COUNT(*) n FROM meeting_participants WHERE meeting_id=? AND arrived_at IS NOT NULL AND checked_out_at IS NULL', id).n;
  if (!open) ctx.db.run(`UPDATE meetings SET status='completed' WHERE id=?`, id);
  return { status: open ? 'in_progress' : 'completed' };
}

/** SOS: location is shared only because the user pressed it, only with contacts who opted in, and only during a live meeting. */
export function sos(ctx, user, id, b) {
  const { m } = getMeeting(ctx, user, id);
  if (m.status !== 'in_progress') throw conflict('SOS is available during an active meeting', 'bad_state');
  const loc = Number.isFinite(+b.lat) && Number.isFinite(+b.lng) ? { lat: +b.lat, lng: +b.lng } : null;
  ctx.db.run('INSERT INTO safety_events(meeting_id,user_id,type,detail,at) VALUES(?,?,?,?,?)', id, user.id, 'sos', json(loc), ctx.clock.now());
  const contacts = ctx.db.all('SELECT * FROM trusted_contacts WHERE user_id=? AND consented_at IS NOT NULL', user.id);
  contacts.forEach((c) => ctx.notify.sms(c.phone, 'sos', { text: `${user.full_name || 'Your contact'} pressed SOS during a meeting.${loc ? ` Location: https://maps.google.com/?q=${loc.lat},${loc.lng}` : ''}` }));
  ctx.db.all(`SELECT id FROM users WHERE role='admin'`).forEach((a) => ctx.notify.push(a.id, 'sos', { meeting_id: id, user_id: user.id, loc }));
  audit(ctx, user.id, 'safety.sos', 'meeting', id);
  return { alerted_contacts: contacts.length, emergency: 'If you are in danger call 112 (any cell phone) or SAPS 10111 now. This app supports your safety; it does not replace emergency services.' };
}

export function reportUser(ctx, user, id, b) {
  const { m } = getMeeting(ctx, user, id);
  const deal = ctx.db.get('SELECT * FROM deals WHERE id=?', m.deal_id);
  const reported = user.id === deal.entrepreneur_id ? deal.professional_id : deal.entrepreneur_id;
  ctx.db.run('INSERT INTO safety_reports(id,meeting_id,reporter_id,reported_id,text,at) VALUES(?,?,?,?,?,?)', uid(), id, user.id, reported, str(b.text, 'text', 10, 1000), ctx.clock.now());
  return { reported: true };
}

/** Runs every minute. Gentle first: a prompt to the user, then SMS, then their contacts, then staff. Never an instant alarm. */
export function runSafetyEscalation(ctx) {
  const now = ctx.clock.now(), actions = [];
  const had = (mid, uid_, type) => ctx.db.get('SELECT id FROM safety_events WHERE meeting_id=? AND user_id=? AND type=?', mid, uid_, type);
  const log = (mid, uid_, type) => ctx.db.run('INSERT INTO safety_events(meeting_id,user_id,type,at) VALUES(?,?,?,?)', mid, uid_, type, now);
  for (const m of ctx.db.all(`SELECT * FROM meetings WHERE status='in_progress' AND safety_mode=1 AND expected_end<=?`, now)) {
    const mins = (now - m.expected_end) / 60000;
    for (const p of ctx.db.all('SELECT * FROM meeting_participants WHERE meeting_id=? AND arrived_at IS NOT NULL AND checked_out_at IS NULL', m.id)) {
      const u = ctx.db.get('SELECT * FROM users WHERE id=?', p.user_id);
      if (mins >= 0 && !had(m.id, u.id, 'prompt')) { ctx.notify.push(u.id, 'safety.are_you_safe', { meeting_id: m.id }); log(m.id, u.id, 'prompt'); actions.push('prompt'); }
      if (mins >= 15 && !had(m.id, u.id, 'sms')) { ctx.notify.sms(u.phone, 'safety.are_you_safe', { text: 'Your meeting has ended. Are you safe? Open the app and tap "I am safe".' }); log(m.id, u.id, 'sms'); actions.push('sms'); }
      if (mins >= 30 && !had(m.id, u.id, 'contact_alert')) {
        ctx.db.all('SELECT * FROM trusted_contacts WHERE user_id=? AND consented_at IS NOT NULL', u.id).forEach((c) => ctx.notify.sms(c.phone, 'safety.contact_alert', { text: `${u.full_name || 'Your contact'} has not checked out of a meeting that ended ${Math.round(mins)} minutes ago.` }));
        log(m.id, u.id, 'contact_alert'); actions.push('contact_alert');
      }
      if (mins >= 45 && !had(m.id, u.id, 'admin_flag')) {
        ctx.db.all(`SELECT id FROM users WHERE role='admin'`).forEach((a) => ctx.notify.push(a.id, 'safety.welfare_check', { meeting_id: m.id, user_id: u.id }));
        log(m.id, u.id, 'admin_flag'); actions.push('admin_flag');
      }
    }
  }
  return actions;
}

export function listMeetings(ctx, user, dealId) {
  const { deal } = getDealFor(ctx, user, dealId);
  return ctx.db.all('SELECT * FROM meetings WHERE deal_id=? ORDER BY scheduled_at', deal.id).map((m) => {
    const me = ctx.db.get('SELECT * FROM meeting_participants WHERE meeting_id=? AND user_id=?', m.id, user.id) || {};
    return { id: m.id, scheduled_at: m.scheduled_at, expected_end: m.expected_end, venue_type: m.venue_type, venue_name: m.venue_name, risk: m.risk,
      safety_mode: !!m.safety_mode, status: m.status, proposed_by_me: m.proposed_by === user.id, confirmed_by_me: !!me.confirmed_at, arrived: !!me.arrived_at, checked_out: !!me.checked_out_at };
  });
}
