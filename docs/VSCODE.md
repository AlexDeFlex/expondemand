# Working on it in VS Code

Works on Windows, Mac and Linux.

1. Install **Node.js 22.5 or newer** (nodejs.org, the LTS version is fine). Check with `node -v` in a terminal.
2. Unzip the project and open the folder in VS Code (**File, Open Folder**).
3. Open the terminal (**Terminal, New Terminal**) and run:
   ```
   npm install
   npm run seed       (demo accounts; prints the logins)
   npm run dev        (starts the app and restarts when you save a file)
   ```
4. Open http://localhost:3000. To try it on your phone, use your computer's address on the same Wi-Fi, e.g. http://192.168.1.20:3000.
5. Sign in with any seeded phone number and the code **123456**. Staff: 082 111 0000.

**Debugging:** press **F5** and choose *Run ExpOnDemand (debug)*. Set breakpoints in any file in `src/`. Other launch options: *Seed demo data* and *Run all tests*.

**Tests:** `npm test` (36 tests, about 15 seconds).

**Where to change things**

| To change | Edit |
|---|---|
| Screens and text | `public/js/*.js`, `public/style.css` |
| Rules (matching, payments, affidavits, safety) | `src/*.js` |
| The list of professions | `data/professions.json` |
| Fees | `src/config.js` (`fee`) |

Refresh the browser after a change to `public/`. The server restarts itself after changes to `src/` when you use `npm run dev`.

**Handy extensions** (VS Code will offer them): REST Client for testing the API, and a SQLite viewer to look inside `expondemand.db`.
