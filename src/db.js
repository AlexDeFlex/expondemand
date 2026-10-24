import { DatabaseSync } from 'node:sqlite';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users(
  id TEXT PRIMARY KEY, phone TEXT UNIQUE NOT NULL, role TEXT NOT NULL CHECK(role IN('entrepreneur','professional','admin')),
  full_name TEXT, created_at INTEGER NOT NULL, erased_at INTEGER, identity_hash TEXT, identity_last4 TEXT);
CREATE TABLE IF NOT EXISTS user_roles(
  user_id TEXT NOT NULL REFERENCES users(id), role TEXT NOT NULL CHECK(role IN('entrepreneur','professional','admin')), created_at INTEGER NOT NULL,
  PRIMARY KEY(user_id, role));
CREATE TABLE IF NOT EXISTS sessions(
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
  last_otp_at INTEGER NOT NULL, revoked_at INTEGER, active_role TEXT);
CREATE TABLE IF NOT EXISTS otps(
  phone TEXT PRIMARY KEY, code_hash TEXT NOT NULL, expires_at INTEGER NOT NULL, attempts INTEGER DEFAULT 0,
  locked_until INTEGER DEFAULT 0, window_start INTEGER DEFAULT 0, sent_count INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS businesses(
  id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id), company_name TEXT NOT NULL,
  cipc_number TEXT UNIQUE NOT NULL, director_id_last4 TEXT NOT NULL, director_id_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN('pending','verified','rejected')),
  review_note TEXT, registry_check TEXT, created_at INTEGER NOT NULL, verified_at INTEGER);
CREATE TABLE IF NOT EXISTS sds(
  id TEXT PRIMARY KEY, business_id TEXT NOT NULL REFERENCES businesses(id), version TEXT NOT NULL,
  answers TEXT NOT NULL, signed_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS professionals(
  user_id TEXT PRIMARY KEY REFERENCES users(id), tier INTEGER NOT NULL CHECK(tier IN(1,2,3)), profession TEXT NOT NULL,
  body TEXT, reg_number TEXT, institution TEXT, proof_sha256 TEXT, supervisor_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN('pending','verified','rejected')), review_note TEXT,
  available INTEGER NOT NULL DEFAULT 1, rating REAL NOT NULL DEFAULT 0, jobs INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL, verified_at INTEGER);
CREATE TABLE IF NOT EXISTS bank_accounts(
  id TEXT PRIMARY KEY, owner_type TEXT NOT NULL CHECK(owner_type IN('business','professional')), owner_id TEXT NOT NULL,
  bank TEXT NOT NULL, account_type TEXT, last4 TEXT NOT NULL, token TEXT NOT NULL, holder_name TEXT NOT NULL,
  name_match INTEGER NOT NULL, status TEXT NOT NULL CHECK(status IN('verified','manual_review','replaced')),
  hold_until INTEGER DEFAULT 0, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS threads(
  id TEXT PRIMARY KEY, business_id TEXT NOT NULL REFERENCES businesses(id), owner_id TEXT NOT NULL,
  need_type TEXT NOT NULL CHECK(need_type IN('consultation','licensing')), profession TEXT NOT NULL,
  description TEXT NOT NULL, requires_registration INTEGER NOT NULL DEFAULT 0, urgency TEXT,
  budget_min INTEGER, budget_max INTEGER, engagement TEXT CHECK(engagement IN('partnership','employment')), terms TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN('open','has_offers','matched','formalised','closed','expired')),
  created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, chosen_offer_id TEXT, formalised_at INTEGER, positions INTEGER NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS offers(
  id TEXT PRIMARY KEY, thread_id TEXT NOT NULL REFERENCES threads(id), professional_id TEXT NOT NULL REFERENCES professionals(user_id),
  kind TEXT NOT NULL CHECK(kind IN('interested','counter')), amount_cents INTEGER, terms TEXT, note TEXT,
  round INTEGER NOT NULL DEFAULT 1, status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN('pending','accepted','declined','withdrawn','expired')),
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, UNIQUE(thread_id, professional_id));
CREATE TABLE IF NOT EXISTS deals(
  id TEXT PRIMARY KEY, thread_id TEXT NOT NULL REFERENCES threads(id), offer_id TEXT NOT NULL, business_id TEXT NOT NULL,
  entrepreneur_id TEXT NOT NULL, professional_id TEXT NOT NULL, reference TEXT UNIQUE NOT NULL,
  need_type TEXT NOT NULL, amount_cents INTEGER, terms TEXT, terms_version INTEGER NOT NULL DEFAULT 1, terms_hash TEXT,
  lock_e INTEGER NOT NULL DEFAULT 0, lock_p INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL, created_at INTEGER NOT NULL, formalised_at INTEGER, affidavit_due INTEGER,
  delivered_at INTEGER, auto_release_at INTEGER, cancel_requested_by TEXT, cancel_reason TEXT, cancelled_at INTEGER,
  hidden_e INTEGER NOT NULL DEFAULT 0, hidden_p INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS payments(
  id TEXT PRIMARY KEY, deal_id TEXT NOT NULL REFERENCES deals(id), amount_cents INTEGER NOT NULL, fee_cents INTEGER NOT NULL,
  payout_cents INTEGER NOT NULL, method TEXT NOT NULL, provider_ref TEXT, idempotency_key TEXT UNIQUE,
  status TEXT NOT NULL CHECK(status IN('held','released','refunded','disputed')),
  payout_status TEXT NOT NULL DEFAULT 'none' CHECK(payout_status IN('none','pending','paid','failed')), payout_ref TEXT,
  created_at INTEGER NOT NULL, released_at INTEGER);
CREATE TABLE IF NOT EXISTS affidavits(
  id TEXT PRIMARY KEY, deal_id TEXT NOT NULL REFERENCES deals(id), party_user_id TEXT NOT NULL, party_role TEXT NOT NULL,
  terms_version INTEGER NOT NULL, terms_hash TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending'
    CHECK(status IN('pending','uploaded','verified','rejected','superseded')),
  file_sha256 TEXT, commissioner_name TEXT, commissioner_station TEXT, commissioned_on TEXT,
  rejection_reason TEXT, verified_by TEXT, verified_at INTEGER, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS affidavit_reviews(
  id TEXT PRIMARY KEY, affidavit_id TEXT NOT NULL REFERENCES affidavits(id), reviewer_id TEXT NOT NULL,
  decision TEXT NOT NULL CHECK(decision IN('confirmed','disputed')), comment TEXT, decided_at INTEGER NOT NULL,
  UNIQUE(affidavit_id, reviewer_id));
CREATE TABLE IF NOT EXISTS meetings(
  id TEXT PRIMARY KEY, deal_id TEXT NOT NULL REFERENCES deals(id), proposed_by TEXT NOT NULL, scheduled_at INTEGER NOT NULL,
  expected_end INTEGER NOT NULL, venue_type TEXT NOT NULL, venue_name TEXT, risk TEXT NOT NULL, safety_mode INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'proposed' CHECK(status IN('proposed','confirmed','in_progress','completed','cancelled')),
  created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS meeting_participants(
  meeting_id TEXT NOT NULL REFERENCES meetings(id), user_id TEXT NOT NULL, confirmed_at INTEGER, arrived_at INTEGER,
  checked_out_at INTEGER, PRIMARY KEY(meeting_id, user_id));
CREATE TABLE IF NOT EXISTS trusted_contacts(
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, name TEXT NOT NULL, phone TEXT NOT NULL, consented_at INTEGER);
CREATE TABLE IF NOT EXISTS safety_events(
  id INTEGER PRIMARY KEY AUTOINCREMENT, meeting_id TEXT NOT NULL, user_id TEXT, type TEXT NOT NULL, detail TEXT, at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS safety_reports(
  id TEXT PRIMARY KEY, meeting_id TEXT NOT NULL, reporter_id TEXT NOT NULL, reported_id TEXT NOT NULL, text TEXT NOT NULL, at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS notifications(
  id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT, phone TEXT, channel TEXT NOT NULL, type TEXT NOT NULL, body TEXT, at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS audit_log(
  id INTEGER PRIMARY KEY AUTOINCREMENT, actor_id TEXT, action TEXT NOT NULL, entity TEXT, entity_id TEXT, meta TEXT, at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS idx_threads_status ON threads(status, profession);
CREATE INDEX IF NOT EXISTS idx_offers_thread ON offers(thread_id);
CREATE INDEX IF NOT EXISTS idx_businesses_owner ON businesses(owner_id);
CREATE INDEX IF NOT EXISTS idx_users_identity ON users(identity_hash);
CREATE INDEX IF NOT EXISTS idx_deals_thread ON deals(thread_id);
CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_log(entity, entity_id, action);
`;

export function openDb(path = ':memory:') {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;');
  db.exec(SCHEMA);
  return {
    raw: db,
    run: (sql, ...p) => db.prepare(sql).run(...p),
    get: (sql, ...p) => db.prepare(sql).get(...p),
    all: (sql, ...p) => db.prepare(sql).all(...p),
    /** Single-writer transaction. Never await inside fn. */
    tx(fn) {
      db.exec('BEGIN IMMEDIATE');
      try { const r = fn(); db.exec('COMMIT'); return r; }
      catch (e) { db.exec('ROLLBACK'); throw e; }
    },
  };
}
