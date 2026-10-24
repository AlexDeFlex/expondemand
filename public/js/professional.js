import { route, html, page, act, forms, api, S, go, toast, R, when, chip, statusChip, termsText, esc, renderRoute, pickerHtml, initPicker, withStepUp, sha256File } from './core.js';
import { bankForm, accountCard } from './entrepreneur.js';

route('/onboard/pro', { roles: ['professional'] }, () => ({
  content: page('Your professional profile', html`
    <p class="sub">We verify every professional before they can bid. Registered professionals are checked against their regulator.</p>
    <form data-form="profile">
      <label>Full name (as on your ID)</label><input name="full_name" required minlength="3" autocomplete="name">
      <label>Your ID number (13 digits)</label><input name="id_number" required inputmode="numeric" maxlength="13" placeholder="13 digits" autocomplete="off">
      <label>I am a</label><select name="tier"><option value="1">Registered professional</option><option value="2">Candidate (working under a supervisor)</option><option value="3">Graduate or student</option></select>
      <label>Profession</label>${pickerHtml('')}
      <div data-tier="1 2"><label>Registration or licence number <span class="muted small">(if your profession has one)</span></label><input name="reg_number" placeholder="e.g. 4821"></div>
      <div data-tier="2" hidden><label>Your supervising professional's mobile number</label><input name="supervisor_phone" type="tel" placeholder="082 123 4567"></div>
      <div data-tier="3" hidden><label>Institution</label><input name="institution" placeholder="University of the Witwatersrand"></div>
      <label>Proof (certificate, registration card, or proof of enrolment)</label><input type="file" name="proof" accept="image/*,application/pdf" required>
      <p class="note">Your file is fingerprinted on this device. In the live app it is uploaded to private, encrypted storage for staff to check.</p>
      <button class="btn full" type="submit">Submit for verification</button>
    </form>
    <p class="note" id="tiernote">Registered professionals can sign off regulated work and offer licensing cover.</p>`),
  after: () => {
    const f = document.querySelector('form[data-form=profile]');
    initPicker(f.querySelector('[data-picker]'));
    const sync = () => { f.querySelectorAll('[data-tier]').forEach((b) => (b.hidden = !b.dataset.tier.split(' ').includes(f.elements.tier.value)));
      document.getElementById('tiernote').textContent = { 1: 'Registered professionals can sign off regulated work and offer licensing cover.', 2: 'Candidates work under a supervising registered professional.', 3: 'Graduates can take non-regulated work such as research, drafting and admin.' }[f.elements.tier.value]; };
    f.elements.tier.addEventListener('change', sync); sync();
  },
}));
forms.profile = async (f, d) => {
  if (!d.profession) return toast('Pick your profession from the list');
  const file = f.elements.proof.files[0]; if (!file) return toast('Attach your proof document');
  const body = { full_name: d.full_name, tier: Number(d.tier), profession: d.profession, proof_sha256: await sha256File(file), id_number: d.id_number };
  if (body.tier < 3) { if (d.reg_number) body.reg_number = d.reg_number; } else body.institution = d.institution;
  if (body.tier === 2) body.supervisor_phone = d.supervisor_phone;
  await api('POST', '/professional', body); S.me = null; toast('Submitted. Staff will verify you.'); go('/menu');
};

route('/payout', { roles: ['professional'] }, async () => {
  const p = S.me.professional;
  if (!p || p.status !== 'verified') return page('Payout account', html`<div class="note warn">You can set up payouts once staff have verified you.</div>`);
  const { account } = await api('GET', '/bank-account');
  return page('Payout account', html`${accountCard(account, 'No payout account yet. You are paid here after each job.')}
    <h3>${account ? 'Change payout account' : 'Set up payouts'}</h3>${bankForm('payout', S.me.user.full_name, 'Verify and save')}
    <p class="note">The account holder must match your verified name. If you change the account, payouts are held for 48 hours as protection against fraud. You keep the fee shown on each offer after the platform fee.</p>`);
});
forms.payout = async (_f, d) => { const r = await withStepUp(() => api('POST', '/bank-account', d)); toast(r.status === 'verified' ? 'Payout account saved' : 'Saved. Staff will check the name.'); renderRoute(); };

/* ---------- jobs ---------- */
const jobCard = (t) => html`<div class="card"><div class="row between"><div><h2>${t.profession}</h2><div class="muted small">${t.description}</div></div>${chip(t.need_type === 'licensing' ? 'Licensing' : 'Consultation', t.need_type === 'licensing' ? 'gold' : '')}</div>
  <div class="chips mt2">${chip(t.need_type === 'consultation' ? `${R(t.budget_min_rands)} to ${R(t.budget_max_rands)}` : termsText(t.terms), 'grey')}${chip(t.business.company_name, 'grey')}${t.urgency ? chip(t.urgency.replace('_', ' '), 'grey') : ''}</div>
  <button class="btn sm" data-act="go" data-to="/job/${t.id}">View and respond</button></div>`;
route('/jobs', { roles: ['professional'] }, async () => {
  const { threads } = await api('GET', '/feed');
  const draw = (q) => { const k = q.toLowerCase().trim(); const list = threads.filter((t) => !k || `${t.profession} ${t.description} ${t.business.company_name} ${t.need_type}`.toLowerCase().includes(k));
    return `<div class="muted small mt2" data-count>${list.length} job${list.length === 1 ? '' : 's'} for your expertise${k ? ` matching “${esc(q.trim())}”` : ''}</div>` + (list.length ? list.map((t) => jobCard(t).s).join('') : '<div class="empty">No jobs match. Clear the search.</div>'); };
  return { content: page('Jobs for you', html`<p class="sub">Only requests in your field that you are verified for appear here.</p><input type="search" id="jq" placeholder="Search by keyword, business or type" autocomplete="off"><div id="jobs">${html`${draw('')}`.s ? '' : ''}</div>`),
    after: () => { const box = document.getElementById('jobs'), q = document.getElementById('jq'); box.innerHTML = draw(''); q.addEventListener('input', () => { box.innerHTML = draw(q.value); }); } };
});

route('/job/:id', { roles: ['professional'] }, async (id) => {
  const [{ threads }, { offers }] = await Promise.all([api('GET', '/feed'), api('GET', '/offers/mine')]);
  const t = threads.find((x) => x.id === id), mine = offers.find((o) => o.thread_id === id);
  if (!t) return page('Job', html`<div class="empty">This job is no longer open.</div>`, { back: '/jobs' });
  const lic = t.need_type === 'licensing';
  return page(t.profession, html`
    <div class="card"><p>${t.description}</p><div class="chips">${chip(lic ? 'Licensing' : 'Consultation', lic ? 'gold' : '')}${chip(lic ? termsText(t.terms) : `${R(t.budget_min_rands)} to ${R(t.budget_max_rands)}`, 'grey')}${chip(t.business.company_name, 'grey')}${chip('CIPC verified', 'grn')}${t.requires_registration ? chip('Registered professionals only', 'gold') : ''}</div></div>
    ${mine ? html`<div class="note ok">Your offer: ${lic ? termsText(mine.terms) : R(mine.amount_rands)} (${mine.kind}, round ${mine.round}). Status: ${mine.status}. You can change it below.</div>` : ''}
    <form data-form="offer" data-id="${t.id}" data-lic="${lic ? 1 : 0}">
      <label>Your response</label><div class="seg"><button type="button" class="on" data-act="okind" data-v="interested">I accept your terms</button><button type="button" data-act="okind" data-v="counter">Counter-offer</button></div>
      <input type="hidden" name="kind" value="interested">
      <div data-counter hidden>${lic ? html`<div class="chips mt2">${chip(t.engagement === 'partnership' ? 'Partnership' : 'Employment', 'grey')}</div>${t.terms?.share_percent != null ? html`<label>Profit share you want (%)</label><input name="share_percent" type="number" min="1" max="100" value="${t.terms.share_percent}">` : html`<label>Monthly retainer you want (R)</label><input name="monthly_retainer" type="number" min="1" value="${(t.terms?.monthly_retainer_cents || 0) / 100}">`}`
        : html`<label>Your price (R)</label><input name="amount" type="number" min="1" value="${t.budget_max_rands}"><div class="muted small mt2" data-take></div>`}</div>
      <label>Why you are the right expert</label><textarea name="note" rows="2" maxlength="500" placeholder="12 years in this field. I can start in 2 hours."></textarea>
      <button class="btn full" type="submit">${mine ? 'Update my offer' : 'Send offer'}</button>
    </form>
    <p class="note">The entrepreneur sees your badge, rating and note beside your price. Counter-offers are limited to 3 rounds.</p>`, { back: '/jobs' });
});
act.okind = (el) => { const f = el.closest('form'); f.elements.kind.value = el.dataset.v; f.querySelectorAll('.seg button').forEach((b) => b.classList.toggle('on', b === el)); f.querySelector('[data-counter]').hidden = el.dataset.v !== 'counter'; };
forms.offer = async (f, d) => {
  const lic = f.dataset.lic === '1', body = { kind: d.kind, note: d.note || undefined };
  if (d.kind === 'counter') { if (lic) body.terms = d.share_percent ? { share_percent: Number(d.share_percent), scope: 'As posted' } : { monthly_retainer_cents: Math.round(Number(d.monthly_retainer) * 100), contract: 'fixed_term', scope: 'As posted' }; else body.amount = Number(d.amount); }
  const r = await api('POST', `/threads/${f.dataset.id}/offers`, body);
  toast(r.you_receive ? `Offer sent. You would receive ${R(r.you_receive.payout_cents / 100)} after the platform fee.` : 'Offer sent'); go('/offers');
};

route('/offers', { roles: ['professional'] }, async () => {
  const { offers } = await api('GET', '/offers/mine');
  return page('My offers', offers.length ? offers.map((o) => html`<div class="card"><div class="row between"><div><h2>${o.profession}</h2><div class="muted small">${o.business}</div></div>${o.status === 'accepted' ? chip('You were picked', 'grn') : chip(o.status, o.status === 'pending' ? '' : 'grey')}</div>
    <div class="chips mt2">${chip(o.need_type === 'licensing' ? termsText(o.terms) : R(o.amount_rands), 'grey')}${chip(`${o.kind} · round ${o.round}`, 'grey')}</div>
    <div class="row wrap2">${o.deal_id ? html`<button class="btn sm" data-act="go" data-to="/deal/${o.deal_id}">Open deal</button>` : o.status === 'pending' || o.status === 'expired' ? html`<button class="btn ghost sm" data-act="go" data-to="/job/${o.thread_id}">Change offer</button>` : ''}</div></div>`)
    : html`<div class="empty">You have not sent any offers.<br><button class="btn mt" data-act="go" data-to="/jobs">Find jobs</button></div>`);
});
