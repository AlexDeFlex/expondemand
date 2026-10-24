// Core: state, safe HTML templating, API client, router, page shell. No framework, no build step.
export const S = { demo: false, token: localStorage.getItem('eod_token'), me: null, notifs: [], seen: Number(localStorage.getItem('eod_seen') || 0) };

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);
class Raw { constructor(s) { this.s = s; } }
export const raw = (s) => new Raw(s);
const val = (v) => (v instanceof Raw ? v.s : Array.isArray(v) ? v.map(val).join('') : v == null || v === false ? '' : esc(v));
/** Tagged template: every interpolated value is escaped unless it is already trusted markup. */
export const html = (a, ...v) => new Raw(a.reduce((r, s, i) => r + s + (i < v.length ? val(v[i]) : ''), ''));

export const R = (n) => 'R' + Number(n).toLocaleString('en-ZA', { minimumFractionDigits: Number.isInteger(+n) ? 0 : 2, maximumFractionDigits: 2 });
export const when = (ms) => new Date(ms).toLocaleString('en-ZA', { dateStyle: 'medium', timeStyle: 'short' });
export const chip = (text, kind = '') => html`<span class="chip ${kind}">${text}</span>`;
export const termsText = (t) => !t ? '' : t.share_percent != null ? `${t.share_percent}% profit share` : t.monthly_retainer_cents != null ? `${R(t.monthly_retainer_cents / 100)} per month (${t.contract === 'permanent' ? 'permanent' : 'fixed term'})` : '';
export const STATUS = { open: ['Waiting for offers', ''], has_offers: ['Offers in', ''], matched: ['Matched', 'grn'], formalised: ['Done', 'grn'], closed: ['Closed', 'grey'], expired: ['Expired', 'grey'], awaiting_payment: ['Awaiting payment', 'gold'], in_progress: ['In progress', ''], completed: ['Completed', 'grn'], disputed: ['In dispute', 'red'], refunded: ['Refunded', 'grey'], cancelled: ['Cancelled', 'grey'], terms_pending: ['Agree the terms', 'gold'], terms_locked: ['Swear affidavits', 'gold'], under_review: ['Review affidavits', 'gold'] };
export const statusChip = (s) => { const [t, k] = STATUS[s] || [s, 'grey']; return chip(t, k); };

const BASE = (window.EOD_CONFIG && window.EOD_CONFIG.api) || '';
export async function api(method, path, body) {
  const res = await fetch(BASE + path, { method, headers: { 'content-type': 'application/json', ...(S.token ? { authorization: 'Bearer ' + S.token } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => null);
  if (!res.ok) { const e = new Error(data?.error || 'Something went wrong'); e.status = res.status; e.code = data?.code; throw e; }
  return data;
}

let toastTimer;
export function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg; t.classList.add('show'); clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 3200);
}

export const query = () => new URLSearchParams(location.hash.split('?')[1] || '');
export const go = (p) => { if (location.hash === '#' + p) renderRoute(); else location.hash = '#' + p; };
export const setSession = (token) => { S.token = token; S.me = null; token ? localStorage.setItem('eod_token', token) : localStorage.removeItem('eod_token'); };
export async function loadMe() { S.me = await api('GET', '/me'); return S.me; }

/* ---------- router ---------- */
const routes = [];
export function route(pattern, opts, fn) {
  const re = new RegExp('^' + pattern.replace(/:\w+/g, '([^/]+)') + '$');
  routes.push({ re, opts, fn });
}
export function view(content, after) {
  document.getElementById('app').innerHTML = content.s;
  window.scrollTo(0, 0);
  after?.();
}
export async function renderRoute() {
  const path = (location.hash.slice(1) || '/').split('?')[0];
  const r = routes.find((x) => x.re.test(path));
  if (!r) return view(page('Not found', html`<div class="empty">That page does not exist.</div>`));
  try {
    if (r.opts.auth !== false) {
      if (!S.token) return go('/welcome');
      if (!S.me) await loadMe();
      if (r.opts.roles && !r.opts.roles.includes(S.me.user.role)) return go('/menu');
      refreshNotifs();
    }
    const out = await r.fn(...path.match(r.re).slice(1));
    if (out) view(out.content || out, out.after);
  } catch (e) {
    if (e.status === 401) { setSession(null); return go('/welcome'); }
    view(page('Something went wrong', html`<div class="note bad">${e.message}</div><button class="btn full" data-act="menu">Back to menu</button>`));
  }
}
export function refreshNotifs() {
  api('GET', '/me/notifications').then((r) => {
    S.notifs = r.notifications;
    const n = unread(), b = document.querySelector('[data-bell]');
    if (b) b.textContent = n ? `Inbox (${n})` : 'Inbox';
  }).catch(() => {});
}
export const unread = () => S.notifs.filter((n) => n.at > S.seen).length;

/** Page shell: brand, inbox and menu shortcuts, a Back button to the logical parent, and a title. */
export function page(title, body, { back = '/menu', sub = '' } = {}) {
  const signedIn = !!S.token && !!S.me;
  const n = unread();
  return html`<div class="wrap">
    <div class="top"><div class="brand">Exp<b>On</b>Demand</div>
      ${signedIn ? html`<div class="row"><button class="btn ghost sm" data-act="inbox" data-bell>${n ? `Inbox (${n})` : 'Inbox'}</button></div>` : ''}</div>
    ${back ? html`<div class="nav"><button class="btn ghost sm" data-act="back" data-to="${back}">← Back</button></div>` : ''}
    ${S.demo ? html`<div class="note warn">Demo mode: sign in with the code <b>123456</b>. All data here is fake.</div>` : ''}
    <h1>${title}</h1>${sub ? html`<p class="sub">${sub}</p>` : ''}
    ${body}</div>`;
}

/* ---------- events: one delegated listener each, no inline handlers (strict CSP) ---------- */
export const act = {};      // data-act="name"
export const forms = {};    // <form data-form="name">
const fail = async (e) => {
  if (e.code === 'step_up_required') return toast('Confirm it is you, then try again.');
  toast(e.message || 'Something went wrong');
};
document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-act]');
  if (!el || el.disabled) return;
  const fn = act[el.dataset.act];
  if (!fn) return;
  e.preventDefault();
  Promise.resolve(fn(el, e)).catch(fail);
});
document.addEventListener('submit', (e) => {
  const f = e.target.closest('form[data-form]');
  if (!f) return;
  e.preventDefault();
  const fn = forms[f.dataset.form];
  if (!fn) return;
  const btn = f.querySelector('button[type=submit]');
  if (btn) btn.disabled = true;
  Promise.resolve(fn(f, Object.fromEntries(new FormData(f)), e)).catch(fail).finally(() => { if (btn && btn.isConnected) btn.disabled = false; });
});
act.back = (el) => go(el.dataset.to || '/menu');
act.menu = () => go('/menu');
act.inbox = () => go('/inbox');

/** Sensitive actions: if the server asks for a fresh code, collect it in a small dialog, then retry. */
export function stepUp() {
  return new Promise(async (resolve, reject) => {
    const modal = document.getElementById('modal');
    await api('POST', '/auth/step-up/request');
    modal.innerHTML = html`<div class="card"><h2>Confirm it is you</h2><p class="sub small">We sent a code to your phone. This keeps your bank details safe.</p>
      <form data-form="stepup"><input name="code" class="otp" inputmode="numeric" maxlength="6" autocomplete="one-time-code" placeholder="------" required>
      <button class="btn full" type="submit">Confirm</button><button class="btn ghost full" type="button" data-act="stepup-cancel">Cancel</button></form></div>`.s;
    forms.stepup = async (_f, d) => {
      try { await api('POST', '/auth/step-up/verify', { code: d.code }); modal.innerHTML = ''; resolve(); }
      catch (err) { toast(err.message); }
    };
    act['stepup-cancel'] = () => { modal.innerHTML = ''; reject(new Error('Cancelled')); };
  });
}
export async function withStepUp(fn) {
  try { return await fn(); }
  catch (e) { if (e.code !== 'step_up_required') throw e; await stepUp(); return fn(); }
}

export async function sha256File(file) {
  const buf = await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsArrayBuffer(file); });
  const h = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Searchable profession picker (930 professions, grouped). Fills a hidden input named "profession". */
export function pickerHtml(selected) {
  return html`<div data-picker><input type="search" data-pq placeholder="Search professions, skills or registration bodies" autocomplete="off">
    <div class="chips mt2" data-groups></div><div class="plist" data-plist></div>
    <input type="hidden" name="profession" value="${selected || ''}"><div class="muted small mt2" data-chosen>${selected ? 'Selected: ' + selected : 'Nothing selected yet'}</div></div>`;
}
export async function initPicker(root, onPick) {
  const q = root.querySelector('[data-pq]'), list = root.querySelector('[data-plist]'), hidden = root.querySelector('input[name=profession]'), chosen = root.querySelector('[data-chosen]');
  let group = '', timer;
  const groups = (await api('GET', '/professions/groups')).groups;
  const gbox = root.querySelector('[data-groups]');
  const drawGroups = () => { gbox.innerHTML = [['', 'All'], ...groups.map((g) => [g, g])].map(([g, l]) => `<button type="button" class="btn ghost sm" data-g="${esc(g)}">${esc(l)}${g === group ? ' ✓' : ''}</button>`).join(''); };
  const load = async () => {
    const r = await api('GET', `/professions?limit=60&q=${encodeURIComponent(q.value)}&group=${encodeURIComponent(group)}`);
    list.innerHTML = r.professions.length ? r.professions.map((p) => `<button type="button" data-p="${esc(p.name)}" data-reg="${p.registered ? 1 : 0}" data-body="${esc(p.body)}" class="${p.name === hidden.value ? 'on' : ''}"><span>${esc(p.name)}</span><span class="muted">${esc(p.body)}</span></button>`).join('') : '<div class="empty">No match. Try another word.</div>';
  };
  q.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(load, 200); });
  gbox.addEventListener('click', (e) => { const b = e.target.closest('[data-g]'); if (!b) return; group = b.dataset.g; drawGroups(); load(); });
  list.addEventListener('click', (e) => {
    const b = e.target.closest('[data-p]'); if (!b) return;
    hidden.value = b.dataset.p; chosen.textContent = 'Selected: ' + b.dataset.p; list.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
    onPick?.(b.dataset.p, { registered: b.dataset.reg === '1', body: b.dataset.body });
  });
  drawGroups(); await load();
}
