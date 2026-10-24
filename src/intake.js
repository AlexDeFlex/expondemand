import { config } from './config.js';
import { allProfessions, getProfession } from './professions.js';

/**
 * AI intake: turns a rambling request ("client wants someone to sign off my drawings") into a structured one.
 * Uses Claude when ANTHROPIC_API_KEY is set; otherwise a deterministic keyword matcher, so the demo never breaks offline.
 * The model may only choose from our own profession list: its answer is validated, never trusted.
 */
const SYN = {
  tender: ['Tender Law Specialist', 'Public Procurement Lawyer', 'Contract Lawyer', 'Project Manager'],
  contract: ['Contract Lawyer', 'Commercial Lawyer', 'Contract Manager'],
  agreement: ['Commercial Lawyer', 'Contract Lawyer'], legal: ['Commercial Lawyer', 'Legal Consultant'], sue: ['Attorney'], dispute: ['Dispute Resolution Specialist', 'Mediator'],
  vat: ['Tax Lawyer', 'Management Accountant'], tax: ['Tax Lawyer', 'Management Accountant'], staff: ['Employment Lawyer', 'Human Resources Manager'],
  fraud: ['Fraud Investigator', 'Forensic Accountant'], hack: ['Cybersecurity Analyst', 'Penetration Tester'], website: ['Web Developer', 'Software Developer'],
  app: ['Mobile App Developer', 'Software Developer'], label: ['Food Safety Consultant', 'Food Regulatory Affairs Specialist'], food: ['Food Safety Consultant', 'Food Scientist'],
  environmental: ['Environmental Consultant', 'Environmental Impact Assessment Practitioner'], water: ['Water Treatment Consultant', 'Hydrologist'],
  mine: ['Mining Geologist', 'Mining Lawyer'], patent: ['Patent Attorney', 'Intellectual Property Lawyer'], trademark: ['Trademark Attorney'], investor: ['Business Valuation Consultant'],
  strategy: ['Strategy Consultant', 'Management Consultant'], project: ['Project Manager'], supplier: ['Procurement Specialist', 'Supply Chain Manager'], safety: ['Health and Safety Manager'],
};
const stem = (w) => w.replace(/(ing|ers|er|es|s)$/, '');

function heuristic(text, n = 3) {
  const t = text.toLowerCase();
  const tokens = [...new Set(t.split(/[^a-z]+/).filter((w) => w.length >= 3).map(stem))];
  const scored = allProfessions().map((p) => {
    const name = p.name.toLowerCase().split(/[^a-z]+/).map(stem);
    const grp = p.group.toLowerCase();
    let s = 0;
    tokens.forEach((w) => { if (name.includes(w)) s += 3; if (grp.includes(w)) s += 1; });
    return { p, s };
  });
  Object.entries(SYN).forEach(([k, names]) => { if (t.includes(k)) names.forEach((n) => { const hit = scored.find((x) => x.p.name === n); if (hit) hit.s += 4; }); });
  const top = scored.filter((x) => x.s > 0).sort((a, b) => b.s - a.s).slice(0, n);
  return top.map((x) => x.p);
}
const licensingHint = (t) => /(licen[cs]e|register(ed)?\b.*(sign|cover|front|partner)|sign[- ]?off|partnership|co-?director|put (my|their) name|front for)/i.test(t);

async function viaClaude(text, shortlist) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': config.anthropicKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: config.anthropicModel, max_tokens: 500,
      system: `You classify a South African small-business owner's request for expert help. Reply with JSON only: {"profession": one of the allowed names exactly, "need_type": "consultation" or "licensing", "summary": under 160 characters, "reason": one short sentence}. "licensing" means they need a registered professional to sign off, front a tender, or partner or employ for their registration. Never invent a profession.`,
      messages: [{ role: 'user', content: `Allowed professions: ${JSON.stringify(shortlist)}\n\nRequest: ${text}` }],
    }),
  });
  if (!res.ok) throw new Error('claude ' + res.status);
  const data = await res.json();
  const raw = (data.content || []).map((c) => c.text || '').join('').replace(/```json|```/g, '').trim();
  return JSON.parse(raw);
}

export async function intake(text) {
  const t = String(text || '').trim();
  if (t.length < 10) return { error: 'Describe what you need in a sentence or two.' };
  const wide = heuristic(t, 25);
  const cand = wide.slice(0, 3);
  const fallbackNeed = licensingHint(t) ? 'licensing' : 'consultation';
  const shape = (p, need, extra = {}) => ({
    profession: p?.name || null, registration_body: p?.body || null,
    need_type: need, requires_registration_suggested: need === 'licensing' && !!p?.registered,
    alternatives: cand.filter((c) => c.name !== p?.name).map((c) => c.name), ...extra,
  });
  if (config.anthropicKey && wide.length) {
    try {
      const pool = wide.map((p) => p.name);
      const r = await viaClaude(t, pool);
      const p = getProfession(r.profession);
      if (p && pool.includes(p.name) && ['consultation', 'licensing'].includes(r.need_type))
        return shape(p, r.need_type, { summary: String(r.summary || '').slice(0, 160), reason: String(r.reason || '').slice(0, 200), engine: 'claude' });
    } catch { /* fall through to heuristic */ }
  }
  return shape(cand[0], fallbackNeed, { summary: t.slice(0, 160), engine: 'heuristic', confidence: cand.length ? 'medium' : 'low' });
}
