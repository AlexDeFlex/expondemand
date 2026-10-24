import { route, go, renderRoute, S } from './core.js';
import './auth.js'; import './menu.js'; import './entrepreneur.js'; import './professional.js'; import './deals.js'; import './contacts.js'; import './admin.js';

route('/', { auth: false }, () => go(S.token ? '/menu' : '/welcome'));
window.addEventListener('hashchange', renderRoute);   // the browser's own back and forward buttons just work
// Find out whether this is a public demo (fixed code, fake data) so people are told on screen.
fetch(((window.EOD_CONFIG && window.EOD_CONFIG.api) || '') + '/health').then((r) => r.json()).then((h) => { S.demo = !!h.demo; }).catch(() => {}).finally(() => renderRoute());

// Installable and fast to open. Skipped on plain http (except localhost) where browsers do not allow it.
if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) navigator.serviceWorker.register('/sw.js').catch(() => {});
