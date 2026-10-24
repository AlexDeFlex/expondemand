import { route, html, page, act, forms, api, S, go, toast, R, when, chip, statusChip, termsText, esc, renderRoute, sha256File } from './core.js';

const VENUES = { police_station: 'Police station', commissioner: 'Commissioner of Oaths', office: 'Office', public: 'Public place', private: 'Private site or home', unknown: 'Not sure' };

route('/deals', { roles: ['entrepreneur', 'professional'] }, async () => {
  const { deals } = await api('GET', '/deals');
  return page('My deals', deals.length ? deals.map((d) => html`<div class="card"><div class="row between"><div><h2>${d.profession}</h2><div class="muted small">${d.counterparty.name}</div></div>${statusChip(d.status)}</div>
    <div class="chips mt2">${chip(d.need_type === 'licensing' ? termsText(d.terms) : R(d.amount_rands), 'grey')}${chip(d.reference, 'grey')}</div><button class="btn ghost sm" data-act="go" data-to="/deal/${d.id}">Open</button></div>`)
    : html`<div class="empty">No deals yet. A deal is created when an entrepreneur picks an offer.</div>`);
});

route('/deal/:id', { roles: ['entrepreneur', 'professional'] }, async (id) => {
  const [d, { meetings }] = await Promise.all([api('GET', '/deals/' + id), api('GET', `/deals/${id}/meetings`)]);
  const lic = d.need_type === 'licensing', me = d.your_role, ent = me === 'entrepreneur', them = ent ? 'professional' : 'entrepreneur';
  const statement = lic && ['terms_locked', 'under_review'].includes(d.status) ? (await api('GET', `/deals/${id}/affidavit/text`)).statement : null;
  const acct = ent && d.status === 'awaiting_payment' ? (await api('GET', '/bank-account')).account : null;
  const myAff = d.affidavits.find((a) => a.role === me), theirAff = d.affidavits.find((a) => a.role === them);
  const split = d.payment || d.split_preview;
  const takeHome = d.payment ? d.payment.expert_receives_rands : d.split_preview && d.split_preview.payout_cents / 100;
  const feeRands = d.payment ? d.payment.platform_fee_rands : d.split_preview && d.split_preview.fee_cents / 100;

  const summary = html`<div class="card"><div class="row between"><div><h2>${d.counterparty.name}</h2><div class="muted small">${d.counterparty.badge}</div></div>${statusChip(d.status)}</div>
    <p class="mt2">${d.description}</p><div class="chips">${chip(d.profession, 'grey')}${chip(d.reference, 'grey')}</div>
    ${lic ? html`<div class="kv"><span>Terms (version ${d.terms_version})</span><span>${termsText(d.terms)}</span></div>${d.terms?.scope ? html`<div class="kv"><span>Scope</span><span>${d.terms.scope}</span></div>` : ''}`
      : html`<div class="kv"><span>Agreed price</span><span>${R(d.amount_rands)}</span></div>${split ? (ent ? html`<div class="kv"><span>Platform fee</span><span>${R(feeRands)}</span></div>` : html`<div class="kv"><span>Platform fee</span><span>${R(feeRands)}</span></div><div class="kv"><b>You receive</b><b>${R(takeHome)}</b></div>`) : ''}`}
    ${d.payment ? html`<div class="kv"><span>Money</span><span>${d.payment.status === 'held' ? 'Held safely' : d.payment.status === 'released' ? `Released (payout ${d.payment.payout_status})` : d.payment.status}</span></div>` : ''}</div>`;

  const cancelBox = d.cancel_requested_by ? (d.cancel_requested_by === me
    ? html`<div class="note warn">You asked to cancel. Waiting for the other party to agree. <button class="btn ghost sm" data-act="keepdeal" data-id="${id}">Keep the deal</button></div>`
    : html`<div class="note warn">The other party asked to cancel this deal.<div class="row mt2"><button class="btn sm" data-act="agreecancel" data-id="${id}">Agree and cancel</button><button class="btn ghost sm" data-act="keepdeal" data-id="${id}">Keep the deal</button></div></div>`) : '';

  const payBox = d.status === 'awaiting_payment' ? (ent ? html`<div class="card"><h2>Pay into secure hold</h2><p class="muted small">Your money is held safely until you confirm the work is done.</p>
      <div class="kv"><span>Expert's fee</span><span>${R(d.amount_rands)}</span></div><div class="kv"><span>Platform fee (from the expert's share)</span><span>${R(feeRands)}</span></div>
      <form data-form="pay" data-id="${id}"><div class="seg mt2"><button type="button" class="on" data-act="paymethod" data-v="card">Card</button><button type="button" data-act="paymethod" data-v="instant_eft">Instant EFT</button><button type="button" data-act="paymethod" data-v="linked_eft" ${acct?.status === 'verified' ? '' : 'disabled'}>Linked account</button></div>
      <input type="hidden" name="method" value="card"><div class="muted small mt2" data-methodnote>Visa or Mastercard. In the live app the card form is hosted by our payment provider, so card details never touch our servers.</div>
      <button class="btn full" type="submit">Pay ${R(d.amount_rands)} securely</button></form></div>`
    : html`<div class="note">Waiting for the entrepreneur to pay. You can start work once the money is held.</div>`) : '';

  const work = d.status === 'in_progress' ? html`<div class="card"><h2>Work in progress</h2>${ent ? html`<p class="muted small">Money is held. When the work is done, release it. If you do nothing, it releases automatically ${d.auto_release_at ? 'on ' + when(d.auto_release_at) : '48 hours after the expert marks it delivered'}.</p><button class="btn full" data-act="confirmdeal" data-id="${id}">Confirm done and release payment</button>`
    : d.delivered_at ? html`<div class="note ok">Marked delivered. Waiting for confirmation${d.auto_release_at ? ' (automatic on ' + when(d.auto_release_at) + ')' : ''}.</div>` : html`<p class="muted small">Do the work, then mark it delivered. The entrepreneur confirms, or it releases automatically after 48 hours.</p><button class="btn full" data-act="deliver" data-id="${id}">Mark as delivered</button>`}
    <details class="mt"><summary>Something is wrong</summary><form data-form="dispute" data-id="${id}"><label>What went wrong?</label><textarea name="reason" rows="2" minlength="10" required></textarea><button class="btn red full" type="submit">Raise a dispute (money stays held)</button></form></details></div>` : '';

  const done = d.status === 'completed' ? html`<div class="note ok">Completed. ${ent ? `The expert received ${R(d.payment.expert_receives_rands)}.` : `Your payout is ${d.payment.payout_status === 'paid' ? 'paid' : d.payment.payout_status === 'pending' ? 'waiting for a verified payout account' : d.payment.payout_status}.`}</div>` : d.status === 'disputed' ? html`<div class="note bad">In dispute. Staff will review and either release the money or refund it.</div>` : '';

  let paper = '';
  if (lic && d.status === 'terms_pending') paper = html`<div class="card"><h2>Agree the terms</h2><p class="muted small">Both of you lock the same terms. They are saved with a tamper-evident fingerprint.</p>
      <div class="chips"><span class="chip ${d.locked.entrepreneur ? 'grn' : 'grey'}">Entrepreneur ${d.locked.entrepreneur ? 'locked' : 'not locked'}</span><span class="chip ${d.locked.professional ? 'grn' : 'grey'}">Expert ${d.locked.professional ? 'locked' : 'not locked'}</span></div>
      ${d.locked[me] ? html`<div class="note">You locked. Waiting for the other party.</div>` : html`<button class="btn full" data-act="lockterms" data-id="${id}">Lock these terms</button>`}
      <details class="mt"><summary>Change the terms</summary><form data-form="terms" data-id="${id}">${d.terms?.share_percent != null ? html`<label>Profit share (%)</label><input name="share_percent" type="number" min="1" max="100" value="${d.terms.share_percent}">` : html`<label>Monthly retainer (R)</label><input name="monthly_retainer" type="number" min="1" value="${d.terms.monthly_retainer_cents / 100}">`}
      <label>Scope</label><input name="scope" value="${d.terms?.scope || ''}"><button class="btn ghost full" type="submit">Update terms (the other side must lock again)</button></form></details></div>`;
  if (lic && d.status === 'terms_locked') paper = html`<div class="card"><h2>Swear your affidavit</h2><p class="muted small">Take this to a police station or any Commissioner of Oaths, sign it in their presence, get it stamped, then upload a photo or scan.</p>
      <div class="redact">${statement}</div>
      <div class="chips mt2"><span class="chip ${myAff?.status === 'verified' ? 'grn' : 'gold'}">You: ${myAff?.status || 'pending'}</span><span class="chip ${theirAff?.status === 'verified' ? 'grn' : 'grey'}">Them: ${theirAff?.status || 'pending'}</span></div>
      ${['pending', 'rejected'].includes(myAff?.status) ? html`<form data-form="affidavit" data-id="${id}"><label>Stamped copy (photo or scan)</label><input type="file" name="scan" accept="image/*,application/pdf" required>
        <label>Commissioner's name</label><input name="commissioner_name" required minlength="3"><label>Police station or office</label><input name="commissioner_station"><label>Date sworn</label><input name="commissioned_on" type="date" required>
        <button class="btn full" type="submit">Upload affidavit</button></form>` : html`<div class="note">${myAff?.status === 'uploaded' ? 'Uploaded. Staff are checking the stamp, date and terms.' : 'Your affidavit is verified.'}</div>`}
      <details class="mt"><summary>Change the terms instead</summary><p class="small muted">Changing terms voids both affidavits, so new ones are needed.</p><form data-form="terms" data-id="${id}">${d.terms?.share_percent != null ? html`<label>Profit share (%)</label><input name="share_percent" type="number" min="1" max="100" value="${d.terms.share_percent}">` : html`<label>Monthly retainer (R)</label><input name="monthly_retainer" type="number" min="1" value="${d.terms.monthly_retainer_cents / 100}">`}<button class="btn ghost full" type="submit">Reopen the terms</button></form></details></div>`;
  if (lic && d.status === 'under_review') paper = html`<div class="card"><h2>Read their affidavit</h2><p class="muted small">Both affidavits are verified. Read the other party's sworn statement and confirm it matches what you agreed. Personal details are hidden.</p>
      ${d.reviews?.i_confirmed_theirs ? html`<div class="note ok">You confirmed.${d.reviews.they_confirmed_mine ? '' : ' Waiting for them to confirm yours.'}</div>` : html`<button class="btn full" data-act="viewaff" data-id="${id}">Read their affidavit</button><div id="aff" class="mt"></div>`}</div>`;
  if (lic && d.status === 'formalised') paper = html`<div class="note ok">Formalised. Both affidavits are verified and confirmed. Sworn copies stay on file.</div>`;

  const canCancel = d.can_cancel && !d.cancel_requested_by;
  const cancel = canCancel ? html`<details class="card"><summary>${['in_progress', 'formalised'].includes(d.status) ? 'Ask to cancel (both sides must agree)' : 'Cancel this deal'}</summary>
      <p class="small muted">${['in_progress', 'formalised'].includes(d.status) ? (d.status === 'in_progress' ? 'The other party must agree. Your money goes back to you in full.' : 'Ending a formalised deal needs both parties to agree. The affidavits stay on file as evidence.') : 'Nothing is binding yet, so you can walk away now. The place reopens for other experts.'}</p>
      <form data-form="cancel" data-id="${id}"><label>Reason</label><input name="reason" required minlength="5" placeholder="e.g. Plans changed"><button class="btn red full" type="submit">${['in_progress', 'formalised'].includes(d.status) ? 'Ask to cancel' : 'Cancel deal'}</button></form></details>` : '';
  const remove = d.can_remove ? html`<button class="btn ghost full" data-act="removedeal" data-id="${id}">Remove from my list</button><p class="note">We keep deal and payment records for tax and dispute purposes. Only your own list changes.</p>` : '';

  const meet = !['cancelled', 'refunded'].includes(d.status) ? html`<h3>Meetings</h3>${meetings.map((m) => meetingCard(m))}
    <details class="card"><summary>Plan a meeting</summary><form data-form="meeting" data-id="${id}"><label>When</label><input name="scheduled_at" type="datetime-local" required><label>How long (minutes)</label><input name="duration_min" type="number" min="15" max="480" value="60">
      <label>Where</label><select name="venue_type">${Object.entries(VENUES).map(([k, v]) => html`<option value="${k}">${v}</option>`)}</select><label>Venue name</label><input name="venue_name" placeholder="Rosebank police station">
      <label class="row"><input type="checkbox" name="safety_mode"> <span>Turn on safety check-ins</span></label><button class="btn full" type="submit">Send for confirmation</button></form>
      <p class="note">Video and chat need no checks. We switch safety mode on for first meetings, private sites and after-hours visits. A police station or Commissioner of Oaths is safest and doubles as the affidavit visit.</p></details>` : '';

  return page(d.profession, html`${summary}${cancelBox}${payBox}${work}${done}${paper}${meet}${cancel}${remove}`, { back: '/deals' });
});

const meetingCard = (m) => html`<div class="card"><div class="row between"><div><b>${when(m.scheduled_at)}</b><div class="muted small">${VENUES[m.venue_type]}${m.venue_name ? ' · ' + m.venue_name : ''}</div></div>${chip('Safety: ' + m.risk, m.risk === 'high' ? 'red' : m.risk === 'medium' ? 'gold' : 'grn')}</div>
  <div class="chips mt2">${chip(m.status.replace('_', ' '), 'grey')}${m.safety_mode ? chip('Check-ins on', 'gold') : ''}</div>
  <div class="row wrap2">${m.status === 'proposed' && !m.proposed_by_me ? html`<button class="btn sm" data-act="mconfirm" data-id="${m.id}">Confirm</button>` : ''}${m.status === 'proposed' && m.proposed_by_me ? html`<span class="muted small">Waiting for them to confirm</span>` : ''}
  ${['confirmed', 'in_progress'].includes(m.status) && !m.arrived ? html`<button class="btn sm" data-act="marrive" data-id="${m.id}">I have arrived</button>` : ''}${m.arrived && !m.checked_out ? html`<button class="btn sm" data-act="mcheckout" data-id="${m.id}">I am safe, meeting done</button>` : ''}
  ${m.status === 'in_progress' ? html`<button class="btn red sm" data-act="msos" data-id="${m.id}">SOS</button>` : ''}</div></div>`;

/* ---------- actions ---------- */
const after = (msg) => { toast(msg); renderRoute(); };
act.paymethod = (el) => {
  const f = el.closest('form'); f.elements.method.value = el.dataset.v; f.querySelectorAll('.seg button').forEach((b) => b.classList.toggle('on', b === el));
  f.querySelector('[data-methodnote]').textContent = { card: 'Visa or Mastercard. In the live app the card form is hosted by our payment provider, so card details never touch our servers.', instant_eft: 'You approve the payment in your own bank app through our payment provider. We never see your banking login.', linked_eft: 'Paid from your linked business account with one approval.' }[el.dataset.v];
};
forms.pay = async (f, d) => { await api('POST', `/deals/${f.dataset.id}/pay`, { method: d.method, token: d.method === 'card' ? 'tok_visa' : undefined }); after('Payment held. Work can begin.'); };
act.deliver = async (el) => { await api('POST', `/deals/${el.dataset.id}/deliver`); after('Marked as delivered'); };
act.confirmdeal = async (el) => { const r = await api('POST', `/deals/${el.dataset.id}/confirm`); after(`Released. The expert receives ${R(r.split.expert_receives_rands)}.`); };
forms.dispute = async (f, d) => { await api('POST', `/deals/${f.dataset.id}/dispute`, { reason: d.reason }); after('Dispute raised. Staff will review.'); };
forms.cancel = async (f, d) => { const r = await api('POST', `/deals/${f.dataset.id}/cancel`, { reason: d.reason }); if (r.status === 'cancelled') { toast(r.refunded_rands ? `Cancelled. ${R(r.refunded_rands)} refunded.` : 'Deal cancelled'); return go('/deals'); } after('Request sent. The other party must agree.'); };
act.agreecancel = async (el) => { const r = await api('POST', `/deals/${el.dataset.id}/cancel`, { reason: 'Agreed' }); toast(r.refunded_rands ? `Cancelled. ${R(r.refunded_rands)} refunded.` : 'Deal cancelled'); go('/deals'); };
act.keepdeal = async (el) => { await api('POST', `/deals/${el.dataset.id}/cancel/decline`); after('The deal carries on'); };
act.removedeal = async (el) => { await api('DELETE', `/deals/${el.dataset.id}`); toast('Removed from your list'); go('/deals'); };
act.lockterms = async (el) => { const r = await api('POST', `/deals/${el.dataset.id}/terms/lock`); after(r.status === 'terms_locked' ? 'Terms locked. Time to swear your affidavits.' : 'You locked. Waiting for the other party.'); };
forms.terms = async (f, d) => { const terms = d.share_percent ? { share_percent: Number(d.share_percent), scope: d.scope || undefined } : { monthly_retainer: Number(d.monthly_retainer), scope: d.scope || undefined }; await api('PUT', `/deals/${f.dataset.id}/terms`, { terms }); after('Terms updated. Both sides must lock again.'); };
forms.affidavit = async (f, d) => {
  const file = f.elements.scan.files[0]; if (!file) return toast('Attach the stamped copy');
  await api('POST', `/deals/${f.dataset.id}/affidavit`, { file_sha256: await sha256File(file), commissioner_name: d.commissioner_name, commissioner_station: d.commissioner_station || undefined, commissioned_on: d.commissioned_on });
  after('Uploaded. Staff will verify it.');
};
act.viewaff = async (el) => {
  const a = await api('GET', `/deals/${el.dataset.id}/affidavit/counterparty`);
  const who = a.deponent.role === 'professional' ? `${a.deponent.name} (${a.deponent.registration.body ? a.deponent.registration.body + ' ' + a.deponent.registration.number : a.deponent.registration.qualification})` : `${a.deponent.company}, CIPC ${a.deponent.cipc_number}`;
  document.getElementById('aff').innerHTML = html`<div class="redact"><b>${a.deal_reference} · terms v${a.terms_version}</b>
Deponent: ${who}
${a.statement}
Commissioner: ${a.commissioner.name}${a.commissioner.station ? ', ' + a.commissioner.station : ''} on ${a.commissioner.date}
Hidden for privacy: ID number, home address, original scan
${a.watermark}</div>
    <div class="row mt2"><button class="btn sm" data-act="affconfirm" data-id="${el.dataset.id}">Confirm it matches</button><button class="btn ghost sm" data-act="affdispute" data-id="${el.dataset.id}">It does not match</button></div>`.s;
};
act.affconfirm = async (el) => { const r = await api('POST', `/deals/${el.dataset.id}/affidavit/review`, { decision: 'confirmed' }); after(r.status === 'formalised' ? 'Formalised! Both of you confirmed.' : 'Confirmed. Waiting for the other party.'); };
act.affdispute = async (el) => { const c = prompt('What does not match?'); if (!c || c.length < 5) return; await api('POST', `/deals/${el.dataset.id}/affidavit/review`, { decision: 'disputed', comment: c }); after('Terms reopened. New affidavits are needed.'); };

forms.meeting = async (f, d) => {
  const r = await api('POST', `/deals/${f.dataset.id}/meetings`, { scheduled_at: new Date(d.scheduled_at).toISOString(), duration_min: Number(d.duration_min), venue_type: d.venue_type, venue_name: d.venue_name || undefined, safety_mode: d.safety_mode === 'on' });
  after(`Sent. Safety level: ${r.risk}.${r.tip ? ' ' + r.tip : ''}`);
};
act.mconfirm = async (el) => { await api('POST', `/meetings/${el.dataset.id}/confirm`); after('Meeting confirmed'); };
act.marrive = async (el) => { await api('POST', `/meetings/${el.dataset.id}/arrive`); after('Checked in. Stay safe.'); };
act.mcheckout = async (el) => { await api('POST', `/meetings/${el.dataset.id}/checkout`); after('Glad you are safe'); };
act.msos = async (el) => {
  const send = async (loc) => { const r = await api('POST', `/meetings/${el.dataset.id}/sos`, loc || {}); toast(`SOS sent to ${r.alerted_contacts} contact(s). If in danger call 112 or 10111.`); };
  if (navigator.geolocation) navigator.geolocation.getCurrentPosition((p) => send({ lat: p.coords.latitude, lng: p.coords.longitude }).catch(() => {}), () => send().catch(() => {}), { timeout: 4000 }); else await send();
};
