// Business register (CIPC) check. A match is evidence for staff; a person still approves unless REGISTRY_AUTO_APPROVE=true.
// Pick one with REGISTRY_PROVIDER=none | didit  (see docs/INTEGRATIONS.md).
export const noRegistry = () => ({ name: 'none', enabled: false, autoApprove: false, check: async () => ({ status: 'unchecked' }) });

/** Didit "South Africa - Company Registry Lookup" (CIPC commercial register), billed per successful query. */
export function diditRegistry({ apiKey, base = 'https://verification.didit.me', autoApprove = false }, f = fetch) {
  if (!apiKey) throw new Error('Didit needs DIDIT_API_KEY');
  return {
    name: 'didit', enabled: true, autoApprove,
    async check({ cipc_number }) {
      try {
        const form = new FormData();
        form.set('issuing_state', 'ZAF'); form.set('services', 'zaf_company_registry'); form.set('company_registration_number', cipc_number);
        const r = await f(`${base}/v3/database-validation/`, { method: 'POST', headers: { 'x-api-key': apiKey }, body: form });
        if (!r.ok) return { status: 'error', http: r.status };
        const j = await r.json();
        return { status: j.status === 'Approved' && j.match_type === 'full_match' ? 'match' : 'no_match', request_id: j.request_id };
      } catch { return { status: 'error' }; }
    },
  };
}

export function makeRegistry(env = process.env, f = fetch) {
  switch (env.REGISTRY_PROVIDER || 'none') {
    case 'didit': return diditRegistry({ apiKey: env.DIDIT_API_KEY, base: env.DIDIT_API_BASE || undefined, autoApprove: env.REGISTRY_AUTO_APPROVE === 'true' }, f);
    case 'none': return noRegistry();
    default: throw new Error(`Unknown REGISTRY_PROVIDER "${env.REGISTRY_PROVIDER}". Use none or didit.`);
  }
}
