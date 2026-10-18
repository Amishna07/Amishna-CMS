# Files to copy manually

The project root has three main folders for a move: `frontend/` and `backend/` contain application code; `Manual-Transfer/` holds local data that GitHub excludes. Clone the entire repository on the destination computer so the root launchers and scripts arrive too.

## Prepare this computer

1. In the dashboard, choose **Sync & refresh episodes** and wait until it finishes saving.
2. On this Mac, double-click `PREPARE MANUAL TRANSFER.command`. With Node.js 24 or later installed, you can instead run `npm run prepare:transfer` from the project root. This makes a transactionally consistent database snapshot, including changes in SQLite's WAL file.
3. Copy the entire `Manual-Transfer/` folder to a USB drive or another private location. Its `Database/` folder contains a dated `.sqlite` snapshot. Its `Config/` folder appears only if you have custom backend or frontend `.env` files.

## Restore on another computer

1. Clone the repository and install Node.js 24 or later. Keep the app stopped while placing the database file.
2. Create `backend/data/` in the clone. Copy the newest file from `Manual-Transfer/Database/` there and rename it to `amishna.sqlite`.
3. If `Manual-Transfer/Config/backend.env` exists, copy it to `backend/.env`. If `frontend.env` exists, copy it to `frontend/.env`. Check any custom `SQLITE_PATH` in `backend/.env`: the database must be placed at that path instead of the default `backend/data/amishna.sqlite`.
4. Run the launcher for your computer and sign in with your existing local account.

The SQLite file contains projects, episodes, cues, and local accounts. It is private and excluded from Git. Original Excel workbooks are not needed to reopen imported episodes; copy your originals separately if you want to retain them. Repeat the preparation command when you want to move newer changes. This is a transfer copy, not automatic synchronization between computers.
