# Our Shared Roots

A family-tree web app you host yourself on Firebase. Relatives sign in with Google. The Super Admin decides who may view or edit the tree. The default display name is **Family Tree**; you choose your own title when you run setup.

This repository is a generic, publishable starter. It ships no family data and no Firebase project credentials. A setup script writes a self-contained deploy folder that you upload with the Firebase CLI.

## What you get

- An interactive tree canvas and an outline view
- An admin panel for people, access lists, the change log, and GEDCOM import/export
- Google sign-in
- Firestore security rules that reserve create/delete and access-list changes for the Super Admin
- A compact change log with revert, plus a one-time move page if an older archive still stores history inside the tree document
- A compact System / Light / Dark theme toggle in the tree and admin headers. The default follows the device, and the choice is saved in this browser
- Photo storage statistics on the admin Overview, and GEDCOM import/export at the top of the Data tab
- A small progressive web app (manifest, icons, service worker). CSS and JavaScript are emitted with content hashes. The service worker uses network-first for HTML, precaches the hashed assets, and does not cache Auth or Firestore

## Requirements

- A Google account
- [Node.js](https://nodejs.org/) 18 or later (for the Vite build and the setup script)
- The [Firebase CLI](https://firebase.google.com/docs/cli): `npm install -g firebase-tools`

## 1. Create a Firebase project

1. Open the [Firebase console](https://console.firebase.google.com/) and create a project (or use an existing one). Note the **project ID**.
2. Do not add Google Analytics unless you want it. It is optional.

## 2. Enable Google sign-in

The app uses **Google** authentication only.

1. In the console: **Build → Authentication → Get started**.
2. Open the **Sign-in method** tab, enable **Google**, set a support email, and save.
3. Under **Settings → Authorized domains**, keep `localhost` for testing and add your Hosting domain after the first deploy (Firebase usually adds `PROJECT_ID.web.app` and `PROJECT_ID.firebaseapp.com` for you).

## 3. Create a Cloud Firestore database

1. **Build → Firestore Database → Create database**.
2. Start in **production** mode (the app ships its own rules; do not leave the database open).
3. Choose a location and remember it. Common choices are `nam5` (United States, multi-region) and `asia-south2`. This cannot be changed later.
4. Create the default database.

A Blaze (pay-as-you-go) plan is required if you later want official Firestore backups; the Spark plan is enough to run the app within free limits.

## 4. Register a web app and copy the config

1. Project **settings** (the gear) → **Your apps** → **Add app** → **Web** (`</>`).
2. Nickname it as you like. You can tick Firebase Hosting, or set Hosting up in the next step.
3. Copy the `firebaseConfig` object. It looks like this:

```js
{
  apiKey: "...",
  authDomain: "YOUR_PROJECT_ID.firebaseapp.com",
  projectId: "YOUR_PROJECT_ID",
  storageBucket: "YOUR_PROJECT_ID.firebasestorage.app",
  messagingSenderId: "...",
  appId: "..."
}
```

Save it as a JSON file, for example `firebase-web-config.json` (use quoted keys). Do not commit this file.

## 5. Build the site

From this repository:

```bash
npm install
npm run build
```

That compiles the page modules and writes hashed CSS and JavaScript into `dist/`. Re-run `npm run build` whenever you change the source, then re-run setup (or copy the new `dist/` into your deploy folder and keep your existing `dist/config.js`).

## 6. Run setup

Setup writes a self-contained deploy folder. It copies the built `dist/` site, adds your `config.js`, and fills in Firestore rules and Hosting config.

```bash
# macOS / Linux
./setup.sh --project-id YOUR_PROJECT_ID \
  --super-admin you@example.com \
  --firebase-config ./firebase-web-config.json \
  --site-title "Family Tree" \
  --location nam5 \
  --archive-id familytree

# Windows PowerShell
.\setup.ps1 --project-id YOUR_PROJECT_ID `
  --super-admin you@example.com `
  --firebase-config .\firebase-web-config.json `
  --site-title "Family Tree" `
  --location nam5 `
  --archive-id familytree
```

You can also run `node setup.mjs` with the same flags, or run the script with no flags and answer the prompts.

What the flags mean:

| Flag | Meaning | Default |
| --- | --- | --- |
| `--project-id` | Firebase project ID | (required) |
| `--super-admin` | Google account that owns the archive | (required) |
| `--firebase-config` | Path to the web config JSON, or `-` for stdin | (required unless you pass the individual fields) |
| `--site-title` | Name shown in the header and browser | `Family Tree` |
| `--location` | Firestore location written into `firebase.json` | `nam5` |
| `--archive-id` | Document ID under `archives/` | `familytree` |
| `--archive-log-id` | Change-log document ID | `<archive-id>_log` |
| `--out` | Output folder | `./deploy-<project-id>` |
| `--force` | Overwrite an existing output folder | off |

The script refuses to overwrite an existing output folder unless you pass `--force` or confirm at the prompt. The output folder is gitignored. If `dist/` is missing, it tells you to run `npm run build` first.

It writes:

```
deploy-YOUR_PROJECT_ID/
  dist/                   built site, including dist/config.js
  firestore.rules         rules with your Super Admin email and document IDs
  firestore.indexes.json
  firebase.json           Hosting points at dist/, with hashed-asset cache headers
  .firebaserc             your project ID
  README.md
```

`dist/config.js` defines `window.OSR_CONFIG` (Firebase web config, Super Admin email, site title, archive IDs). The pages load it before the app starts. A filled `config.js` is gitignored and should never be committed.

## 7. Deploy

```bash
firebase login
cd deploy-YOUR_PROJECT_ID
firebase deploy
```

This deploys **Hosting** and **Firestore rules**. After the first deploy, the site is typically at `https://YOUR_PROJECT_ID.web.app/`.

Old alias paths 301-redirect to the canonical pages: `/genealogy-studio.html` and `/family-tree.html` go to `/`; `/genealogy-admin.html` goes to `/admin.html`. `/admin` still rewrites to `/admin.html`. Hashed files under `/assets/` are cached for a long time; HTML, the service worker, theme boot, and `config.js` are not cached.

## 8. First sign-in as Super Admin

1. Open the site and sign in with the **same Google account** you passed as `--super-admin`.
2. That first visit creates the two archive documents. Anyone else who signs in before that will be denied until the archive exists.
3. Open **Admin** (the quiet Admin control in the header). On **People & access**, add relatives by email and grant **View** or **Edit**. Only the Super Admin can change who may sign in.
4. In-app **Admin** and **Edit** roles can update the tree (Edit) or also use the admin panel and rename the tree (Admin). They cannot replace the Super Admin or change the access lists.

### How access is enforced

- Roles live in three lists on the tree document that only the Super Admin can change: `authorizedEmails` (view), `editorEmails` (edit), and `adminEmails` (admin). The Firestore rules enforce them.
- The access list shown in the app (inside the tree data) is rebuilt from those lists every time the tree loads, so an editor who edits the tree data directly cannot grant anyone access. If the app finds a mismatch, the Super Admin sees an "Access check" notice.
- Every save, including the Super Admin's, must be stamped with the writer's own account, keep the document's required fields, and move `revision` forward by exactly one. An older tab or a custom client that tries to overwrite a newer save is refused by the server.

### Upgrading an existing site

Deploy the new rules and the new pages together (`npm run build`, then `firebase deploy`). Existing documents keep working without a migration script: documents without `adminEmails` are still accepted, and the Super Admin's first save adds it. After that first save, open **Admin → People & access** and check who has the Admin role; the app asks you to review any admin role it could not confirm from older data. Old tabs left open from before the update will get a "someone else saved first" message on their next save and need a reload.

## Local preview (optional)

After setup, you can preview without deploying:

```bash
npx --yes serve deploy-YOUR_PROJECT_ID/dist
```

Sign-in will only work if `localhost` is in the project's authorized domains. The app talks to your real Firebase project, not a mock.

## Configuration file

If you want to preview the Vite build without running setup, copy `config.example.js` to `dist/config.js` after `npm run build` and fill it in. A filled `config.js` is gitignored and should never be committed.

## Tests

- `npm test` builds the site and runs the setup, page-load, phone touch, and access/revision page tests in headless Chrome. It uses `puppeteer-core` from `devDependencies` (run `npm install` once) and finds Chrome or Chromium automatically; set `PUPPETEER_EXECUTABLE_PATH` (or `CHROME_PATH`) if yours is somewhere unusual.
- `npm run test:rules` runs the Firestore rules suite in the emulator (needs Java 11+). See `rules-test/README.md`. The suite uses only synthetic people and the rules template (or a generated `firestore.rules` file).

## License

MIT. See [LICENSE](LICENSE).
