// One-off live checks for the real integrations:
//   npm run check:sms -- 0821234567          sends ONE test message through your configured SMS provider
//   npm run check:registry -- 2019/123456/07 looks ONE company up on your configured register provider
import { makeGateway } from '../sms.js';
import { makeRegistry } from '../registry.js';
import { normPhone, cipcValid } from '../util.js';

const [kind, arg] = process.argv.slice(2);
if (kind === 'sms') {
  const g = makeGateway();
  if (g.name === 'outbox') { console.log('SMS_PROVIDER is "outbox", so nothing is sent. Set SMS_PROVIDER=twilio or http first (docs/INTEGRATIONS.md).'); process.exit(1); }
  const to = normPhone(arg);
  const r = await g.send(to, `Test from ExpOnDemand at ${new Date().toLocaleTimeString('en-ZA')}. If you can read this, SMS works.`);
  console.log(r.ok ? `Sent through ${g.name} to ${to}. Check the phone.` : `Not sent (${r.why}). Check your keys, sender and balance.`);
  process.exit(r.ok ? 0 : 1);
} else if (kind === 'registry') {
  const reg = makeRegistry();
  if (!reg.enabled) { console.log('REGISTRY_PROVIDER is "none". Set REGISTRY_PROVIDER=didit and DIDIT_API_KEY first (docs/INTEGRATIONS.md).'); process.exit(1); }
  if (!cipcValid(arg)) { console.log('Use the format 2019/123456/07'); process.exit(1); }
  const r = await reg.check({ cipc_number: arg });
  console.log(`Register check for ${arg}: ${r.status}${r.http ? ` (HTTP ${r.http})` : ''}`);
  process.exit(r.status === 'error' ? 1 : 0);
} else { console.log('Usage: npm run check:sms -- 0821234567   or   npm run check:registry -- 2019/123456/07'); process.exit(1); }
