import { route, html, raw, page, act, forms, api, S, go, toast, query, R, when, chip, statusChip, termsText, esc, renderRoute, pickerHtml, initPicker, withStepUp } from './core.js';

/* ---------- onboarding ---------- */
route('/onboard/business', { roles: ['entrepreneur'] }, () => page('Register your business', html`
  <p class="sub">Only CIPC-registered businesses can post requests. This protects the experts who respond.</p>
  <form data-form="business"><label>Company name</label><input name="company_name" required minlength="2" placeholder="Mokoena Build (Pty) Ltd">
  <label>CIPC registration number</label><input name="cipc_number" required placeholder="2019/123456/07">
  <label>Your ID number (13 digits)</label><input name="director_id" required inputmode="numeric" maxlength="13" placeholder="13 digits" autocomplete="off">
  <button class="btn full" type="submit">Submit for verification</button></form>
  <p class="note">You can register several businesses on one phone number, but every one must be registered to the same person: the ID number must always be yours. We keep only the last 4 digits. Not registered yet? Register with CIPC first. You also need it to open a business bank account.</p>`));
forms.business = async (_f, d) => { await api('POST', '/business', d); S.me = null; toast('Submitted. Staff will verify your business.'); go('/menu'); };

route('/onboard/sds', { roles: ['entrepreneur'] }, () => {
  const bs = S.me.businesses || [], id = query().get('b') || (bs.find((b) => b.blocked_at === 'sds') || bs[0])?.id, biz = bs.find((b) => b.id === id);
  if (!biz) return page('Service Delivery Standards', html`<div class="note warn">Register a business first.</div>`);
  return page('Service Delivery Standards', html`
  <p class="sub">For <b>${biz.company_name}</b>. Tell experts how you run this business. You sign once a year, for each business.</p>
  <form data-form="sds"><input type="hidden" name="business_id" value="${biz.id}"><label>What do you deliver to your own clients?</label><textarea name="services" rows="3" required minlength="10" placeholder="Construction, renovations and maintenance for commercial clients"></textarea>
  <label>How and when do you pay professionals?</label><input name="payment_terms" required minlength="5" placeholder="Through the platform, within 2 days of confirming the work">
  <label>How do you handle complaints?</label><input name="dispute_process" required minlength="5" placeholder="Written complaint, reply within 7 days">
  <label class="row"><input type="checkbox" name="no_licence_misuse"> <span>I will not use a professional's licence beyond the agreed scope.</span></label>
  <label class="row"><input type="checkbox" name="accept"> <span>I accept the Service Delivery Standards.</span></label>
  <button class="btn full" type="submit">Sign</button></form>`);
});
forms.sds = async (_f, d) => {
  await api('POST', '/business/sds', { business_id: d.business_id, accept: d.accept === 'on', answers: { services: d.services, payment_terms: d.payment_terms, dispute_process: d.dispute_process, no_licence_misuse: d.no_licence_misuse === 'on' } });
  S.me = null; toast('Signed. You can now post requests for this business.'); go('/menu');
};

/* ---------- new request ---------- */
route('/new', { roles: ['entrepreneur'] }, () => ({
  content: page('New request', html`
    <div class="card"><h2>Say it in your own words</h2><p class="sub small">We suggest the right expert and whether you need a consultation or licensing cover.</p>
      <textarea id="intake" rows="3" placeholder="e.g. My client wants a registered lawyer to sign off my tender contract before Friday"></textarea>
      <button class="btn ghost sm mt2" data-act="suggest">Suggest</button><div id="suggestion" aria-live="polite"></div></div>
    <form data-form="newthread">
      ${(S.me.businesses || []).filter((b) => b.can_post).length > 1 ? html`<label>Which business is this for?</label><select name="business_id">${(S.me.businesses || []).filter((b) => b.can_post).map((b) => html`<option value="${b.id}">${b.company_name}</option>`)}</select>` : ''}
      <div class="seg" role="radiogroup"><button type="button" class="on" data-act="need" data-v="consultation">Consultation</button><button type="button" data-act="need" data-v="licensing">Licensing cover</button></div>
      <input type="hidden" name="need_type" value="consultation">
      <label>Profession</label>${pickerHtml('')}
      <label>What is the job?</label><textarea name="description" rows="3" required minlength="10" placeholder="Supplier agreement needs review before signing"></textarea>
      <div data-block="consultation">
        <div class="row"><div class="grow"><label>Budget from (R)</label><input name="budget_min" type="number" min="1" value="800"></div><div class="grow"><label>Budget to (R)</label><input name="budget_max" type="number" min="1" value="1500"></div></div>
        <div class="row"><div class="grow"><label>Urgency</label><select name="urgency"><option value="now">Now</option><option value="today" selected>Today</option><option value="this_week">This week</option></select></div>
        <div class="grow"><label>Experts needed</label><select name="positions"><option>1</option><option>2</option><option>3</option><option>4</option><option>5</option></select></div></div>
        <label class="row" data-regrow hidden><input type="checkbox" name="requires_registration"> <span>Only match registered professionals (optional for consultations)</span></label>
      </div>
      <div data-block="licensing" hidden>
        <label>Arrangement</label><select name="engagement"><option value="partnership">Partnership</option><option value="employment">Employment</option></select>
        <div data-eng="partnership"><label>Profit share offered (%)</label><input name="share_percent" type="number" min="1" max="100" value="20"></div>
        <div data-eng="employment" hidden><label>Monthly retainer (R)</label><input name="monthly_retainer" type="number" min="1" value="15000"><label>Contract</label><select name="contract"><option value="fixed_term">Fixed term</option><option value="permanent">Permanent</option></select></div>
        <label>Scope of the work</label><input name="scope" placeholder="Tender sign-off and oversight">
        <p class="note">Licensing cover needs a registered professional whenever the profession has a regulator.</p>
      </div>
      <button class="btn full" type="submit">Post request</button>
    </form>`),
  after: () => {
    const form = document.querySelector('form[data-form=newthread]');
    initPicker(form.querySelector('[data-picker]'), (_n, info) => { form.querySelector('[data-regrow]').hidden = !(info.registered && form.elements.need_type.value === 'consultation'); });
    form.elements.engagement.addEventListener('change', () => form.querySelectorAll('[data-eng]').forEach((b) => (b.hidden = b.dataset.eng !== form.elements.engagement.value)));
  },
}));
act.need = (el) => {
  const form = document.querySelector('form[data-form=newthread]'); form.elements.need_type.value = el.dataset.v;
  form.parentElement.querySelectorAll('.seg button').forEach((b) => b.classList.toggle('on', b === el));
  form.querySelectorAll('[data-block]').forEach((b) => (b.hidden = b.dataset.block !== el.dataset.v));
};
act.suggest = async () => {
  const text = document.getElementById('intake').value, box = document.getElementById('suggestion');
  const r = await api('POST', '/intake', { text });
  if (r.error) return toast(r.error);
  box.innerHTML = r.profession ? html`<div class="note ok mt2">Suggested: <b>${r.profession}</b> (${r.registration_body}) · ${r.need_type === 'licensing' ? 'licensing cover' : 'consultation'}.
    <div class="mt2"><button class="btn sm" data-act="apply-suggest" data-p="${r.profession}" data-n="${r.need_type}" data-t="${text}">Use this</button></div></div>`.s
    : html`<div class="note warn mt2">We could not match that. Try the search below.</div>`.s;
};
act['apply-suggest'] = (el) => {
  const form = document.querySelector('form[data-form=newthread]');
  form.elements.profession.value = el.dataset.p; form.querySelector('[data-chosen]').textContent = 'Selected: ' + el.dataset.p;
  act.need({ dataset: { v: el.dataset.n } }); if (!form.elements.description.value) form.elements.description.value = el.dataset.t;
  toast('Applied. Check the details and post.');
};
forms.newthread = async (f, d) => {
  if (!d.profession) return toast('Pick a profession from the list');
  const lic = d.need_type === 'licensing';
  const body = { business_id: d.business_id || undefined, need_type: d.need_type, profession: d.profession, description: d.description, urgency: d.urgency };
  if (!lic) Object.assign(body, { budget_min: Number(d.budget_min), budget_max: Number(d.budget_max), positions: Number(d.positions), requires_registration: d.requires_registration === 'on' ? true : undefined });
  else Object.assign(body, { engagement: d.engagement, terms: d.engagement === 'partnership' ? { share_percent: Number(d.share_percent), scope: d.scope } : { monthly_retainer: Number(d.monthly_retainer), contract: d.contract, scope: d.scope } });
  try { const r = await api('POST', '/threads', body); toast(`Posted. ${r.notified} expert${r.notified === 1 ? '' : 's'} alerted.`); go('/request/' + r.id); }
  catch (e) { if (e.code?.startsWith('gate_')) { toast(e.message); return go('/menu'); } throw e; }
};

/* ---------- my requests and offers ---------- */
const threadCard = (t) => html`<div class="card"><div class="row between"><div><h2>${t.profession}</h2><div class="muted small">${t.description}</div></div>${statusChip(t.status)}</div>
  <div class="chips mt2">${chip(t.need_type === 'licensing' ? 'Licensing' : 'Consultation', t.need_type === 'licensing' ? 'gold' : 'grey')}${chip(`${t.filled} of ${t.positions} hired`, 'grey')}${chip(`${t.offers.length} offer${t.offers.length === 1 ? '' : 's'}`, 'grey')}</div>
  <button class="btn ghost sm" data-act="go" data-to="/request/${t.id}">Open</button></div>`;
route('/requests', { roles: ['entrepreneur'] }, async () => {
  const { threads } = await api('GET', '/threads/mine');
  return page('My requests', threads.length ? threads.map(threadCard) : html`<div class="empty">No requests yet.<br><button class="btn mt" data-act="go" data-to="/new">Post your first request</button></div>`);
});

route('/request/:id', { roles: ['entrepreneur'] }, async (id) => {
  const [{ threads }, { deals }] = await Promise.all([api('GET', '/threads/mine'), api('GET', '/deals')]);
  const t = threads.find((x) => x.id === id); if (!t) return page('Request', html`<div class="empty">Request not found.</div>`, { back: '/requests' });
  const hires = deals.filter((d) => d.thread_id === id), open = ['open', 'has_offers'].includes(t.status), seats = t.positions - t.filled;
  const offers = t.offers.filter((o) => o.status === 'pending');
  return page(t.profession, html`
    <div class="card"><div class="row between"><div class="muted small">${t.description}</div>${statusChip(t.status)}</div>
      <div class="chips mt2">${chip(t.need_type === 'licensing' ? 'Licensing' : 'Consultation', 'grey')}${t.need_type === 'consultation' ? chip(`${R(t.budget_min_rands)} to ${R(t.budget_max_rands)}`, 'grey') : chip(termsText(t.terms) || t.engagement, 'grey')}${chip(`${t.filled} of ${t.positions} hired`)}${t.requires_registration ? chip('Registered only', 'gold') : chip('Open to all verified experts', 'grey')}</div></div>
    ${hires.length ? html`<h3>Your hires</h3>${hires.map((d) => html`<div class="card"><div class="row between"><div><b>${d.counterparty.name}</b><div class="muted small">${d.counterparty.badge}</div></div>${statusChip(d.status)}</div><button class="btn ghost sm mt2" data-act="go" data-to="/deal/${d.id}">Open deal</button></div>`)}` : ''}
    <h3>${open && seats > 0 ? `Offers (${offers.length})` : 'Offers'}</h3>
    ${open && seats > 0 ? (offers.length ? offers.map((o) => offerCard(t, o)) : html`<div class="empty">Waiting for experts to respond. Only verified experts in this field were alerted.</div>`) : html`<div class="note">${t.status === 'matched' || t.status === 'formalised' ? 'You have hired everyone you asked for.' : 'This request is closed.'}</div>`}
    <div class="row wrap2 mt">${t.need_type === 'consultation' && !['closed', 'expired'].includes(t.status) && t.positions < 5 ? html`<button class="btn ghost sm" data-act="addpos" data-id="${t.id}">Hire another consultant</button>` : ''}${open ? html`<button class="btn ghost sm" data-act="closereq" data-id="${t.id}">Stop looking</button>` : ''}</div>
    <p class="note">Experts see your business name only after they respond. No contact details are shared until you pick.</p>`, { back: '/requests' });
});
const offerCard = (t, o) => html`<div class="card"><div class="row between"><div><b>${o.professional.name}</b><div class="muted small">★ ${o.professional.rating || 'new'} · ${o.professional.jobs} jobs</div></div>
  <div class="right"><div class="price">${t.need_type === 'consultation' ? R(o.amount_rands) : termsText(o.terms)}</div>${chip(o.kind === 'counter' ? `Counter · round ${o.round}` : 'Interested', o.kind === 'counter' ? 'red' : 'grn')}</div></div>
  <div class="mt2">${chip(o.professional.badge, o.professional.tier === 1 ? 'gold' : 'grey')}</div>${o.note ? html`<p class="muted mt2 mb0">“${o.note}”</p>` : ''}
  <button class="btn sm mt2" data-act="pick" data-thread="${t.id}" data-offer="${o.id}">Pick ${o.professional.name.split(' ')[0]}</button></div>`;
act.pick = async (el) => {
  const r = await api('POST', `/threads/${el.dataset.thread}/pick`, { offer_id: el.dataset.offer });
  toast(r.still_hiring ? `Hired. ${r.positions - r.filled} more to go.` : 'Hired. Other experts were told.');
  go('/deal/' + r.deal_id);
};
act.addpos = async (el) => { const r = await api('POST', `/threads/${el.dataset.id}/positions`, { count: 1 }); toast(`Now hiring ${r.positions}. ${r.revived_offers} earlier offer${r.revived_offers === 1 ? '' : 's'} came back.`); renderRoute(); };
act.closereq = async (el) => { await api('POST', `/threads/${el.dataset.id}/close`); toast('Request closed'); renderRoute(); };

/* ---------- business bank account ---------- */
const BANKS = ['FNB', 'Standard Bank', 'Absa', 'Nedbank', 'Capitec', 'TymeBank', 'Discovery Bank', 'African Bank'];
export const bankForm = (name, holder, label, extra = '') => html`<form data-form="${name}">${extra}<label>Bank</label><select name="bank">${BANKS.map((b) => html`<option>${b}</option>`)}</select>
  <label>Account holder name</label><input name="holder_name" required value="${holder || ''}"><label>Account type</label><select name="account_type"><option value="cheque">Cheque or current</option><option value="savings">Savings</option></select>
  <label>Account number</label><input name="account_number" required inputmode="numeric" minlength="8" maxlength="11" placeholder="8 to 11 digits"><button class="btn full" type="submit">${label}</button></form>`;
export const accountCard = (a, noneText) => a ? html`<div class="card"><div class="row between"><div><b>${a.bank} ••••${a.last4}</b><div class="muted small">${a.status === 'verified' ? 'Name matches. Verified.' : 'Name does not match. Staff are checking.'}</div></div>${chip(a.status === 'verified' ? 'Verified' : 'In review', a.status === 'verified' ? 'grn' : 'gold')}</div>
  ${a.hold_until && a.hold_until > Date.now() ? html`<div class="note warn">Payouts are on hold until ${when(a.hold_until)} because the account was changed.</div>` : ''}</div>` : html`<div class="note">${noneText}</div>`;
route('/bank', { roles: ['entrepreneur'] }, async () => {
  const bs = (S.me.businesses || []).filter((b) => b.status === 'verified');
  if (!bs.length) return page('Business bank accounts', html`<div class="note warn">Your business must be verified before you can link a bank account.</div>`);
  const biz = bs.find((b) => b.id === query().get('b')) || bs[0];
  const { account } = await api('GET', '/bank-account?business_id=' + biz.id);
  return page('Business bank accounts', html`
    ${bs.length > 1 ? html`<div class="chips">${bs.map((b) => html`<button class="btn ${b.id === biz.id ? '' : 'ghost'} sm" data-act="go" data-to="/bank?b=${b.id}">${b.company_name}</button>`)}</div>` : ''}
    <p class="sub">For <b>${biz.company_name}</b>.</p>${accountCard(account, 'No account linked yet.')}
    <h3>${account ? 'Replace the linked account' : 'Link your account'}</h3>${bankForm('bank', biz.company_name, 'Link account', html`<input type="hidden" name="business_id" value="${biz.id}">`)}
    <p class="note">The account holder must match this business's registered name. In the live app the bank's own secure page confirms this: we never see your banking password. Refunds always go back to this account.</p>`);
});
forms.bank = async (_f, d) => { const r = await withStepUp(() => api('POST', '/bank-account', d)); toast(r.status === 'verified' ? 'Account linked and verified' : 'Linked. Staff will check the name.'); renderRoute(); };
