// The contract every payment provider must meet. Today it runs against the mock.
// When you write the real adapter, point `providers` at it and these same tests must pass.
process.env.NODE_ENV = 'test';
import test from 'node:test';
import assert from 'node:assert/strict';
const { MockProvider, feeFor } = await import('../src/payments.js');
const providers = { mock: () => new MockProvider() };

for (const [name, make] of Object.entries(providers)) {
  test(`payment provider contract: ${name}`, async () => {
    const p = make();
    const ok = await p.charge({ amountCents: 150000, method: 'card', token: 'tok_visa', ref: 'DEAL-1' });
    assert.equal(ok.ok, true); assert.ok(ok.ref, 'a successful charge returns a reference we can refund against');
    const declined = await p.charge({ amountCents: 150000, method: 'card', token: 'tok_decline', ref: 'DEAL-2' });
    assert.equal(declined.ok, false); assert.ok(declined.reason, 'a decline explains itself in plain words');
    assert.equal((await p.refund({ ref: ok.ref })).ok, true);
    const acct = await p.verifyAccount({ bank: 'FNB', number: '62000000123', holder: 'Thandi Naidoo' });
    assert.equal(acct.ok, true); assert.equal(acct.last4, '0123'); assert.ok(acct.token && !acct.token.includes('62000000123'), 'the token never contains the account number');
    const out = await p.payout({ amountCents: 127500, accountToken: acct.token, ref: 'DEAL-1' });
    assert.equal(out.ok, true); assert.ok(out.ref);
    const split = feeFor(150000);
    assert.equal(split.fee_cents + split.payout_cents, 150000, 'fee plus payout always equals the amount');
  });
}
