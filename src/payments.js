import { config } from './config.js';
import { uid, sha256 } from './util.js';

/** Platform fee. Tiered by deal size with a minimum, never more than the deal itself. */
export function feeFor(amountCents) {
  const [, rate] = config.fee.tiers.find(([max]) => amountCents <= max);
  const fee = Math.min(amountCents, Math.max(config.fee.minCents, Math.round(amountCents * rate)));
  return { amount_cents: amountCents, fee_cents: fee, payout_cents: amountCents - fee, rate };
}

/**
 * Payment provider interface. The mock lets the whole platform run end to end.
 * A real adapter (Stitch, Ozow, Peach...) implements the same four methods; the rest of the code does not change.
 * Real card data must NEVER reach this server: use the provider's hosted fields and pass back a token.
 */
export class MockProvider {
  name = 'mock';
  failNextPayout = false;
  async charge({ amountCents, method, token }) {
    if (token === 'tok_decline') return { ok: false, reason: 'Card declined' };
    return { ok: true, ref: 'mock_ch_' + uid().slice(0, 8) };
  }
  async refund({ ref }) { return { ok: true, ref: 'mock_rf_' + ref.slice(-8) }; }
  async payout({ amountCents, accountToken }) {
    if (this.failNextPayout) { this.failNextPayout = false; return { ok: false, reason: 'Bank rejected payout' }; }
    return { ok: true, ref: 'mock_po_' + uid().slice(0, 8) };
  }
  async verifyAccount({ number }) { return { ok: true, token: 'acct_' + sha256(number).slice(0, 16), last4: number.slice(-4) }; }
}
