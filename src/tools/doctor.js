// "Is my computer ready?"  npm run doctor
import fs from 'node:fs';
let bad = 0;
const line = (ok, text, fix) => { console.log(`${ok ? '  OK ' : ' FIX '} ${text}${!ok && fix ? '\n       -> ' + fix : ''}`); if (!ok) bad++; };

const [maj, min] = process.versions.node.split('.').map(Number);
line(maj > 22 || (maj === 22 && min >= 5), `Node.js ${process.versions.node} (needs 22.5 or newer)`, 'Install the LTS version from nodejs.org, then reopen VS Code');
try { await import('node:sqlite'); line(true, 'Built-in database available'); } catch { line(false, 'Built-in database not available', 'Update Node.js to 22.5 or newer'); }
line(fs.existsSync('node_modules/express'), 'Packages installed', 'Run: npm install');
line(fs.existsSync('public/index.html') && fs.existsSync('data/professions.json'), 'App files and profession list found', 'Open the project folder itself in VS Code (the one containing package.json)');
let config;
try { ({ config } = await import('../config.js')); line(true, 'Settings load'); } catch (e) { line(false, 'Settings problem: ' + e.message, 'Check your .env file (see .env.example)'); }
if (config) {
  try { const { openDb } = await import('../db.js'); const db = openDb(':memory:'); db.raw.close(); line(true, 'Database can be created'); } catch (e) { line(false, 'Database problem: ' + e.message); }
  console.log(`\n  Mode:        ${process.env.NODE_ENV || 'development'}${config.demo ? ' + DEMO_MODE (fixed code ' + config.devOtp + ', fake data)' : ''}`);
  console.log(`  Staff phone: ${config.adminPhone || '(none set)'}`);
  const { makeGateway } = await import('../sms.js'), { makeRegistry } = await import('../registry.js');
  try { console.log(`  SMS:         ${makeGateway().name}${makeGateway().name === 'outbox' ? '  (nothing is texted; dev code only)' : ''}`); } catch (e) { line(false, 'SMS settings: ' + e.message); }
  try { console.log(`  Register:    ${makeRegistry().name}`); } catch (e) { line(false, 'Register settings: ' + e.message); }
  console.log('  Payments:    mock (simulated on purpose)');
}
console.log(bad ? `\n${bad} thing(s) to fix above.` : '\nAll good. Next: npm run seed, then npm run dev, then open http://localhost:3000');
process.exit(bad ? 1 : 0);
