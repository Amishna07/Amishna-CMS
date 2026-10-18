# GitHub upload and local database transfer

This folder is a clean copy of the Amishna Music CMS code. Upload the **contents of this folder** as one repository, including `frontend/`, `backend/`, `scripts/`, the root launchers, and `.gitignore`. There is no live database, private `.env` file, local Node runtime, or history from the older repository in this copy.

Keep your SQLite database separate from the GitHub upload. After cloning the code on the computer where you will run it, install Node.js 24 or later. With the app stopped, copy your newest consistent `.sqlite` snapshot to `backend/data/amishna.sqlite` (create `backend/data/` first). Then start the app with its launcher. The database includes your local accounts and workspace records.

If you use Git in a terminal, `.gitignore` excludes the database and other local files. If you upload files through a browser, inspect the selected files yourself: the browser does not apply `.gitignore` to your file selection. See `Manual-Transfer/README.md` for the full restore steps.
