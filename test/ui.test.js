// End-to-end: drives the REAL web client (jsdom) against the REAL server, the way a person would tap through it.
process.env.NODE_ENV = 'test'; process.env.ADMIN_PHONE = '0821110000';
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { webcrypto } from 'node:crypto';
let JSDOM, esbuild;
try { ({ JSDOM } = await import('jsdom')); esbuild = await import('esbuild'); } catch { console.log('jsdom/esbuild not installed: skipping UI tests'); }
const { createContext, createApp } = await import('../src/app.js');
const { openDb } = await import('../src/db.js');

const skip = !JSDOM;
const ctx = createContext({ db: openDb(':memory:') });
const server = createApp(ctx).listen(0);
const base = `http://127.0.0.1:${server.address().port}`;
after(() => server.close());
const bundle = skip ? '' : esbuild.buildSync({ entryPoints: ['public/js/main.js'], bundle: true, format: 'iife', write: false }).outputFiles[0].text;
const shell = fs.readFileSync('public/index.html', 'utf8').replace(/<script[^>]*><\/script>/, '');
const luhnOk = (s) => { let t = 0, d = false; for (let i = s.length - 1; i >= 0; i--) { let x = +s[i]; if (d) { x *= 2; if (x > 9) x -= 9; } t += x; d = !d; } return t % 10 === 0; };
const saId = (seed) => { const b = '800101' + String(5000 + seed).padStart(4, '0') + '08'; for (let c = 0; c < 10; c++) if (luhnOk(b + c)) return b + c; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function apiAs(method, path, body, token) {
  const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => null) };
}
async function adminToken() {
  await apiAs('POST', '/auth/request-otp', { phone: '0821110000' });
  return (await apiAs('POST', '/auth/verify-otp', { phone: '0821110000', code: '123456' })).body.token;
}

function browser(token) {
  const dom = new JSDOM(shell, { url: base + '/', runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window; let inflight = 0;
  w.fetch = async (u, o) => { inflight++; try { return await fetch(new URL(u, base), o); } finally { inflight--; } };
  Object.defineProperty(w, 'crypto', { value: webcrypto }); w.scrollTo = () => {}; w.prompt = () => 'Terms do not match what we agreed';
  if (token) w.localStorage.setItem('eod_token', token);   // a device that is already signed in
  w.eval(bundle);
  const $ = (s) => w.document.querySelector(s), $$ = (s) => [...w.document.querySelectorAll(s)];
  const b = {
    w, $, $$,
    async settle() { for (let i = 0, quiet = 0; i < 200 && quiet < 3; i++) { await sleep(15); quiet = inflight === 0 ? quiet + 1 : 0; } await sleep(10); },
    async goto(path) { w.location.hash = '#' + path; await b.settle(); },
    async click(sel) { const el = typeof sel === 'string' ? $(sel) : sel; assert.ok(el, `missing ${sel}`); el.dispatchEvent(new w.MouseEvent('click', { bubbles: true, cancelable: true })); await b.settle(); },
    fill(sel, v) { const el = $(sel); assert.ok(el, `missing ${sel}`); el.value = v; el.dispatchEvent(new w.Event('input', { bubbles: true })); el.dispatchEvent(new w.Event('change', { bubbles: true })); },
    tick(sel, on = true) { const el = $(sel); assert.ok(el, `missing ${sel}`); el.checked = on; },
    file(sel) { const el = $(sel); assert.ok(el, `missing ${sel}`); Object.defineProperty(el, 'files', { value: [new w.File(['scan-' + Math.random()], 'scan.pdf', { type: 'application/pdf' })], configurable: true }); },
    async submit(sel) { const f = $(sel); assert.ok(f, `missing ${sel}`); f.dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true })); await b.settle(); },
    text() { return w.document.getElementById('app').textContent.replace(/\s+/g, ' ').trim(); },
    has(t) { return b.text().includes(t); },
    async signUp(role, phone) {
      await b.goto('/welcome'); await b.click('[data-act=flow-mode][data-v=up]'); await b.click(`[data-act=flow-role][data-v=${role}]`); await b.click('[data-act=welcome-next]');
      b.fill('input[name=phone]', phone); await b.submit('form[data-form=phone]');
      assert.ok(b.has('We sent a 6-digit code'), 'code screen'); b.fill('input[name=code]', '123456'); await b.submit('form[data-form=code]');
    },
    toast: () => w.document.getElementById('toast').textContent,
  };
  return b;
}

test('UI: whole journey, consultation through payment and payout', { skip }, async () => {
  const admin = await adminToken();
  const E = browser(), P = browser();
  // --- entrepreneur signs up and must clear the gate
  await E.signUp('entrepreneur', '0821000101');
  assert.ok(E.has('Step 1: register your business')); assert.ok(E.$('[data-act=go][data-to="/new"]').disabled, 'cannot post yet');
  await E.goto('/onboard/business');
  E.fill('input[name=company_name]', 'Mokoena Build (Pty) Ltd'); E.fill('input[name=cipc_number]', '2019/123456/07'); E.fill('input[name=director_id]', '8001015009087'); await E.submit('form[data-form=business]');
  assert.ok(E.has('Staff are verifying this business'));
  const queue = (await apiAs('GET', '/admin/queue', null, admin)).body;
  await apiAs('POST', `/admin/businesses/${queue.businesses[0].id}/review`, { approve: true }, admin);
  await E.click('[data-act=refresh]'); assert.ok(E.has('Sign the Service Delivery Standards'));
  await E.goto('/onboard/sds');
  E.fill('textarea[name=services]', 'Construction and renovations'); E.fill('input[name=payment_terms]', 'Within 2 days of confirmation'); E.fill('input[name=dispute_process]', 'Written complaint within 7 days');
  // the Service Delivery Standards need both boxes ticked: an unticked form is refused by the server
  await E.submit('form[data-form=sds]'); assert.ok(E.has('Service Delivery Standards'), 'still on the form after a refusal');
  E.tick('input[name=no_licence_misuse]'); E.tick('input[name=accept]');
  await E.submit('form[data-form=sds]'); assert.equal(E.$('[data-act=go][data-to="/new"]').disabled, false, 'can post now');

  // --- professional signs up, is verified, sets up payouts
  await P.signUp('professional', '0831000101');
  assert.ok(P.has('Complete your profile'));
  await P.goto('/onboard/pro');
  P.fill('input[name=full_name]', 'Thandi Expert'); P.fill('input[name=id_number]', saId(31)); P.fill('input[data-pq]', 'commercial law'); await P.settle(); await sleep(300); await P.settle();
  await P.click('[data-p="Commercial Lawyer"]'); assert.ok(P.has('Selected: Commercial Lawyer'));
  P.fill('input[name=reg_number]', 'LPC4821'); P.file('input[name=proof]'); await P.submit('form[data-form=profile]');
  assert.ok(P.has('Staff are checking your credentials'));
  const q2 = (await apiAs('GET', '/admin/queue', null, admin)).body;
  await apiAs('POST', `/admin/professionals/${q2.professionals[0].user_id}/review`, { approve: true }, admin);
  await P.click('[data-act=refresh]'); assert.ok(P.has('Find jobs'));
  await P.goto('/payout'); P.fill('input[name=holder_name]', 'Thandi Expert'); P.fill('input[name=account_number]', '62000000123'); await P.submit('form[data-form=payout]');
  assert.ok(P.has('Name matches. Verified.'), 'payout account verified');

  // --- AI intake, then post a consultation
  await E.goto('/new');
  E.fill('#intake', 'I need a lawyer to review my supplier contract before I sign on Friday'); await E.click('[data-act=suggest]');
  assert.ok(E.has('Suggested:')); await E.click('[data-act=apply-suggest]');
  assert.ok(E.has('Selected:')); E.fill('input[name=budget_min]', '1000'); E.fill('input[name=budget_max]', '1500');
  // the suggestion may pick a similar profession; make sure it is the one our expert holds
  E.fill('input[data-pq]', 'Commercial Lawyer'); await sleep(300); await E.settle(); await E.click('[data-p="Commercial Lawyer"]');
  await E.submit('form[data-form=newthread]');
  assert.ok(E.w.location.hash.startsWith('#/request/'), 'went to the request page'); assert.ok(E.has('Waiting for experts to respond'));
  assert.ok(E.toast().includes('alerted'));

  // --- professional finds the job by searching and responds
  await P.goto('/jobs'); assert.ok(P.has('1 job for your expertise'));
  P.fill('#jq', 'zzz nothing'); assert.ok(P.has('0 jobs')); P.fill('#jq', 'supplier'); assert.ok(P.has('1 job'));
  await P.click('[data-act=go][data-to^="/job/"]');
  P.fill('textarea[name=note]', '12 years in this field'); await P.submit('form[data-form=offer]');
  assert.ok(P.toast().includes('R1275') === false); assert.ok(/You would receive R1[ ,\s]?275/.test(P.toast()), P.toast());   // R1,500 less the 15% fee
  assert.ok(P.has('You were picked') === false); assert.ok(P.has('pending'));

  // --- entrepreneur sees the offer and picks
  await E.goto('/requests'); await E.click('[data-act=go][data-to^="/request/"]');
  assert.ok(E.has('Thandi Expert') && E.has('LPC LPC4821'), E.text());
  await E.click('[data-act=pick]');
  assert.ok(E.w.location.hash.startsWith('#/deal/')); assert.ok(E.has('Pay into secure hold'));
  await E.submit('form[data-form=pay]'); assert.ok(E.has('Work in progress') && E.has('Held safely'));

  // --- expert delivers, entrepreneur releases, split shown, payout paid
  await P.goto('/deals'); await P.click('[data-act=go][data-to^="/deal/"]'); assert.ok(P.has('Work in progress'));
  await P.click('[data-act=deliver]'); assert.ok(P.has('Marked delivered'));
  await E.goto('/deals'); await E.click('[data-act=go][data-to^="/deal/"]'); await E.click('[data-act=confirmdeal]');
  assert.ok(E.has('Completed. The expert received R1 275') || /received R1[ ,\s]?275/.test(E.text()), E.text());
  await P.goto('/deals'); await P.click('[data-act=go][data-to^="/deal/"]'); assert.ok(P.has('Your payout is paid'), P.text());
  // removing a finished deal only changes your own list
  await E.click('[data-act=removedeal]'); assert.ok(E.has('No deals yet')); await P.goto('/deals'); assert.ok(!P.has('No deals yet'));
});

test('UI: Back goes to the parent page, the signed-in device is not asked for a code again', { skip }, async () => {
  const B = browser();
  await B.signUp('entrepreneur', '0821000202');
  await B.goto('/account'); await B.click('[data-act=back]'); assert.ok(B.w.location.hash === '#/menu');
  await B.goto('/contacts'); await B.click('[data-act=back]'); assert.ok(B.has('Hello') || B.has('Step 1'));
  assert.ok(B.$('[data-act=menu]') === null, 'no Menu button cluttering the top bar');
  const token = B.w.localStorage.getItem('eod_token'); assert.ok(token);
  // a second visit with the same device storage goes straight to the menu: no phone, no code
  const B2 = browser(token);   // same device storage: straight to the menu, no phone number and no code
  await B2.goto('/menu'); assert.ok(B2.has('Hello') || B2.has('Step 1'), B2.text()); assert.ok(!B2.has('Enter the code'));
  await B.goto('/account'); await B.click('[data-act=signout]'); assert.ok(B.has('Welcome to ExpOnDemand'));
  assert.equal((await apiAs('GET', '/me', null, token)).status, 401, 'signing out revokes the session');
});

test('UI: licensing, swear, staff verify, read each other, formalised', { skip }, async () => {
  const admin = await adminToken(), E = browser(), P = browser(), A = browser(admin);
  const mkBiz = async (b, phone, n) => { await b.signUp('entrepreneur', phone); const r = await apiAs('POST', '/auth/request-otp', { phone }); void r;
    await b.goto('/onboard/business'); b.fill('input[name=company_name]', `Acme ${n} (Pty) Ltd`); b.fill('input[name=cipc_number]', `2021/20000${n}/07`); b.fill('input[name=director_id]', saId(21)); await b.submit('form[data-form=business]');
    const q = (await apiAs('GET', '/admin/queue', null, admin)).body.businesses.find((x) => x.company_name === `Acme ${n} (Pty) Ltd`); await apiAs('POST', `/admin/businesses/${q.id}/review`, { approve: true }, admin);
    await b.goto('/onboard/sds'); b.fill('textarea[name=services]', 'Construction and renovations'); b.fill('input[name=payment_terms]', 'Within 2 days'); b.fill('input[name=dispute_process]', 'Written complaint'); b.tick('input[name=no_licence_misuse]'); b.tick('input[name=accept]'); await b.submit('form[data-form=sds]'); };
  // the director ID in the fixture must be valid: reuse a known-good one
  await mkBiz(E, '0821000303', 1);
  await P.signUp('professional', '0831000303'); await P.goto('/onboard/pro');
  P.fill('input[name=full_name]', 'Sipho Dube'); P.fill('input[name=id_number]', saId(32)); P.fill('input[data-pq]', 'Patent'); await sleep(300); await P.settle(); await P.click('[data-p="Patent Attorney"]');
  P.fill('input[name=reg_number]', 'CIPC-7788'); P.file('input[name=proof]'); await P.submit('form[data-form=profile]');
  const pq = (await apiAs('GET', '/admin/queue', null, admin)).body.professionals.find((p) => p.full_name === 'Sipho Dube'); await apiAs('POST', `/admin/professionals/${pq.user_id}/review`, { approve: true }, admin);

  await E.goto('/new'); await E.click('[data-act=need][data-v=licensing]');
  E.fill('input[data-pq]', 'Patent Attorney'); await sleep(300); await E.settle(); await E.click('[data-p="Patent Attorney"]');
  E.fill('textarea[name=description]', 'Registered patent attorney to front our filing'); E.fill('input[name=share_percent]', '20'); E.fill('input[name=scope]', 'Filing oversight'); await E.submit('form[data-form=newthread]');
  assert.ok(E.has('Registered only'), E.text());
  await P.goto('/jobs'); await P.click('[data-act=go][data-to^="/job/"]'); await P.submit('form[data-form=offer]');
  await E.goto('/requests'); await E.click('[data-act=go][data-to^="/request/"]'); await E.click('[data-act=pick]');
  assert.ok(E.has('Agree the terms'));
  await E.click('[data-act=lockterms]'); assert.ok(E.has('Waiting for the other party'));
  await P.goto('/deals'); await P.click('[data-act=go][data-to^="/deal/"]'); await P.click('[data-act=lockterms]'); assert.ok(P.has('Swear your affidavit') && P.has('not lending my registration'));
  for (const b of [P, E]) { if (b === E) { await E.goto('/deals'); await E.click('[data-act=go][data-to^="/deal/"]'); }
    b.file('input[name=scan]'); b.fill('input[name=commissioner_name]', 'Sgt M. Khumalo'); b.fill('input[name=commissioner_station]', 'Rosebank SAPS'); b.fill('input[name=commissioned_on]', '2026-10-15'); await b.submit('form[data-form=affidavit]'); assert.ok(b.has('Staff are checking')); }
  // staff approve both affidavits through the real admin screen
  await A.goto('/admin'); assert.ok(A.has('Affidavits (2)'), A.text());
  await A.click('[data-act=review][data-kind=affidavits][data-ok="1"]'); await A.click('[data-act=review][data-kind=affidavits][data-ok="1"]'); assert.ok(A.has('Affidavits (0)'));
  await P.goto('/deals'); await P.click('[data-act=go][data-to^="/deal/"]'); assert.ok(P.has('Read their affidavit'));
  await P.click('[data-act=viewaff]'); assert.ok(P.has('Hidden for privacy') && P.has('Viewed by') === false || P.has('Hidden for privacy'));
  assert.ok(P.has('CIPC') && P.has('Acme 1 (Pty) Ltd'));
  await P.click('[data-act=affconfirm]'); assert.ok(P.has('You confirmed'));
  await E.goto('/deals'); await E.click('[data-act=go][data-to^="/deal/"]'); await E.click('[data-act=viewaff]'); assert.ok(E.has('Sipho Dube'));
  await E.click('[data-act=affconfirm]'); assert.ok(E.has('Formalised. Both affidavits are verified and confirmed'), E.text());
});

test('UI: one phone number, two businesses, both hats, switching without a new code', { skip }, async () => {
  const admin = await adminToken(), B = browser(), id = saId(41);
  await B.signUp('entrepreneur', '0821000404');
  const addBiz = async (name, cipc, idn) => { await B.goto('/onboard/business'); B.fill('input[name=company_name]', name); B.fill('input[name=cipc_number]', cipc); B.fill('input[name=director_id]', idn); await B.submit('form[data-form=business]'); };
  await addBiz('Alpha (Pty) Ltd', '2021/300001/07', id);
  await addBiz('Beta (Pty) Ltd', '2021/300002/07', id);                       // same person: allowed
  assert.ok(B.has('Alpha (Pty) Ltd') && B.has('Beta (Pty) Ltd'), B.text());
  await addBiz('Gamma (Pty) Ltd', '2021/300003/07', saId(42));                 // a different person's ID: refused
  assert.ok(B.toast().includes('different person'), B.toast()); assert.ok(B.has('Register your business'));
  const q = (await apiAs('GET', '/admin/queue', null, admin)).body.businesses.filter((b) => /^(Alpha|Beta)/.test(b.company_name));
  for (const b of q) await apiAs('POST', `/admin/businesses/${b.id}/review`, { approve: true }, admin);
  await B.goto('/menu');
  assert.equal(B.$$('[data-act=go][data-to^="/onboard/sds"]').length, 2, 'each business signs its own standards');
  for (let k = 0; k < 2; k++) {
    await B.click('[data-act=go][data-to^="/onboard/sds"]');
    B.fill('textarea[name=services]', 'Construction and renovations'); B.fill('input[name=payment_terms]', 'Within 2 days'); B.fill('input[name=dispute_process]', 'Written complaint'); B.tick('input[name=no_licence_misuse]'); B.tick('input[name=accept]');
    await B.submit('form[data-form=sds]');
  }
  assert.equal(B.$('[data-act=go][data-to="/new"]').disabled, false);
  await B.goto('/new'); assert.ok(B.$('select[name=business_id]') && B.$$('select[name=business_id] option').length === 2, 'asks which business the request is for');

  // add the professional hat: must be the same person
  await B.goto('/menu'); await B.click('[data-act=go][data-to="/add-role/professional"]');
  B.fill('input[name=id_number]', saId(43)); await B.submit('form[data-form=addrole]'); assert.ok(B.toast().includes('different person'), B.toast());
  B.fill('input[name=id_number]', id); await B.submit('form[data-form=addrole]');
  assert.ok(B.w.location.hash.startsWith('#/onboard/pro'), B.w.location.hash);
  B.fill('input[name=full_name]', 'Dual Person'); B.fill('input[name=id_number]', id); B.fill('input[data-pq]', 'commercial law'); await sleep(300); await B.settle();
  await B.click('[data-p="Commercial Lawyer"]'); B.fill('input[name=reg_number]', 'LPC-0041'); B.file('input[name=proof]'); await B.submit('form[data-form=profile]');
  const pq = (await apiAs('GET', '/admin/queue', null, admin)).body.professionals.find((p) => p.full_name === 'Dual Person'); await apiAs('POST', `/admin/professionals/${pq.user_id}/review`, { approve: true }, admin);
  await B.goto('/menu'); assert.ok(B.has('Switch to my business side'), B.text());
  await B.click('[data-act=switchrole][data-role=entrepreneur]'); assert.ok(B.has('Alpha (Pty) Ltd') && B.has('Switch to my professional side'));
  await B.click('[data-act=switchrole][data-role=professional]'); assert.ok(B.has('Find jobs'));
  assert.ok(!B.has('Enter the code'), 'no new code was needed to switch');
});
