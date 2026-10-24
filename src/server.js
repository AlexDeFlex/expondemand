import { config } from './config.js';
import { createContext, createApp } from './app.js';
import * as threads from './threads.js';
import * as deals from './deals.js';
import * as safety from './safety.js';

const ctx = createContext();
if (process.env.NODE_ENV === 'production' && process.env.DEMO_MODE !== 'true' && ctx.sms.name === 'outbox')
  throw new Error('Production needs a real SMS provider (SMS_PROVIDER=twilio or http). Use DEMO_MODE=true only for a fake-data demo.');
const app = createApp(ctx);

// Background jobs. On several servers, run these from ONE scheduler (cron or a queue), not every instance.
const guard = (name, fn) => async () => { try { await fn(); } catch (e) { console.error(`[job:${name}]`, e.message); } };
setInterval(guard('safety', () => safety.runSafetyEscalation(ctx)), 60e3);
setInterval(guard('payments', () => deals.runPaymentMaintenance(ctx)), 5 * 60e3);
setInterval(guard('threads', () => threads.runThreadMaintenance(ctx)), 15 * 60e3);

const server = app.listen(config.port, () => console.log(`ExpOnDemand API on http://localhost:${config.port}  (${process.env.NODE_ENV || 'development'}, sms: ${ctx.sms.name}, register: ${ctx.registry.name}${config.demo ? ', DEMO MODE' : ''})`));
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { console.log(`${sig}: finishing requests and closing`); server.close(() => { ctx.db.raw.close(); process.exit(0); }); setTimeout(() => process.exit(1), 8000).unref(); });
