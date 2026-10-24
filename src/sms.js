// SMS gateways. The app only ever calls gateway.send(toE164, text) and reads { ok }.
// Pick one with SMS_PROVIDER=outbox | twilio | http  (see docs/INTEGRATIONS.md).
const failed = (why) => ({ ok: false, why });
async function call(f, url, init) {
  try { const r = await f(url, init); return r.ok ? { ok: true } : failed('http_' + r.status); }
  catch { return failed('network'); }           // never put the message text or keys in an error
}

/** Development: nothing leaves the building. The message is stored in the notifications table only. */
export const outboxGateway = () => ({ name: 'outbox', send: async () => ({ ok: true }) });

/** Twilio Programmable Messaging. */
export function twilioGateway({ sid, token, from, messagingServiceSid, base = 'https://api.twilio.com' }, f = fetch) {
  if (!sid || !token || !(from || messagingServiceSid)) throw new Error('Twilio needs TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and TWILIO_FROM (or TWILIO_MESSAGING_SERVICE_SID)');
  return {
    name: 'twilio',
    send: (to, text) => {
      const body = new URLSearchParams({ To: to, Body: text });
      if (messagingServiceSid) body.set('MessagingServiceSid', messagingServiceSid); else body.set('From', from);
      return call(f, `${base}/2010-04-01/Accounts/${sid}/Messages.json`, {
        method: 'POST', body,
        headers: { authorization: 'Basic ' + Buffer.from(`${sid}:${token}`).toString('base64'), 'content-type': 'application/x-www-form-urlencoded' },
      });
    },
  };
}

/**
 * Any provider with a simple JSON REST endpoint (Clickatell, BulkSMS, SMSPortal, Infobip...).
 * body is a template; {{to}} becomes +27821234567, {{to_digits}} becomes 27821234567, {{text}} becomes the message.
 */
export function httpGateway({ url, headers = {}, body }, f = fetch) {
  if (!url || !body) throw new Error('The generic gateway needs SMS_HTTP_URL and SMS_HTTP_BODY');
  const esc = (s) => JSON.stringify(String(s)).slice(1, -1);       // safe inside a JSON string
  return {
    name: 'http',
    send: (to, text) => call(f, url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers },
      body: body.replaceAll('{{to_digits}}', esc(to.replace('+', ''))).replaceAll('{{to}}', esc(to)).replaceAll('{{text}}', esc(text)) }),
  };
}

export function makeGateway(env = process.env, f = fetch) {
  switch (env.SMS_PROVIDER || 'outbox') {
    case 'twilio': return twilioGateway({ sid: env.TWILIO_ACCOUNT_SID, token: env.TWILIO_AUTH_TOKEN, from: env.TWILIO_FROM, messagingServiceSid: env.TWILIO_MESSAGING_SERVICE_SID, base: env.TWILIO_API_BASE || undefined }, f);
    case 'http': return httpGateway({ url: env.SMS_HTTP_URL, headers: env.SMS_HTTP_HEADERS ? JSON.parse(env.SMS_HTTP_HEADERS) : {}, body: env.SMS_HTTP_BODY }, f);
    case 'outbox': return outboxGateway();
    default: throw new Error(`Unknown SMS_PROVIDER "${env.SMS_PROVIDER}". Use outbox, twilio or http.`);
  }
}
