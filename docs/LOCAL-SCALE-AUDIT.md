# Local SQLite capacity audit — 18 October 2026

## Scope and method

The audit used a temporary SQLite database, not the live workspace. It created 10 clients, 100 Series projects, 100 episodes per project, and one import-history record per episode. Episode, cue, and import shapes were cloned from this app's current imported workfile data, with synthetic IDs and labels. The three runs varied cues per episode. Each workspace was serialized and schema-validated. Runs under the app's 64 MiB limit were saved to and read from temporary SQLite. The browser's compressed cache encoder and decoder were also exercised on those workspaces. Times below are local Node 24 measurements on this Mac, not browser-rendering times or guarantees on other machines.

| Cues per episode | Total cues | Workspace JSON | Browser cache | SQLite save / read | Browser fingerprint / one-cue diff | Result |
| ---: | ---: | ---: | ---: | ---: | ---: | --- |
| 1 | 10,000 | 16.93 MiB | 1.01 MiB | 51 / 25 ms | 2.4 / 0.5 s | Saved, read, and cache round trip passed |
| 5 | 50,000 | 55.58 MiB | 3.52 MiB | 114 / 101 ms | 7.7 / 1.8 s | Saved, read, and cache round trip passed; slow browser sync |
| 10 | 100,000 | 103.90 MiB | Not attempted | Not attempted | 14.4 / 3.3 s | Exceeds 64 MiB app limit |

The current live data used as the shape sample had roughly 747 episodes, 808 cues, three shared Works, and 748 import records. Its workspace JSON was about 1.4 MiB. A catalog with many unique Works, long notes, export snapshots, or other metadata will grow faster than the table above.

## Findings

1. **SQLite can store the tested 10,000-episode cases.** The app's limit is its whole-workspace JSON request, not SQLite's row limit. It still rewrites one large JSON value per save and sends the whole workspace to each browser session.
2. **Ten cues per episode is not supported at this scale.** The measured 103.9 MiB exceeds the local 64 MiB request limit. Five cues per episode fits the measured dataset but leaves about 8.4 MiB for additional Works, metadata, and snapshots.
3. **Browser recovery storage is a separate limit.** The five-cue test compressed to 3.52 MiB and decoded correctly after a 32 MiB decoder limit bug was fixed. Browser quotas differ, and other saved data can use the same quota. A failed browser cache write prevents a normal app save.
4. **Browser sync gets slow before SQLite does.** At 50,000 cues, calculating the current fingerprint took about 7.7 seconds and finding a one-cue change took about 1.8 seconds in Node. These routines run in the browser's main thread. They were measured outside a browser, so real UI delay can differ. The app still loads the full workspace into browser memory and builds derived reports over all records.
5. **Large views need paging.** The cue list and import history previously rendered every matching row. Both now render 100 records per page.
6. **A single very large Series project needs another UI audit.** The benchmark distributes episodes over 100 projects. One project with 10,000 episodes may create a very large episode selector and tabs; it was not represented by this test.

## Conclusion of the original implementation

The local app can persist 10,000 episodes when each episode has few cues and modest metadata, but even the tested one-cue case makes browser synchronization noticeable. It cannot reliably meet a requirement of 10,000 episodes with up to 10 cues each. A dependable target at that size requires storing projects, episodes, cues, and history as separate SQLite records and loading pages or ranges on demand, with a durable browser edit queue. Raising the 64 MiB limit alone would leave browser quota and full-workspace rendering risks.

## Record storage update — 18 October 2026

The local edition now stores each project, episode, cue, song, client, and history item in indexed SQLite rows. Existing JSON workspaces migrate in a transaction after a consistent SQLite snapshot is created. The old JSON row remains in that snapshot. The localhost dashboard reads 1,000 records per API page and sends changed records in smaller batches; a revision check and operation ID make retries safe after a lost response. The browser keeps pending edits in local storage until SQLite confirms them. Episode tabs render 50 at a time.

A second synthetic run used 10 clients, 100 Series projects, 10,000 episodes, 100,000 cues, and 10,000 import records. The generated workspace was 96.69 MiB as JSON, beyond the old 64 MiB save limit. On this Mac with Node 24, the temporary SQLite database saved all records in 789 ms. A 1,000-cue page and manifest read took 5 ms. Cloning the workspace and finding a one-cue change took 426 ms and produced a 1,053-byte patch. SQLite applied that patch in 104 ms with `PRAGMA integrity_check` returning `ok`. The localhost record transport opened all 100,000 cues in 905 ms (about 501 MiB Node heap in that process) and completed a one-cue browser-style save in 793 ms. These are repeatable with `scripts/benchmark-local-records.js 10000 10`; they are not browser timings.

An additional 250-worksheet transport run added 250 episodes, 2,500 cues, three Series projects, and 250 import records to the already large workspace. The browser-style queue was 2.41 MiB before compression. The ordered record batches finished in 2.8 seconds, and SQLite then reported 10,250 episodes and 102,500 cues. Browser builds compress the recovery queue when useful; the benchmark measured the uncompressed Node fallback.

The workfile importer now groups existing cues by project and episode before checking duplicates, so each imported row checks only its destination episode. The catalog's artist matching and usage reconciliation also use lookup maps. A separate Node check reconciled usage across 100,000 cues in 116 ms and built artist links for 50,000 distinct Works in 252 ms. These checks exclude workbook parsing and browser rendering.

The full workspace is still assembled in browser memory for cross-project reports and exports. Memory use and large report rendering may therefore vary by computer. The browser recovery queue also has a storage quota: if one import batch is too large, use fewer worksheets per batch. Full JSON backup restoration still uses the legacy 64 MiB endpoint; SQLite snapshots are the recovery format for larger workspaces. A single project with 10,000 episodes has paged tabs, but export selectors and other forms may still be long. These remain practical limits to check with the actual workbook and browser.

## Backup and refresh changes

Settings now includes **Download database (.sqlite)**. It first waits for pending workspace edits to sync, then creates an integrity-checked SQLite snapshot using `VACUUM INTO`. The server saves it to `Database/Amishna_Database_YYYY-MM-DD_HH-mm-ss-SSS.sqlite` beside the app and sends the same file to the browser. App-generated snapshots older than seven days are deleted at startup, after a download, and once a day while the app runs; the newest is always retained. SQLite downloads require an administrator session. **Sync & refresh episodes** saves pending edits, checks the server revision, and loads newer SQLite data while preserving the prior browser copy. A conflicting tab remains locked for explicit resolution.
