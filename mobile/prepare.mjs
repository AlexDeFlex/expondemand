// Builds the web bundle the mobile app packages.
// Tell it where your server is, either:
//   - write the address in mobile/server-address.txt  (easiest, works on Windows), or
//   - set EOD_API=https://your-server.example
import fs from 'node:fs';
let api = process.env.EOD_API;
try { api ||= fs.readFileSync(new URL('./server-address.txt', import.meta.url), 'utf8').split('\n')[0].trim(); } catch { /* no file */ }
if (!api || !/^https?:\/\//.test(api)) {
  console.error('Put your server address (for example https://demo.yourdomain.co.za) on the first line of mobile/server-address.txt, then run again.');
  process.exit(1);
}
if (api.startsWith('http://')) console.warn('Warning: http is only for testing. Phones and app stores expect https.');
const dst = new URL('./www/', import.meta.url);
fs.rmSync(dst, { recursive: true, force: true });
fs.cpSync(new URL('../public/', import.meta.url), dst, { recursive: true });
fs.writeFileSync(new URL('./www/config.js', import.meta.url), `window.EOD_CONFIG = { api: ${JSON.stringify(api.replace(/\/$/, ''))} };\n`);
fs.rmSync(new URL('./www/sw.js', import.meta.url), { force: true });   // the native app bundles its own files
console.log('Mobile bundle ready in mobile/www, talking to', api);
