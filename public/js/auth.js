import { route, html, page, act, forms, api, S, setSession, loadMe, go, toast, renderRoute, R, when, esc, withStepUp } from './core.js';

const getFlow = () => JSON.parse(sessionStorage.getItem('eod_flow') || '{"mode":"in","role":"entrepreneur"}');
const setFlow = (p) => sessionStorage.setItem('eod_flow', JSON.stringify({ ...getFlow(), ...p }));

route('/welcome', { auth: false }, () => {
  if (S.token) return go('/menu');
  const f = getFlow();
  return page('Welcome to ExpOnDemand', html`
    <div class="seg"><button data-act="flow-mode" data-v="in" class="${f.mode === 'in' ? 'on' : ''}">Sign in</button><button data-act="flow-mode" data-v="up" class="${f.mode === 'up' ? 'on' : ''}">Create account</button></div>
    <label>I am a</label>
    <button class="tile ${f.role === 'entrepreneur' ? 'on' : ''}" data-act="flow-role" data-v="entrepreneur"><b>Entrepreneur</b><span class="muted small">A registered business that needs an expert</span></button>
    <button class="tile ${f.role === 'professional' ? 'on' : ''}" data-act="flow-role" data-v="professional"><b>Professional</b><span class="muted small">Registered expert, candidate or graduate</span></button>
    <button class="btn full" data-act="welcome-next">Continue as ${f.role === 'entrepreneur' ? 'an entrepreneur' : 'a professional'}</button>
    <p class="note">Staff sign in with the same screen using their staff number.</p>`, { back: null, sub: 'Expert on demand, when you need them.' });
});
act['flow-mode'] = (el) => { setFlow({ mode: el.dataset.v }); renderRoute(); };
act['flow-role'] = (el) => { setFlow({ role: el.dataset.v }); renderRoute(); };
act['welcome-next'] = () => go('/phone');

route('/phone', { auth: false }, () => {
  const f = getFlow();
  return page(f.mode === 'in' ? 'Sign in' : 'Create your account', html`
    <p class="sub">As ${f.role === 'entrepreneur' ? 'an entrepreneur' : 'a professional'}. <button class="btn ghost sm" data-act="back" data-to="/welcome">Change</button></p>
    <form data-form="phone"><label for="ph">Mobile number</label><input id="ph" name="phone" type="tel" inputmode="tel" autocomplete="tel" placeholder="082 123 4567" required value="${f.phone || ''}">
    <button class="btn full" type="submit">Send code</button></form>
    <p class="note">We text you a 6-digit code. You will stay signed in on this device, so you will not need a code for every request.</p>`, { back: '/welcome' });
});
forms.phone = async (_f, d) => {
  const r = await api('POST', '/auth/request-otp', { phone: d.phone });
  setFlow({ phone: d.phone, hint: r.dev_hint || '' });
  go('/code');
};

let cooldown = 0;
route('/code', { auth: false }, () => {
  const f = getFlow();
  if (!f.phone) return go('/phone');
  return page('Enter the code', html`
    <p class="sub">We sent a 6-digit code to ${f.phone}.</p>
    <form data-form="code"><input name="code" class="otp" inputmode="numeric" maxlength="6" autocomplete="one-time-code" placeholder="------" required autofocus>
    <button class="btn full" type="submit">Verify</button></form>
    ${f.hint ? html`<p class="note">${f.hint}</p>` : ''}
    <div class="row mt"><button class="btn ghost sm" data-act="resend" data-resend>Resend code</button><button class="btn ghost sm" data-act="back" data-to="/phone">Change number</button></div>
    <p class="note">Codes expire after 5 minutes. After 3 wrong tries the number is locked for a few minutes.</p>`, { back: '/phone' });
});
forms.code = async (_f, d) => {
  const f = getFlow();
  try {
    const r = await api('POST', '/auth/verify-otp', { phone: f.phone, code: d.code, role: f.mode === 'up' ? f.role : undefined, mode: f.mode === 'up' ? 'signup' : 'signin' });
    setSession(r.token); await loadMe(); sessionStorage.removeItem('eod_flow');
    if (r.missing_role) { toast(`This number is registered as ${r.roles.join(' and ')}. To use it as ${r.missing_role} too, confirm your ID number.`); return go('/add-role/' + r.missing_role); }
    toast(r.created ? 'Account created. Welcome!' : 'Signed in');
    go('/menu');
  } catch (e) {
    if (e.code === 'role_required' || e.code === 'no_account') { toast('No account for that number yet. Create an account first.'); setFlow({ mode: 'up' }); return go('/welcome'); }
    throw e;
  }
};
act.resend = async (el) => {
  if (cooldown > Date.now()) return toast('Wait a moment before asking again');
  const r = await api('POST', '/auth/request-otp', { phone: getFlow().phone });
  cooldown = Date.now() + 30000; toast('New code sent'); if (r.dev_hint) setFlow({ hint: r.dev_hint });
};

act.signout = async () => {
  try { await api('POST', '/auth/logout'); } catch { /* already signed out */ }
  setSession(null); sessionStorage.removeItem('eod_flow'); go('/welcome');
};

/* One phone number, one person: a second role (or a first business) is added by confirming the same 13-digit ID. */
route('/add-role/:role', {}, (role) => page(role === 'professional' ? 'Add your professional side' : 'Add a business', html`
  <p class="sub">A phone number is for one person. To add this to your account, confirm your 13-digit South African ID number. It must be the same person who is already registered here.</p>
  <form data-form="addrole" data-role="${role}"><label>Your ID number</label><input name="id_number" inputmode="numeric" maxlength="13" required placeholder="13 digits" autocomplete="off">
  <button class="btn full" type="submit">Continue</button></form><p class="note">We keep only a scrambled copy and the last 4 digits. A different person's ID is refused.</p>`));
forms.addrole = async (f, d) => {
  await withStepUp(() => api('POST', '/me/roles', { role: f.dataset.role, id_number: d.id_number }));
  S.me = null; toast('Added. Now complete your details.'); go(f.dataset.role === 'professional' ? '/onboard/pro' : '/onboard/business');
};
