// Demo data so judges can tap around straight away:  npm run seed
// Creates a staff account, two verified businesses, four verified experts, open requests and offers.
import { config } from './config.js';
import { createContext } from './app.js';
import { uid, normPhone } from './util.js';
import * as onb from './onboarding.js';
import * as threads from './threads.js';
import { createHash } from 'node:crypto';

const ctx = createContext();
const now = () => ctx.clock.now();
const sha = (s) => createHash('sha256').update(s).digest('hex');
const luhnOk = (s) => { let t = 0, d = false; for (let i = s.length - 1; i >= 0; i--) { let x = +s[i]; if (d) { x *= 2; if (x > 9) x -= 9; } t += x; d = !d; } return t % 10 === 0; };
const saId = (seed) => { const b = '800101' + String(5000 + seed).padStart(4, '0') + '08'; for (let c = 0; c < 10; c++) if (luhnOk(b + c)) return b + c; };

function user(phone, role, name) {
  const p = normPhone(phone);
  let u = ctx.db.get('SELECT * FROM users WHERE phone=?', p);
  if (!u) { ctx.db.run('INSERT INTO users(id,phone,role,full_name,created_at) VALUES(?,?,?,?,?)', uid(), p, role, name || null, now()); u = ctx.db.get('SELECT * FROM users WHERE phone=?', p); }
  ctx.db.run('INSERT OR IGNORE INTO user_roles(user_id,role,created_at) VALUES(?,?,?)', u.id, role, now());   // a phone can hold several roles
  return u;
}
async function business(phone, company, cipc, n, idNumber) {
  const u = user(phone, 'entrepreneur');
  if (!onb.listBusinesses(ctx, u.id).some((b) => b.cipc_number === cipc)) {
    const row = onb.createBusiness(ctx, u, { company_name: company, cipc_number: cipc, director_id: idNumber ?? saId(n) });
    ctx.db.run(`UPDATE businesses SET status='verified', verified_at=? WHERE id=?`, now(), row.id);
    onb.signSds(ctx, u, { business_id: row.id, accept: true, answers: { services: 'Construction, renovations and supply', payment_terms: 'Through the platform within 2 days of confirming', dispute_process: 'Written complaint, reply within 7 days', no_licence_misuse: true } });
    await onb.linkBankAccount(ctx, u, { business_id: row.id, bank: 'FNB', holder_name: company, account_number: '62' + String(n).padStart(9, '0') });
  }
  return u;
}
async function expert(phone, name, tier, profession, reg, institution, n, idNumber) {
  const u = user(phone, 'professional', name);
  if (!onb.getProfessional(ctx, u.id)) {
    onb.createProfessional(ctx, u, { full_name: name, tier, profession, reg_number: reg, institution, proof_sha256: sha('proof' + phone), id_number: idNumber ?? saId(100 + n) });
    ctx.db.run(`UPDATE professionals SET status='verified', verified_at=?, rating=?, jobs=? WHERE user_id=?`, now(), 4.5 + (n % 5) / 10, 20 + n * 7, u.id);
    u.full_name = name;
    await onb.linkBankAccount(ctx, { ...ctx.db.get('SELECT * FROM users WHERE id=?', u.id), role: 'professional' }, { bank: 'Capitec', holder_name: name, account_number: '15' + String(n).padStart(9, '0') });
  }
  return u;
}

// One person, one phone, two businesses and a professional side: the same 13-digit ID throughout.
const NALEDI_ID = saId(77);
const e3 = await business('0841000001', 'Khumalo Catering (Pty) Ltd', '2017/111111/07', 11, NALEDI_ID);
await business('0841000001', 'Khumalo Logistics (Pty) Ltd', '2018/222222/07', 12, NALEDI_ID);
const p5 = await expert('0841000001', 'Naledi Khumalo', 1, 'Management Consultant', null, null, 5, NALEDI_ID);

const admin = config.adminPhone ? user(config.adminPhone, 'admin', 'ExpOnDemand Staff') : null;
const e1 = await business('0821000001', 'Mokoena Build (Pty) Ltd', '2019/123456/07', 1);
const e2 = await business('0821000002', 'Lerato Foods (Pty) Ltd', '2020/654321/07', 2);
const p1 = await expert('0831000001', 'Thandi Naidoo', 1, 'Commercial Lawyer', 'LPC-48210', null, 1);
const p2 = await expert('0831000002', 'Pieter van Wyk', 1, 'Management Consultant', null, null, 2);
const p3 = await expert('0831000003', 'Sipho Dube', 1, 'Food Safety Consultant', null, null, 3);
const p4 = await expert('0831000004', 'Lerato Dlamini', 3, 'Management Consultant', null, 'University of the Witwatersrand', 4);

const has = (owner, text) => ctx.db.get('SELECT id FROM threads WHERE owner_id=? AND description=?', owner, text);
const post = (u, body) => has(u.id, body.description) || threads.createThread(ctx, u, body);
const t1 = post(e1, { need_type: 'consultation', profession: 'Commercial Lawyer', description: 'Supplier agreement needs review before we sign on Friday', budget_min: 1000, budget_max: 1500, urgency: 'today' });
post(e1, { need_type: 'licensing', profession: 'Commercial Lawyer', description: 'Registered lawyer to oversee our contracts and sign off tenders', engagement: 'partnership', terms: { share_percent: 15, scope: 'Contract oversight and tender sign-off' } });
post(e2, { need_type: 'consultation', profession: 'Food Safety Consultant', description: 'HACCP plan for our new kitchen before the municipal inspection', budget_min: 2500, budget_max: 3500, urgency: 'this_week', positions: 2 });
post(e2, { need_type: 'consultation', profession: 'Management Consultant', description: 'Growth plan for a 10-person business: a two-hour session and a one-page plan', budget_min: 1500, budget_max: 2500, urgency: 'this_week' });
const tid = t1.id || t1;
for (const [p, body] of [[p1, { kind: 'interested', note: '12 years in commercial contracts. I can start in 2 hours.' }]]) { try { threads.submitOffer(ctx, p, tid, body); } catch { /* already offered */ } }

const code = config.devOtp || '(set DEMO_MODE=true for a fixed demo code)';
console.log(`\nDemo data ready. One-time code for every account: ${code}\n`);
console.table([
  ['Staff', config.adminPhone || '(set ADMIN_PHONE)', 'Review queue, approve affidavits and disputes'],
  ['Entrepreneur', '082 100 0001', 'Mokoena Build (verified, has requests and an offer)'],
  ['Entrepreneur', '082 100 0002', 'Lerato Foods (verified, hiring 2 food safety experts)'],
  ['Expert', '083 100 0001', 'Commercial Lawyer, Tier 1, LPC registered'],
  ['Expert', '083 100 0002', 'Management Consultant, qualification verified'],
  ['Expert', '083 100 0003', 'Food Safety Consultant'],
  ['Graduate', '083 100 0004', 'Management Consultant graduate (non-regulated work only)'],
  ['Both hats', '084 100 0001', 'Naledi: two businesses AND a Management Consultant, one phone, one ID'],
].map(([who, phone, note]) => ({ who, phone, note })));
