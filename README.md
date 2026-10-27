# Amishna Music CMS — local edition

The dashboard, API, accounts, and workspace run on this computer. The standalone macOS app stores its SQLite data in `~/Library/Application Support/Amishna Music CMS/amishna.sqlite`; the development launchers use `backend/data/amishna.sqlite`. The application does not need MongoDB, Vercel, Google Sheets, or an internet connection.

## Start

On this Mac, double-click `Amishna Music CMS.app` in the project folder. It includes the CMS files and Node runtime, opens in its own macOS window, and manages its local service while the app is open. Quit the app to stop the service. The database stays in your Application Support folder. If the app bundle is missing, use `START AMISHNA MUSIC CMS.command`. On another computer, install Node.js 24 or later, then use the matching `.command`, `.bat`, or `.sh` launcher. No `npm install` is required for this edition because the SQLite driver is included with Node.js.

Set up a local administrator on the first visit, then sign in. The server and SQLite file stay on this computer.

`backend/.env` is optional. Copy `backend/.env.example` only if you need a different `SQLITE_PATH`, `WORKSPACE_ID`, or port. `frontend/.env` is also optional; the default proxy targets the local API on port 4000. The data folder and local configuration files are excluded from Git.

## Move existing data from the hosted app

1. On the existing Vercel site, sign in and choose **Settings → Download full backup**. Keep that JSON file safe. Login accounts are separate and are not included in the workspace backup.
2. Start this local edition, create its administrator, and choose **Settings → Restore backup**. Review the counts and confirm the restore.
3. Wait for **Saved to local database**. Reopen the dashboard and confirm the projects, episodes, songs, and cues are present before relying on the local copy.

This repository does not contain the hosted MongoDB data or its account credentials. The existing Vercel deployment is unchanged until new code is deployed there. The local app never contacts Atlas.

## Import and export workfiles

**Import workfiles** accepts XLSX, XLS, and CSV files from this computer. Select no more than 250 worksheets per batch and use files no larger than 10 MB. A 1,000-episode workbook needs at least four batches. Review the worksheet results, choose **Import valid worksheets**, and wait for **Saved to local database** before importing the next batch. A workbook with many tabs can be narrowed to a range without changing the original file. Google Sheets links are disabled; download an XLSX copy first.

The fixed workfile template is available in the app. Fill A1 (total duration), B1 (date), C1 (project name), E1 (episode or work number), then enter plays from row 3. Repeated plays of the same song combine into one cue with editable occurrences. Import and export history expires after seven days; projects, episodes, songs, artists, cues, and downloaded files remain.

Exports can cover an episode range or all episodes, with separate worksheet tabs for each episode. Reference workbooks for IPRS, PRS, and ASCAP are bundled with the app. In the standalone macOS app, generated cue sheets are saved to `~/Downloads`; if a filename already exists, a numbered copy is saved so the earlier file is preserved. No web service is needed to create the exports.

## Storage and backups

SQLite stores projects, episodes, cues, songs, and history as separate indexed records. The localhost dashboard reads those records in pages and sends only changed records when you edit or import. Pending edits are kept in a small browser queue until SQLite confirms them. If the queue reports that an import is too large, import fewer worksheets in that batch. The full JSON restore route still has a 64 MB request limit; keep SQLite database snapshots for recovery at larger sizes. An import that says **Not imported** was not saved to SQLite.

When an older local JSON database is opened for the first time, the API creates a dated SQLite snapshot before migrating it. The original JSON row remains in that snapshot. If a browser tab still has an unsynced edit from the older save system, finish its sync and refresh that tab to switch to record saves.

Use **Settings → Download full JSON backup** regularly and keep a copy outside this computer. **Download database (.sqlite)** creates a consistent SQLite snapshot while the app is running, saves it in the app's `Application Support/Amishna Music CMS/Database` folder with a date and time in its filename, and starts a browser download of the same file. Your browser chooses where that second copy goes. App-generated snapshots older than seven days are removed automatically at startup, after a new download, and daily while the app runs; the newest snapshot is always kept, even if it is older than seven days. Manually named files and browser downloads outside `Database/` are untouched. **Sync & refresh episodes** saves pending changes, checks the SQLite copy, and loads newer episodes when available. If another tab has conflicting edits, the save bar lets you download the device copy before loading the newer database copy. Database snapshots contain account password hashes and workspace data; keep them private.

## Moving to another computer

The top-level `frontend/` and `backend/` folders contain application code. On this Mac, double-click `PREPARE MANUAL TRANSFER.command` before moving computers; with Node.js on your PATH, `npm run prepare:transfer` works too. This creates a current, consistent SQLite copy in `Manual-Transfer/Database/` and copies any custom `.env` files into `Manual-Transfer/Config/`. Follow [Manual-Transfer/README.md](Manual-Transfer/README.md) to restore them after cloning the code. Only the transfer instructions go to GitHub; the database and private configuration stay on this computer until you copy them yourself.

## 10,000 episode capacity

There is no fixed episode-count limit. A synthetic 10,000-episode / 100,000-cue run (about 97 MiB of JSON) saved successfully to the indexed SQLite tables. A one-cue edit sent about 1 KB, and the local record transport reopened all pages and saved the edit. Episode tabs now show 50 at a time; cue and import-history lists show 100 rows per page. The dashboard still assembles the full workspace in browser memory for reports and exports, so a large workspace needs enough RAM and may feel slower on other computers. The test is a capacity check, not a hardware guarantee. See [the detailed scale audit](docs/LOCAL-SCALE-AUDIT.md).

Password hashes use salted scrypt. Sessions use HttpOnly cookies and expire after eight hours. Administrators can create and manage editor accounts. Both local servers enforce loopback host and same-origin checks.

The `api/` Vercel routes remain in the repository only to return a **local-only** message if someone deploys this edition; they do not connect to a database. Use the local launcher for this version.
