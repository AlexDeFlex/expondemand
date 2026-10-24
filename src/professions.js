import fs from 'node:fs';
const LIST = JSON.parse(fs.readFileSync(new URL('../data/professions.json', import.meta.url), 'utf8'));
const BY = new Map(LIST.map((p) => [p.name, p]));
export const getProfession = (name) => BY.get(name);
export const allProfessions = () => LIST;
export const groups = () => [...new Set(LIST.map((p) => p.group))];
export function searchProfessions(q = '', group = '', limit = 50) {
  const t = String(q).toLowerCase().trim();
  const g = String(group).toLowerCase();
  return LIST.filter((p) =>
    (!g || p.group.toLowerCase() === g) &&
    (!t || `${p.name} ${p.body} ${p.group}`.toLowerCase().includes(t))).slice(0, Math.min(Number(limit) || 50, 200));
}
