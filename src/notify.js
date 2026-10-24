// Notification outbox. In production, swap the delivery functions for an SMS gateway and FCM push.
// Everything is also stored so the app (and tests) can read what was "sent".
export function makeNotifier(db, clock, gateway = { send: async () => ({ ok: true }) }) {
  const store = (userId, phone, channel, type, body) =>
    db.run('INSERT INTO notifications(user_id,phone,channel,type,body,at) VALUES(?,?,?,?,?,?)',
      userId ?? null, phone ?? null, channel, type, JSON.stringify(body ?? null), clock.now());
  return {
    push: (userId, type, body) => store(userId, null, 'push', type, body),
    /** Best effort: stored for the record and sent without making the caller wait. A failure is logged, never thrown. */
    sms: (phone, type, body) => { store(null, phone, 'sms', type, body); gateway.send(phone, body.text).then((r) => { if (!r.ok) console.error(`[sms] ${type} not delivered (${r.why})`); }).catch(() => {}); },
    /** For login codes: wait for the gateway so the person is told if the text could not be sent. */
    smsNow: async (phone, type, body) => { store(null, phone, 'sms', type, body); return gateway.send(phone, body.text); },
  };
}
export const audit = (ctx, actorId, action, entity, entityId, meta) =>
  ctx.db.run('INSERT INTO audit_log(actor_id,action,entity,entity_id,meta,at) VALUES(?,?,?,?,?,?)',
    actorId ?? null, action, entity ?? null, entityId ?? null, meta ? JSON.stringify(meta) : null, ctx.clock.now());
