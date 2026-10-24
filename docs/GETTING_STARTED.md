# Start here: load it in VS Code and make the mobile app

Written for someone who has not done this before. Do the parts in order. Each part says how you know it worked.

---

## Part 1. Install the tools (once)

1. **Node.js**, the LTS version, from nodejs.org. It must be **22.5 or newer**.
2. **Visual Studio Code** from code.visualstudio.com.
3. Unzip `expondemand.zip` somewhere you can find it, for example `Documents`.

## Part 2. Open it and run it

1. In VS Code: **File, Open Folder**, choose the `expondemand` folder (the one that contains `package.json`).
2. Open the terminal: **Terminal, New Terminal**. Type these one at a time and press Enter after each:

   | Type | What it does | You know it worked when |
   |---|---|---|
   | `npm install` | downloads the building blocks | it ends with "found 0 vulnerabilities" |
   | `npm run doctor` | checks your computer is ready | every line says OK |
   | `npm run seed` | creates demo accounts and requests | it prints a table of phone numbers |
   | `npm run dev` | starts the app | it says "ExpOnDemand API on http://localhost:3000" |

3. Open **http://localhost:3000** in your browser. Leave the terminal running. Press **Ctrl+C** in it to stop.
4. Sign in with a seeded number and the code **123456**:

   | Who | Phone | What to try |
   |---|---|---|
   | Staff | 082 111 0000 | The review queue: approve businesses, experts and affidavits |
   | Entrepreneur | 082 100 0001 | Post a request, see the offer, pick, pay |
   | Expert (lawyer) | 083 100 0001 | Find jobs, send an offer or counter-offer |

   Sign-in only works for numbers that have registered. To make a new account choose **Create account**.

**If something goes wrong**

| You see | Do this |
|---|---|
| `'npm' is not recognized` or `command not found` | Close VS Code, install Node.js, reopen VS Code |
| `Port 3000 is already in use` | Another copy is running. Close it, or run `PORT=3001 npm run dev` (Mac/Linux) |
| `doctor` says Node is too old | Install the newest LTS version of Node.js |
| A page looks old after you edited it | Hard refresh: Ctrl+Shift+R |

## Part 3. Useful things in VS Code

- **F5** starts the app with the debugger. Click left of a line number in any file in `src/` to add a breakpoint.
- `npm test` runs all 36 tests (about 15 seconds). Green means every rule still works.
- Install the **REST Client** extension, open `docs/api.http`, and click **Send Request** above any block to call the API yourself.
- Where to edit: screens in `public/js/`, colours in `public/style.css`, rules in `src/`, fees in `src/config.js`, professions in `data/professions.json`.

## Part 4. See it on your phone (same Wi-Fi)

1. Find your computer's address: Windows `ipconfig` (look for IPv4), Mac `ipconfig getifaddr en0`.
2. On the phone's browser open `http://THAT-ADDRESS:3000`, for example `http://192.168.1.20:3000`.
3. If it will not load, allow Node.js through your computer's firewall.

This is for quick testing. Phones only let you **install** an app from a secure (https) address, so for that, do Part 5.

## Part 5. Make it a real mobile app

### Route A: install it from the browser (fastest, best for the hackathon)

1. Put the app online with https: follow `docs/DEPLOY.md`. For the competition use `DEMO_MODE=true`.
2. On the phone, open your https address.
3. Android (Chrome): menu, **Install app**. iPhone (Safari): Share, **Add to Home Screen**.
4. It gets its own icon, opens full screen, loads instantly, and keeps people signed in for 30 days.

This is a real installed app experience, and it needs no app store.

### Route B: an Android app file (APK) with Capacitor

You also need **Android Studio** (developer.android.com/studio). It brings the Android tools with it.

1. Put your **https** server address on the first line of `mobile/server-address.txt` (replace `https://demo.example.com`).
2. On the server, make sure `CORS_ORIGIN` includes `https://localhost` and `capacitor://localhost` (see `.env.example`).
3. In the VS Code terminal:
   ```
   cd mobile
   npm install
   npm run add:android
   npm run sync
   npm run open:android
   ```
4. Android Studio opens. Wait for it to finish loading (the bar at the bottom).
5. To run it: connect a phone with **USB debugging** turned on (or pick an emulator) and press the green **Run** button.
6. To get an installable file: **Build, Build Bundle(s) / APK(s), Build APK(s)**. The file is at `mobile/android/app/build/outputs/apk/debug/app-debug.apk`. Send it to a phone and open it (the phone will ask to allow installs from this source).
7. After you change anything in `public/`, run `npm run sync` again (inside `mobile`) and press Run.

### Route C: an iPhone app

Needs a Mac with Xcode. In `mobile`: `npm run add:ios`, `npm run sync`, `npm run open:ios`, then press Run in Xcode. Running on your own phone is possible with a free Apple account. Putting it in the App Store needs a paid developer account.

**Honest status:** the app, the packaging files and these steps are all in place, but I could not build an APK here (no Android tools), so do Route B **early** so there are no surprises. Route A already works with just a deployed https address.

**Common mobile problems**

| You see | Cause and fix |
|---|---|
| Blank screen in the packaged app | The server address is wrong or not https. Fix `mobile/server-address.txt`, then `npm run sync` |
| "Failed to fetch" or a network error | Server not reachable from the phone, or `CORS_ORIGIN` is missing `https://localhost` |
| "Cleartext not permitted" | You used `http://`. Use an https address |
| Can't install from the browser | The page is not on https |

## Part 6. Then

- Put it online: `docs/DEPLOY.md`
- Your two-day schedule and the demo script: `docs/TWO_DAY_PLAN.md`, `docs/DEMO_SCRIPT.md`
- Turn on real SMS or the register check: `docs/INTEGRATIONS.md`
