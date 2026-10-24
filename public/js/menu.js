import { route, html, raw, page, act, forms, api, S, loadMe, go, toast, R, when, chip, esc, renderRoute } from './core.js';

const NOTE = {
  'thread.new': ['A new request in your field', (n) => '/job/' + n.body.thread_id], 'offer.new': ['You have a new offer', (n) => '/request/' + n.body.thread_id],
  'offer.picked': ['You were picked for a job', (n) => '/deal/' + n.body.deal_id], 'thread.closed': ['A request you offered on has closed', () => '/offers'],
  'offer.reopened': ['A request reopened. Your offer is back', () => '/offers'], 'payment.held': ['Payment is held. You can start work', (n) => '/deal/' + n.body.deal_id],
  'deal.delivered': ['Work marked delivered. Please confirm', (n) => '/deal/' + n.body.deal_id], 'payout.paid': ['Your payout was sent', () => '/deals'],
  'payout.waiting': ['A payout is waiting for a verified payout account', () => '/payout'], 'payout.failed': ['A payout failed. We will retry', () => '/deals'],
  'deal.cancel_requested': ['Someone asked to cancel a deal', (n) => '/deal/' + n.body.deal_id], 'deal.cancelled': ['A deal was cancelled', (n) => '/deal/' + n.body.deal_id],
  'deal.cancel_withdrawn': ['A cancellation request was withdrawn', (n) => '/deal/' + n.body.deal_id], 'deal.disputed': ['A deal is in dispute. Staff will review', (n) => '/deal/' + n.body.deal_id],
  'terms.changed': ['Terms changed. Review and lock again', (n) => '/deal/' + n.body.deal_id], 'terms.lock_requested': ['Please review and lock the terms', (n) => '/deal/' + n.body.deal_id],
  'terms.disputed': ['Terms were disputed and reopened', (n) => '/deal/' + n.body.deal_id], 'affidavit.verified': ['Your affidavit was verified', (n) => '/deal/' + n.body.deal_id],
  'affidavit.rejected': ['Your affidavit was rejected. Please resubmit', (n) => '/deal/' + n.body.deal_id], 'affidavit.ready_for_review': ['Both affidavits are verified. Please review', (n) => '/deal/' + n.body.deal_id],
  'deal.formalised': ['Deal formalised', (n) => '/deal/' + n.body.deal_id], 'meeting.proposed': ['A meeting was proposed', () => '/deals'],
  'safety.are_you_safe': ['Your meeting has ended. Are you safe?', () => '/deals'], 'business.verified': ['Your business was verified', () => '/menu'],
  'business.rejected': ['Your business verification needs attention', () => '/menu'], 'professional.verified': ['You are verified. You can now bid on jobs', () => '/menu'],
  'professional.rejected': ['Your verification needs attention', () => '/menu'], 'sos': ['SOS pressed during a meeting', () => '/admin'], 'safety.welfare_check': ['Welfare check needed', () => '/admin'],
};

route('/menu', {}, async () => {
  const me = await loadMe(), u = me.user, roles = me.roles || [u.role];   // always fresh: staff approvals show up without signing out
  if (u.role === 'admin') return page('Staff', html`
    <button class="tile on" data-act="go" data-to="/admin"><b>Review queue</b><span class="muted small">Businesses, professionals, affidavits, bank accounts, disputes</span></button>
    <button class="tile" data-act="runjobs"><b>Run scheduled jobs now</b><span class="muted small">Expire threads, auto-release payments, safety escalation</span></button>
    <button class="tile" data-act="go" data-to="/account"><b>Account</b><span class="muted small">Sign out</span></button>`, { back: null });
  // One phone number, one person, two possible hats. Switching needs no new code.
  const hat = u.role === 'entrepreneur'
    ? (roles.includes('professional') ? html`<button class="tile" data-act="switchrole" data-role="professional"><b>Switch to my professional side</b><span class="muted small">Same phone number, same person</span></button>`
      : html`<button class="tile" data-act="go" data-to="/add-role/professional"><b>I am also a professional</b><span class="muted small">Add it with your ID number</span></button>`)
    : (roles.includes('entrepreneur') ? html`<button class="tile" data-act="switchrole" data-role="entrepreneur"><b>Switch to my business side</b><span class="muted small">Same phone number, same person</span></button>`
      : html`<button class="tile" data-act="go" data-to="/add-role/entrepreneur"><b>I also run a business</b><span class="muted small">Add it with your ID number</span></button>`);
  if (u.role === 'entrepreneur') {
    const bs = me.businesses || [], ready = bs.filter((b) => b.can_post);
    const cards = bs.map((b) => html`<div class="card"><div class="row between"><div><b>${b.company_name}</b><div class="muted small">CIPC ${b.cipc_number}</div></div>${b.can_post ? chip('Ready to post', 'grn') : b.blocked_at === 'cipc' ? chip('Staff verifying', 'gold') : chip('Sign the standards', 'gold')}</div>
      ${b.blocked_at === 'cipc' ? html`<div class="note warn">Staff are verifying this business with CIPC. You will get a message when it is done. <button class="btn ghost sm" data-act="refresh">Refresh</button></div>` : ''}
      ${b.blocked_at === 'sds' ? html`<button class="btn sm mt2" data-act="go" data-to="/onboard/sds?b=${b.id}">Sign the Service Delivery Standards</button>` : ''}</div>`);
    return page(bs.length === 1 ? `Hello, ${bs[0].company_name}` : 'Hello', html`
      ${bs.length ? '' : html`<button class="tile on" data-act="go" data-to="/onboard/business"><b>Step 1: register your business</b><span class="muted small">CIPC number and your ID number</span></button>`}${cards}
      <button class="tile ${ready.length ? 'on' : ''}" data-act="go" data-to="/new" ${ready.length ? '' : 'disabled'}><b>New request</b><span class="muted small">Find an expert for a consultation or licensing cover</span></button>
      <button class="tile" data-act="go" data-to="/requests"><b>My requests</b><span class="muted small">Offers, hiring more experts</span></button>
      <button class="tile" data-act="go" data-to="/deals"><b>My deals</b><span class="muted small">Payments, paperwork, meetings</span></button>
      <button class="tile" data-act="go" data-to="/bank"><b>Business bank accounts</b><span class="muted small">Link the account you pay from</span></button>
      ${bs.length ? html`<button class="tile" data-act="go" data-to="/onboard/business"><b>Add another business</b><span class="muted small">Must be registered to the same person (your ID number)</span></button>` : ''}
      <button class="tile" data-act="go" data-to="/contacts"><b>Safety contacts</b><span class="muted small">People we alert if a meeting goes wrong</span></button>
      ${hat}
      <button class="tile" data-act="go" data-to="/account"><b>Account</b><span class="muted small">Your data, sign out</span></button>
      <p class="note">You stay signed in on this device. Use Back to move around: no new code is needed.</p>`, { back: null });
  }
  const p = me.professional;
  const acct = p && p.status === 'verified' ? (await api('GET', '/bank-account')).account : null;
  const banner = !p ? html`<button class="tile on" data-act="go" data-to="/onboard/pro"><b>Complete your profile</b><span class="muted small">Your profession and proof of registration or studies</span></button>`
    : p.status === 'pending' ? html`<div class="note warn">Staff are checking your credentials. You will get a message when you are verified. <button class="btn ghost sm" data-act="refresh">Refresh</button></div>`
    : p.status === 'rejected' ? html`<div class="note bad">Your verification needs attention: ${p.review_note || 'please contact support'}.</div>` : '';
  return page('Welcome back', html`
    <div class="chips">${p ? chip(p.profession, 'grey') : ''}${p?.status === 'verified' ? chip(p.tier === 1 ? 'Tier 1' : p.tier === 2 ? 'Candidate' : 'Graduate', 'gold') : ''}</div>${banner}
    <button class="tile ${p?.status === 'verified' ? 'on' : ''}" data-act="go" data-to="/jobs" ${p?.status === 'verified' ? '' : 'disabled'}><b>Find jobs</b><span class="muted small">Search jobs in your expertise</span></button>
    <button class="tile" data-act="go" data-to="/offers"><b>My offers</b><span class="muted small">Offers you sent and their status</span></button>
    <button class="tile" data-act="go" data-to="/deals"><b>My deals</b><span class="muted small">Work, payouts, paperwork</span></button>
    <button class="tile" data-act="go" data-to="/payout"><b>Payout account</b><span class="muted small">${acct ? esc(acct.bank) + ' ••••' + esc(acct.last4) : 'Not set up yet'}</span></button>
    ${p?.status === 'verified' ? html`<div class="card"><label class="row mb0"><input type="checkbox" data-act="avail" ${p.available ? 'checked' : ''}> <span>Available for new jobs</span></label></div>` : ''}
    <button class="tile" data-act="go" data-to="/contacts"><b>Safety contacts</b><span class="muted small">People we alert if a meeting goes wrong</span></button>
    ${hat}
    <button class="tile" data-act="go" data-to="/account"><b>Account</b><span class="muted small">Your data, sign out</span></button>
    <p class="note">You stay signed in on this device. Use Back to move around: no new code is needed.</p>`, { back: null });
});
act.switchrole = async (el) => { await api('POST', '/auth/switch-role', { role: el.dataset.role }); S.me = null; toast('Switched'); go('/menu'); };
act.go = (el) => go(el.dataset.to);
act.refresh = async () => { S.me = null; renderRoute(); };
act.avail = async (el) => { await api('PATCH', '/professional/availability', { available: el.checked }); S.me = null; toast(el.checked ? 'You are available for new jobs' : 'You are set to unavailable'); };
act.runjobs = async () => { const r = await api('POST', '/admin/jobs/run'); toast(`Jobs done: ${JSON.stringify(r.threads)}`); };

route('/inbox', {}, async () => {
  const r = await api('GET', '/me/notifications'); S.notifs = r.notifications;
  S.seen = Date.now(); localStorage.setItem('eod_seen', String(S.seen));
  const rows = r.notifications.map((n) => { const m = NOTE[n.type]; return html`<div class="card"><div class="row between"><div>${m ? m[0] : n.type}<div class="muted small">${when(n.at)}</div></div>${m && n.body ? html`<button class="btn ghost sm" data-act="go" data-to="${m[1](n)}">Open</button>` : ''}</div></div>`; });
  return page('Inbox', rows.length ? rows : html`<div class="empty">Nothing yet. Offers, payments and safety alerts appear here.</div>`);
});

route('/account', {}, () => page('Account', html`
  <div class="card"><div class="kv"><span>Signed in as</span><span>${S.me.user.phone}</span></div><div class="kv"><span>Registered as</span><span>${(S.me.roles || [S.me.user.role]).join(' and ')}</span></div></div>
  <button class="tile" data-act="download"><b>Download my data</b><span class="muted small">A copy of everything we hold about you</span></button>
  <button class="tile" data-act="signout"><b>Sign out</b><span class="muted small">On this device only</span></button>
  <details class="card"><summary>Delete my account</summary><p class="small muted mt2">This removes your phone number, bank tokens and contacts. Anonymised deal and payment records are kept for tax and dispute purposes. You must finish or close open requests and deals first.</p>
    <form data-form="erase"><label>Type DELETE to confirm</label><input name="confirm" autocomplete="off"><button class="btn red full" type="submit">Delete my account</button></form></details>`));
act.download = async () => {
  const data = await api('GET', '/me/export');
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })); a.download = 'my-expondemand-data.json'; a.click();
};
forms.erase = async (_f, d) => {
  if (d.confirm !== 'DELETE') return toast('Type DELETE to confirm');
  await api('DELETE', '/me'); toast('Your account was deleted'); const { setSession } = await import('./core.js'); setSession(null); go('/welcome');
};
