// Central configuration. Everything sensitive comes from environment variables.
const env = process.env;
const prod = env.NODE_ENV === 'production';
if (prod && (!env.JWT_SECRET || env.JWT_SECRET.length < 32)) {
  throw new Error('JWT_SECRET (32+ chars) is required in production');
}
export const config = {
  port: Number(env.PORT || 3000),
  dbPath: env.DB_PATH || 'expondemand.db',
  jwtSecret: env.JWT_SECRET || 'dev-only-secret-change-me-please-0123456789',
  tokenTtlMs: Number(env.TOKEN_TTL_HOURS || 24 * 30) * 3600e3,   // a device stays signed in for 30 days; sign-out revokes it
  stepUpWindowMs: 10 * 60e3,                         // sensitive actions need a code from the last 10 minutes
  demo: env.DEMO_MODE === 'true',                    // a clearly labelled public demo: fixed code, no real SMS
  devOtp: (!prod || env.DEMO_MODE === 'true') ? (env.DEV_OTP || '123456') : null,   // a fixed code is never allowed in a real production deployment
  otpTtlMs: 5 * 60e3,
  otpMaxAttempts: 3,
  otpLockMs: 5 * 60e3,
  otpMaxSendsPerHour: 5,
  smsDailyCap: Number(env.SMS_DAILY_CAP || 500),     // hard ceiling on code messages per day: protects you from SMS-pumping bills
  adminPhone: env.ADMIN_PHONE || (prod ? null : '0821110000'),   // a default staff number for local development only
  autoVerify: env.AUTO_VERIFY === 'true',            // demo convenience: skip staff review
  sdsVersion: '2026-01',
  sdsValidMs: 365 * 24 * 3600e3,
  // Platform fee: [max deal size in cents, rate]. Minimum fee protects tiny jobs.
  fee: { minCents: 5000, tiers: [[500000, 0.15], [2000000, 0.10], [Infinity, 0.07]] },
  threadTtlMs: 7 * 24 * 3600e3,
  threadArchiveAfterFormaliseMs: 7 * 24 * 3600e3,
  maxOffersPerThread: 10,
  maxCounterRounds: 3,
  maxPositions: 5,                                   // experts one consultation request can hire
  maxActiveThreadsPerBusiness: 3,
  maxBusinessesPerPerson: 10,
  autoReleaseMs: 48 * 3600e3,
  bankChangeHoldMs: 48 * 3600e3,
  highValueCents: 5000000,
  anthropicKey: env.ANTHROPIC_API_KEY || null,
  anthropicModel: env.ANTHROPIC_MODEL || 'claude-sonnet-5-5',
  // Comma-separated list. Default is open for development. In production set it to your site and the app origins, e.g.
  // https://expondemand.co.za,capacitor://localhost,https://localhost
  corsOrigin: env.CORS_ORIGIN || (prod ? 'https://localhost' : '*'),
};
