// The SMS and business-register adapters, tested against fake local servers that check the exact requests we send.
// (These do NOT call a live provider. See docs/INTEGRATIONS.md for the one-message live check.)
process.env.NODE_ENV = 'test'; process.env.ADMIN_PHONE = '0821110000';
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
const { createContext, createApp } = await import('../src/app.js');
const { openDb } = await import('../src/db.js');
const { config } = await import('../src/config.js');
const { twilioGateway, httpGateway, makeGateway } = await import('../src/sms.js');
const { diditRegistry, makeRegistry } = await import('../src/registry.js');

const closers = [];
after(() => closers.forEach((c) => c()));
function fake(handler) {
  return new Promise((resolve) => {
    const reqs = [];
    const s = http.createServer((req, res) => { let body = ''; req.on('data', (c) => (body += c)); req.on('end', () => { reqs.push({ method: req.method, url: req.url, headers: req.headers, body }); handler(res, body); }); });
    s.listen(0, () => { closers.push(() => s.close()); resolve({ reqs, base: `http://127.0.0.1:${s.address().port}` }); });
  });
}
const reply = (status, json) => (res) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(json || {})); };
const DEAD = 'http://127.0.0.1:9';   // nothing listens here

test('Twilio: sends the right request, reports failure without leaking secrets', async () => {
  const srv = await fake(reply(201, { sid: 'SM1' }));
  const g = twilioGateway({ sid: 'ACtest', token: 'secret', from: '+15005550006', base: srv.base });
  assert.deepEqual(await g.send('+27821234567', '123456 is your code'), { ok: true });
  const r = srv.reqs[0], form = new URLSearchParams(r.body);
  assert.equal(r.method, 'POST'); assert.equal(r.url, '/2010-04-01/Accounts/ACtest/Messages.json');
  assert.equal(r.headers.authorization, 'Basic ' + Buffer.from('ACtest:secret').toString('base64'));
  assert.deepEqual([form.get('To'), form.get('From'), form.get('Body')], ['+27821234567', '+15005550006', '123456 is your code']);
  const ms = twilioGateway({ sid: 'ACtest', token: 'secret', messagingServiceSid: 'MGabc', base: srv.base });
  await ms.send('+27821234567', 'x'); const f2 = new URLSearchParams(srv.reqs[1].body);
  assert.equal(f2.get('MessagingServiceSid'), 'MGabc'); assert.equal(f2.get('From'), null);
  const bad = await fake(reply(400, { message: 'invalid' }));
  assert.deepEqual(await twilioGateway({ sid: 'AC', token: 't', from: '+1', base: bad.base }).send('+27821234567', 'x'), { ok: false, why: 'http_400' });
  const down = await twilioGateway({ sid: 'AC', token: 't', from: '+1', base: DEAD }).send('+27821234567', 'x');
  assert.deepEqual(down, { ok: false, why: 'network' });
  assert.throws(() => twilioGateway({ sid: 'AC' }), /TWILIO_AUTH_TOKEN/);
});

test('generic HTTP gateway: fills the template and keeps the JSON valid even with quotes in the text', async () => {
  const srv = await fake(reply(200, { ok: true }));
  const g = httpGateway({ url: srv.base + '/send', headers: { authorization: 'Bearer k123' }, body: '{"to":"{{to_digits}}","plus":"{{to}}","content":"{{text}}"}' });
  const text = 'He said "hi"\nand left';
  assert.deepEqual(await g.send('+27821234567', text), { ok: true });
  const sent = JSON.parse(srv.reqs[0].body);
  assert.deepEqual([sent.to, sent.plus, sent.content], ['27821234567', '+27821234567', text]);
  assert.equal(srv.reqs[0].headers.authorization, 'Bearer k123');
  assert.throws(() => httpGateway({ url: 'x' }), /SMS_HTTP_BODY/);
});

test('settings: gateways and registries are chosen from environment variables, bad settings fail loudly', () => {
  assert.equal(makeGateway({}).name, 'outbox');
  assert.equal(makeGateway({ SMS_PROVIDER: 'twilio', TWILIO_ACCOUNT_SID: 'AC', TWILIO_AUTH_TOKEN: 't', TWILIO_FROM: '+1' }).name, 'twilio');
  assert.throws(() => makeGateway({ SMS_PROVIDER: 'carrier-pigeon' }), /Unknown SMS_PROVIDER/);
  assert.equal(makeRegistry({}).enabled, false);
  assert.throws(() => makeRegistry({ REGISTRY_PROVIDER: 'didit' }), /DIDIT_API_KEY/);
  assert.equal(makeRegistry({ REGISTRY_PROVIDER: 'didit', DIDIT_API_KEY: 'k', REGISTRY_AUTO_APPROVE: 'true' }).autoApprove, true);
});

test('Didit register check: match, no match, provider error, network error', async () => {
  const srv = await fake(reply(200, { request_id: 'req_1', status: 'Approved', match_type: 'full_match', validations: [] }));
  const reg = diditRegistry({ apiKey: 'key-1', base: srv.base });
  assert.deepEqual(await reg.check({ cipc_number: '2019/123456/07' }), { status: 'match', request_id: 'req_1' });
  assert.equal(srv.reqs[0].url, '/v3/database-validation/'); assert.equal(srv.reqs[0].headers['x-api-key'], 'key-1');
  assert.ok(srv.reqs[0].body.includes('zaf_company_registry') && srv.reqs[0].body.includes('2019/123456/07') && srv.reqs[0].body.includes('ZAF'));
  const no = await fake(reply(200, { status: 'Declined', match_type: 'no_match' }));
  assert.equal((await diditRegistry({ apiKey: 'k', base: no.base }).check({ cipc_number: '2019/123456/07' })).status, 'no_match');
  const err = await fake(reply(500, {}));
  assert.deepEqual(await diditRegistry({ apiKey: 'k', base: err.base }).check({ cipc_number: '2019/123456/07' }), { status: 'error', http: 500 });
  assert.equal((await diditRegistry({ apiKey: 'k', base: DEAD }).check({ cipc_number: '2019/123456/07' })).status, 'error');
});

async function boot(opts) {
  const ctx = createContext({ db: openDb(':memory:'), ...opts });
  const server = createApp(ctx).listen(0); closers.push(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const api = async (method, path, body, token) => { const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, body: await r.json().catch(() => null) }; };
  return { ctx, api };
}

test('login codes: the real text is sent, a failed send is reported honestly, and a daily cap stops SMS-pumping bills', async () => {
  const sent = [];
  const good = await boot({ sms: { name: 'fake', send: async (to, text) => { sent.push({ to, text }); return { ok: true }; } } });
  assert.equal((await good.api('POST', '/auth/request-otp', { phone: '082 123 4567' })).status, 200);
  assert.equal(sent[0].to, '+27821234567'); assert.match(sent[0].text, /^\d{6} is your ExpOnDemand code/); assert.match(sent[0].text, /Never share/);
  const broken = await boot({ sms: { name: 'fake', send: async () => ({ ok: false, why: 'http_500' }) } });
  const r = await broken.api('POST', '/auth/request-otp', { phone: '0821234567' });
  assert.equal(r.status, 502); assert.equal(r.body.code, 'sms_failed'); assert.equal(r.body.sent, undefined);
  const capped = await boot({ sms: { name: 'fake', send: async () => ({ ok: true }) } });
  const old = config.smsDailyCap; config.smsDailyCap = 2;
  try {
    assert.equal((await capped.api('POST', '/auth/request-otp', { phone: '0821000001' })).status, 200);
    assert.equal((await capped.api('POST', '/auth/request-otp', { phone: '0821000002' })).status, 200);
    assert.equal((await capped.api('POST', '/auth/request-otp', { phone: '0821000003' })).body.code, 'sms_budget');
  } finally { config.smsDailyCap = old; }
});

test('register check: helps staff, never blocks sign-up, can auto-approve only if you turn that on', async () => {
  const luhn = (s) => { let t = 0, d = false; for (let i = s.length - 1; i >= 0; i--) { let x = +s[i]; if (d) { x *= 2; if (x > 9) x -= 9; } t += x; d = !d; } return t % 10 === 0; };
  const id = (() => { for (let c = 0; c < 10; c++) if (luhn('800101500908' + c)) return '800101500908' + c; })();
  const run = async (registry, cipc, phone) => {
    const app = await boot({ registry });
    await app.api('POST', '/auth/request-otp', { phone }); const tok = (await app.api('POST', '/auth/verify-otp', { phone, code: '123456', role: 'entrepreneur' })).body.token;
    const b = await app.api('POST', '/business', { company_name: 'Check Co (Pty) Ltd', cipc_number: cipc, director_id: id }, tok);
    await app.api('POST', '/auth/request-otp', { phone: '0821110000' }); const adm = (await app.api('POST', '/auth/verify-otp', { phone: '0821110000', code: '123456' })).body.token;
    return { b, queue: (await app.api('GET', '/admin/queue', null, adm)).body.businesses };
  };
  const manual = await run({ name: 'fake', enabled: true, autoApprove: false, check: async () => ({ status: 'match' }) }, '2019/123456/07', '0821000011');
  assert.equal(manual.b.status, 201); assert.equal(manual.b.body.registry_check, 'match'); assert.equal(manual.b.body.status, 'pending');
  assert.equal(manual.b.body.director_id_hash, undefined); assert.equal(manual.queue[0].registry_check, 'match');   // staff see it, and still decide
  const auto = await run({ name: 'fake', enabled: true, autoApprove: true, check: async () => ({ status: 'match' }) }, '2019/123457/07', '0821000012');
  assert.equal(auto.b.body.status, 'verified');
  const noMatch = await run({ name: 'fake', enabled: true, autoApprove: true, check: async () => ({ status: 'no_match' }) }, '2019/123458/07', '0821000013');
  assert.equal(noMatch.b.body.status, 'pending'); assert.equal(noMatch.b.body.registry_check, 'no_match');   // auto-approve never fires without a match
  const down = await run({ name: 'fake', enabled: true, autoApprove: true, check: async () => ({ status: 'error' }) }, '2019/123459/07', '0821000014');
  assert.equal(down.b.status, 201); assert.equal(down.b.body.registry_check, 'error');   // an outage never stops someone registering
});
