import { route, html, page, act, forms, api, S, go, toast, R, when, chip, esc, renderRoute } from './core.js';

route('/admin', { roles: ['admin'] }, async () => {
  const q = await api('GET', '/admin/queue');
  const sec = (title, rows, empty) => html`<h3>${title} (${rows.length})</h3>${rows.length ? rows : html`<div class="muted small">${empty}</div>`}`;
  const btns = (kind, id, extra = '') => html`<div class="row mt2"><button class="btn sm" data-act="review" data-kind="${kind}" data-id="${id}" data-ok="1" ${extra}>Approve</button><button class="btn ghost sm" data-act="review" data-kind="${kind}" data-id="${id}" data-ok="0" ${extra}>Reject</button></div>`;
  return page('Review queue', html`
    ${sec('Businesses', q.businesses.map((b) => html`<div class="card"><b>${b.company_name}</b><div class="muted small">CIPC ${b.cipc_number} · director ID ends ${b.director_id_last4}</div><div class="mt2">${chip('Register check: ' + ({ match: 'matched', no_match: 'no match', error: 'check failed' }[b.registry_check] || 'not checked'), b.registry_check === 'match' ? 'grn' : b.registry_check === 'no_match' ? 'red' : 'grey')}</div>${btns('businesses', b.id)}</div>`), 'None waiting')}
    ${sec('Professionals', q.professionals.map((p) => html`<div class="card"><b>${p.full_name}</b><div class="muted small">Tier ${p.tier} · ${p.profession} · ${p.body} ${p.reg_number || p.institution || ''}</div>${btns('professionals', p.user_id)}</div>`), 'None waiting')}
    ${sec('Affidavits', q.affidavits.map((a) => html`<div class="card"><b>${a.party_role} affidavit</b><div class="muted small">Commissioner ${a.commissioner_name}, ${a.commissioned_on}. Check stamp, signature and that the terms match.</div>${btns('affidavits', a.id)}</div>`), 'None waiting')}
    ${sec('Bank account name checks', q.bank_accounts.map((b) => html`<div class="card"><b>${b.bank} ••••${b.last4}</b><div class="muted small">${b.owner_type} · holder “${b.holder_name}”</div>${btns('bank-accounts', b.id)}</div>`), 'None waiting')}
    ${sec('Disputes', q.disputed_payments.map((d) => html`<div class="card"><b>${R(d.amount_cents / 100)} held</b><div class="row mt2"><button class="btn sm" data-act="resolve" data-id="${d.deal_id}" data-o="release">Release to expert</button><button class="btn ghost sm" data-act="resolve" data-id="${d.deal_id}" data-o="refund">Refund payer</button></div></div>`), 'None open')}`, { back: '/menu' });
});
act.review = async (el) => {
  const ok = el.dataset.ok === '1', kind = el.dataset.kind;
  let reason; if (!ok) { reason = prompt('Reason for rejecting (the person will see this)'); if (!reason) return; }
  const path = kind === 'affidavits' ? `/admin/affidavits/${el.dataset.id}/verify` : `/admin/${kind}/${el.dataset.id}/review`;
  await api('POST', path, { approve: ok, reason, note: reason });
  toast(ok ? 'Approved' : 'Rejected'); renderRoute();
};
act.resolve = async (el) => { await api('POST', `/admin/deals/${el.dataset.id}/resolve`, { outcome: el.dataset.o }); toast('Dispute resolved'); renderRoute(); };
