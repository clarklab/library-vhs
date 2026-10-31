# VHS Vault

A private VHS collection and scouting workspace for Netlify. Capture a shelf, review the readings, then either add the tapes you own or save a separate list of possible finds from a shop visit.

The interface uses warm paper, dark green ink, persimmon and acid yellow, with a desktop workspace, mobile navigation and a dedicated capture/review studio. The frontend remains plain JavaScript modules with no build step.

## Capture → review → collect or scout

1. Add up to **10 photos** from the camera, file picker or drag and drop. Image preparation runs one photo at a time to avoid decoding ten large images together. Resized JPEGs retain up to 2400 pixels on the longest edge and are checked against upload limits.
2. Start the queue. The browser submits at most **two photos** at a time as private, durable scan jobs, then polls their saved progress. Uploading, reading, counting and verification are separate states. A busy shelf can take several minutes; the page no longer has to hold one scan response open. Pause stops local uploads/polling, while already accepted server jobs continue. Resume reconnects to the same jobs.
3. For each photo, two independent model calls run in parallel: one counts physical VHS tapes without seeing the title list, and the other identifies titles and visible evidence. Their counts are compared. The counter enumerates occupied positions, so its total can be checked against an actual list rather than an assumed grid.
4. If the counts disagree, counting fails, tape boundaries are uncertain or a title needs review, the background worker saves the first reading and performs **one stronger verification pass**. It receives the original photo and the fallible draft. A missing, mismatched or uncertain count also receives an independent stronger recount in parallel. If this extra call fails, the durable first reading remains available with a review warning. There is no recursive “verify until confident” loop.
5. Review titles against numbered dots on the original photo. Selecting a title highlights its position; tap to add or move a marker, and zoom or rotate the photo to inspect it. The optional independent-count overlay is a separate model hypothesis. Matching counts or nearby dots do not establish complete coverage. Correct or exclude uncertain titles, add missed tapes manually, and confirm unresolved coverage after checking the photo. Possible repeat titles are highlighted across the batch and owned collection; separate physical copies are never automatically discarded.
6. After reading and review, choose the destination. **Collection** adds owned tapes. **Scout list** saves a named shop visit or possible purchase list without increasing collection totals. Film metadata, posters and live price checks are optional, separate actions.

Scanning is **VHS-specific**: clearly identifiable DVDs, CDs, Blu-rays and books should be excluded even when they share a shelf with tapes. Uncertain media formats require human review. Manual entries can carry other formats, and value estimates respect their explicit format.

Each background job has an **eight-minute work budget**, with up to four minutes for a reading and two minutes for its parallel count. The browser shows elapsed time and actual stages rather than inventing percentage completion. A stopped or disconnected browser does not cancel work already accepted by the server. The local draft remembers its job IDs, photos and edits so the same browser can reconnect; there is no cross-device draft browser or permanent cloud photo archive.

## Scouting and estimates

Scout lists are private to the signed-in account and persist on the server. They retain recognized titles, format, edition, visible evidence and source photo names/positions. Source images remain in the browser draft and are uploaded temporarily for background processing; they are not copied into saved cloud scout lists.

Open a scout list to search, filter, correct a find, check live prices for selected items, or add purchased items to the collection. Price checks are explicit per-tape or batch actions in scan review, scouting and the owned library; scanning does not automatically spend requests on pricing. Title, format, year, edition, artist and visible evidence can be edited. Identification or condition changes invalidate old price evidence, while delayed results must match the evaluated item snapshot. Collection updates and scout updates use conditional revisions to preserve concurrent edits. Batch checks run two at a time; scout results are saved after each finished pair. Pause cancels in-flight lookups, and navigating away stops the queue. Saved results remain, while failed and unprocessed selections stay available for retry in the current view. Purchasing uses the same stable physical-item ID as the original scan, preserving its price evidence without duplicating the copy on retry.

When `EBAY_CLIENT_ID` and `EBAY_CLIENT_SECRET` are set, the default price endpoint asks the **eBay Browse API** first. It requests up to 100 active US fixed-price listings in the item's eBay category (searching by barcode first when one is saved), mechanically drops non-comparable listings (wrong title or format, lots, box sets, PAL, sealed or new copies unless requested, for-parts, tape-only or case-only listings), and keeps the **10 lowest-priced** matches. The range and median come from those 10 asking prices; no model call is involved. Results are cached for six hours in the `market-cache` Blobs store (eBay requires displayed data to be no more than six hours older than eBay's), and the hourly cleanup deletes expired entries. A barcode search with no comparable result falls back to a keyword search. If eBay is not configured, rate-limited or failing, the endpoint uses the web-search lookup below; an eBay “no matches” result is returned as-is. Saved eBay results carry `market.provider: "ebay_browse"`.

Without eBay credentials, the default price endpoint performs **live web search for individual marketplace listings** through Anthropic's server web-search tool and Netlify AI Gateway. It searches allowed eBay, Mercari, Etsy and Discogs listing paths, then extracts comparable USD item prices from provider citations tied to actual search results. Each result retains source links, quoted evidence, listed condition/edition when available, lookup time and sample counts. Search pages, bundles, mismatched formats/editions, unsupported currencies and shipping/installment amounts cannot contribute prices. The pipeline has a 43-second total budget, at most two search uses, and no automatic search retry. No matches, unavailable search or an unidentified item returns nullable prices; it never substitutes a price from model memory.

**Asking prices are not resale values or completed sales.** Search indexes can lag, and excerpts may omit important condition details: open the source before relying on it. Explicit reported-sold evidence takes precedence when present; asking and sold amounts are never mixed into one range. Fewer than three comparisons and asking-price spreads of at least four times the low price receive warnings. “Worth checking” only means the selected sample's median is at least $20; it does not establish rarity, authenticity, demand or profit. eBay sold-search links remain available for manual comparison. Neither path is a sold-sales feed: the Browse API returns active listings only, and eBay's sold-data API is restricted to approved partners. The legacy `{mode:"ai"}` endpoint remains explicitly labeled `ai_estimate` with `liveComps:false`; the default UI uses live lookup.

A bounded end-to-end Gateway check on October 14, 2026 found two cited Jurassic Park VHS asking listings, $6 and $80, in 13.5 seconds. That verifies live retrieval and extraction, not appraisal accuracy; the wide spread illustrates why the interface labels asking prices and small samples. Source evidence is a saved snapshot, not a guarantee that a listing is still available.

## What makes retries safe

- Scan drafts use IndexedDB, keyed by account, and preserve photo progress, review edits and stable item IDs. Returning to the workspace restores the draft paused, ready to resume. Saving is blocked if these IDs cannot be persisted. Browser Web Locks prevent simultaneous editing of the same account draft in supported browsers; use a single scan tab on older browsers.
- Each photo attempt has a stable job `clientId` persisted before uploading. Repeating an interrupted submission returns that same job. A queued job can be redispatched with a fresh internal credential; an already claimed job cannot start another worker. A failed or expired job requires an explicit new attempt ID. Neither reconnecting nor polling starts another paid scan.
- Workers claim jobs with a conditional write and a ten-minute lease, longer than the eight-minute processing deadline. Expired leases are not reassigned: the job becomes failed, or completes with its preserved first reading and a verification warning. Worker requests contain only an opaque job ID and a random credential whose hash is stored privately. Owner-authenticated polling never returns image bytes or worker credentials.
- The save API accepts up to 100 tapes per request and uses atomic conditional writes for stable `clientId` values. Repeating a request returns existing records, including subsequent edits, instead of overwriting them.
- Every creation is confirmed with a strong read before the UI acknowledges success. This also guards against the conditional-write false-success behavior reported for the current Blobs SDK.
- Partial saves return exact failed item IDs and indexed failure details. Confirmed records are removed from the remaining save queue; the rest stay available for retry.
- Scout-list saves merge new item IDs using conditional revisions. Repeating a scan submission preserves list renames, saved estimates and purchase references. Ownership references are checked against the authenticated user's collection.
- Storage work is bounded: eight concurrent tape writes and sixteen inventory reads per request. Rendering limits the initial number of review rows and scout rows, with more available on demand.

These protections apply when callers supply stable IDs. Legacy direct-create callers without `clientId` retain their older create behavior; the new file importer uses a separate stable-identity restore API. A deliberate new scan of the same physical tape creates new IDs; overlap warnings and human review are still necessary.

Temporary scan photos are deleted when jobs finish. Abandoned photos **expire after 24 hours** and cannot be read by a worker after expiry; an hourly cleanup removes expired bytes and retries failed deletions. Scan results expire **seven days after job creation**, then compact to small identity tombstones that prevent an ancient retried request from starting another scan. Cleanup processes bounded batches and persists its position between runs; deletion can lag during a cleanup backlog or storage outage. Saved collection/scout records are not affected by these scan-job retention limits.

## Accounts and recovery

New visitors see a short welcome screen and can **start without an account**. “Start my vault” creates a guest vault: a real server-side account with no email or password, held by its session cookie. Scanning, scouting, pricing and backups all work the same. Guests see a “Save your vault” prompt in the header, sidebar and Account screen. Saving adds an email, password and recovery key to the same account ID, so nothing moves, and the current session stays signed in. Guest sessions renew when the app is opened, but a guest vault can still be lost if browser cookies are cleared, so the app encourages saving it. Signing in to another account from a guest vault shows a warning first, because that guest vault is left behind (a full JSON backup can still carry its contents across).

Create an account with an email address, an optional display name and a password of 12–128 characters. Existing accounts and their older password hashes remain supported. Account settings let you update your display name, change your password, create or replace a recovery key, and sign out every session. Password changes and password recovery revoke older sessions. Profile, password and settings changes merge against fresh conditional revisions so a concurrent settings save cannot restore an old password or undo session revocation.

New sessions use a 90-day `HttpOnly`, `Secure`, `SameSite=Strict` cookie. Local HTTP development uses a separate cookie without `Secure`. The API still accepts legacy bearer sessions for migration; `/api/auth/me` sets their cookie. The browser keeps a non-secret session marker to prevent a request from silently switching accounts after another tab signs in. Cookie mutations require a matching origin. Uploaded covers require the owner's current session and are served with `private, no-store` caching. Auth routes have a Netlify IP/domain rate limit; password hashes use salted scrypt, and the stored recovery key is hashed.

Save the recovery key shown at signup or when replacing it. **Recovery uses your email address and that key, not an email reset link.** There is no mail provider or email-verification service configured. Recovering a password replaces the recovery key and shows the new one. A signed-in user who still knows their password can generate a replacement key. Without a working password/session or the saved recovery key, the app cannot independently establish account ownership.

## Backups, spreadsheets and restoring

Open **Account & backup → Backup & import** to download saved data or preview an import before it writes anything.

| Format | What it contains |
| --- | --- |
| Full JSON backup | All saved collection fields and original timestamps/IDs; complete scout lists with estimates, purchase links and photo-name/position references; uploaded cover image bytes with SHA-256 checksums |
| CSV | The owned collection as a spreadsheet-friendly table, including sale fields, artist, notes, arrays, saved price evidence, timestamps and stable IDs |
| Excel `.xlsx` | The same collection table in an Excel workbook |

CSV and Excel are collection interchange formats. They do **not** contain scout lists or image files. Saved price evidence is preserved as JSON in its own cell, including links and quoted sources; importing validates its structure and totals but does not rerun the lookup. Cover URLs remain in those tables; restoring uploaded covers into a different account requires the full JSON backup. Text imports accept comma-, tab- or semicolon-separated tables with a Title column. Unknown columns, invalid values and duplicate record IDs are surfaced in preview; spreadsheet formulas are not executed. Keep exported Record ID, Client ID and Source Account ID columns to preserve identity. Rows without IDs receive deterministic IDs from their contents and duplicate occurrence, so retrying the same table is safe; changing an unidentified row's contents creates a different identity. Rows without an explicit sale status default to Keep.

The full backup uses `format: "tape-deck-account-backup"`, `version: 1`, `source: {accountId}`, `exportedAt`, and `tapes`, `scouts`, `covers` arrays. Unsupported versions are rejected. Export checks the saved-record fingerprint before and after collection and refuses a file if the account changed. Uploaded covers are fetched through authenticated, owner-checked backup routes. Remote poster URLs are retained, but the app does not download third-party poster bytes.

Restore is **additive**: missing records are added, existing records and their later edits are kept, and nothing is deleted. Identity comes from stable record/client IDs, never a movie title. Same-account record IDs are preserved; cross-account legacy IDs and uploaded-cover IDs are mapped deterministically and references are repaired. Original created/updated dates and estimates survive. Each write uses a conditional create and a strong confirmation read, so a lost response can be retried with the same file without duplicating confirmed records. Failures identify individual records; completed chunks remain saved while retry resumes the remaining work.

The importer sends covers first, then collection records, then scout lists. Requests are capped at 4 MiB, cover images at 2.5 MiB decoded, and collection chunks at 100 records. Scout lists contain at most 1,000 items and travel in 100-item parts; the server checks the complete list checksum before publishing it. Partial scout lists never appear in the app. Private staged parts are removed after a successful import; abandoned incomplete parts currently require operational cleanup and have no scheduled expiry.

Backups exclude passwords, recovery keys, sessions, API keys, profile/settings credentials and **unfinished browser drafts, temporary scan jobs and source photos**. The downloaded file is a portable copy of saved collection/scouting data, not an account-login credential. Cloud records, temporary photos and scan jobs use **Netlify Blobs**; browser photos, review edits and job references also remain in **IndexedDB**. This does not migrate records to a relational database. Downloads are manual backups, not scheduled offsite snapshots or point-in-time recovery. Keep a completed JSON file outside the browser and test importing it into a separate test account before relying on it as your only recovery copy.

## Other collection features

- Searchable cover, list and spreadsheet views; status filters and sorting.
- Title entry, pasted lists, full JSON backup/restore, and CSV/Excel collection import/export.
- Optional OMDb film metadata, posters and ratings; AI fallback when appropriate.
- Condition, edition, location, barcode, purchase and sale prices, notes and tags.
- Collection insights, sales history and profit summaries.
- Email/password accounts, editable profiles, recovery keys, cookie sessions and session revocation.
- Installable home-screen app, keyboard focus states, accessible dialogs and reduced-motion support.

## Stack and deployment

| Component | Implementation |
| --- | --- |
| Hosting | Netlify serves `public/` and `netlify/functions/` |
| Storage | Netlify Blobs, account-prefixed records with strong consistency |
| AI | Anthropic SDK through Netlify AI Gateway |
| Film metadata | Optional OMDb key, with AI fallback |
| Frontend | Vanilla ES modules; no frontend build required |
| Local drafts | Browser IndexedDB, scoped by account |
| Long scans | Netlify Background Functions with private Blobs job/photo stores and authenticated polling |

Install dependencies and start a development environment:

```sh
npm install
npx netlify dev
```

Connect the project to an appropriate Netlify development site for Gateway-backed testing. Site-wide Blobs stores are shared across deploy contexts: use a separate test site or mocked stores for destructive tests. Automated tests in this repository use mocks and do not write production data.

Deploy with `public` as the publish directory and `netlify/functions` as the functions directory; `netlify.toml` already defines these. Netlify AI Gateway requires an eligible site with AI features enabled and a production deployment. Its Anthropic integration supplies `ANTHROPIC_API_KEY` and `ANTHROPIC_BASE_URL` to server functions. No provider key belongs in frontend code.

| Environment variable | Default / purpose |
| --- | --- |
| `VHS_AI_MODEL` | `claude-sonnet-5-5`: everyday identification, independent counting and enrichment |
| `VHS_AI_THOROUGH_MODEL` | `claude-opus-5-5`: careful mode and the conditional verification pass |
| `VHS_MARKET_MODEL` | Defaults to `VHS_AI_MODEL`: live web search and cited-price extraction; requires server web-search support |
| `ANTHROPIC_API_KEY` | Supplied by Gateway, or a server-side credential for a separately configured local evaluation |
| `ANTHROPIC_BASE_URL` | Gateway's Anthropic-compatible endpoint when using Gateway |
| `EBAY_CLIENT_ID`, `EBAY_CLIENT_SECRET` | Optional production keyset from developer.ebay.com; enables eBay Browse API pricing (5,000 free calls a day by default) |
| `OMDB_API_KEY` | Optional site-wide OMDb key; `OMDB_KEY`, `omdb` and `OMDB` are also supported |

Users can also save an OMDb key in Settings. Model choices are controlled on the server. Overrides must support the structured-output and adaptive-thinking request used by the shared AI helper; selecting an arbitrary provider/model name in these environment variables is not a provider switch.

Background scans have an eight-minute total processing budget, followed by bounded terminal-state persistence. Each reading can use up to four minutes and its independent counter up to two minutes. The Anthropic SDK streams the upstream response and collects its final structured result, avoiding one long buffered provider response. The worker persists progress and the first reading; polling requests are short. The control endpoint has a 25-second deadline and worker dispatch an eight-second deadline. The hourly cleanup runs at minute 17 UTC with a 25-second deadline. These functions must be included in the deployment: `scan-jobs`, `scan-worker-background` and `scan-job-cleanup`.

The legacy synchronous `/api/scan` endpoint remains for compatibility, with its shorter 52-second handler/48-second AI limits. Everyday identification uses low effort, while careful identification uses medium effort. A quick transient provider error may receive one retry inside the same call budget. Timeouts, invalid JSON and truncated model output remain visible; expired workers are not automatically restarted. Safe failure details retain the stage, request ID, elapsed time, provider error category and retry delay without logging photos, credentials or raw provider bodies.

References: [Netlify AI Gateway](https://docs.netlify.com/build/ai-gateway/overview/), [Netlify Blobs conditional writes](https://docs.netlify.com/build/data-and-storage/netlify-blobs/), [function configuration](https://docs.netlify.com/build/functions/configuration/), [Background Functions](https://docs.netlify.com/build/functions/background-functions/), [Claude structured outputs](https://platform.claude.com/docs/en/build-with-claude/structured-outputs), [Anthropic web search](https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-search-tool). Pricing uses the stable `web_search_20260318` server tool with direct calls, requiring no beta headers; provider or Gateway access failures surface as unavailable results.

## API

Authenticated routes use the session cookie and JSON requests/responses. Legacy `Authorization: Bearer <token>` remains supported. Browser requests pin the expected non-secret session marker with `X-VHS-Session`; cookie mutations require a matching `Origin`.

| Route | Contract |
| --- | --- |
| `POST /api/auth/signup`, `/login`, `/logout`; `GET /api/auth/me` | Account and session management. Signup from a guest session upgrades that guest in place and keeps its session |
| `POST /api/auth/guest` | `{}`; opens a guest vault with a session cookie, or returns the current session if one exists |
| `PATCH /api/auth/profile` | `{displayName}`; update the current account profile |
| `POST /api/auth/password`, `/recovery`, `/logout-all` | Confirm `currentPassword` to change password (`newPassword`), replace the recovery key, or revoke every session |
| `POST /api/auth/reset` | `{email,recoveryCode,newPassword}`; recover access, revoke older sessions and return a new recovery key |
| `GET /api/tapes` | Owned collection |
| `POST /api/tapes` | Single item or `{tapes:[...]}`, maximum 100; stable `clientId` enables safe retries. Returns `{tapes,failedCount,failedClientIds,failures}` |
| `PATCH /api/tapes/:id`; `DELETE /api/tapes/:id` | Update or delete an owned tape |
| `POST /api/scan-jobs` | `{clientId,image:dataURL,mode:'fast'|'thorough',sourceId}`; durably stores a private photo attempt and returns HTTP 202 with `{job,pollAfterMs}`; retries reuse the same `clientId` |
| `GET /api/scan-jobs/:id` | Owner-only progress/result polling; `{job,pollAfterMs}` with queued/running/completed/failed/expired status, stage, ISO timestamps, result and safe failure details; never image bytes or worker credentials |
| `POST /api/scan` | Legacy synchronous compatibility: `{image:dataURL,mode:'fast'|'thorough',sourceId,verificationContext?}`; returns title drafts, evidence, confidence, format, counts, warnings and verification status |
| `POST /api/enrich` | `{items:[{title,year}]}`, maximum 25; optional film details |
| `GET /api/scouts`; `GET /api/scouts/:id` | List summaries or a full private scout list |
| `POST /api/scouts` | `{clientId,name,items,photos:[{id,name}]}`; stable list/item IDs merge new entries safely, maximum 1000 items per list |
| `PATCH /api/scouts/:id` | `{name?,items?:[{clientId,title?,year?,format?,edition?,artist?,visual?,estimate?,estimateFor?,purchasedTapeId?}]}`, maximum 100 item updates; prices include their evaluated `{title,year,format,edition,artist,condition,sealed,packaging,barcode}` as `estimateFor` |
| `DELETE /api/scouts/:id` | Delete a scout list; purchased collection records remain |
| `POST /api/value` | `{title,format,year?,artist?,edition?,packaging?,barcode?,sealed?,condition?}`; default `source:"live_web_search"`, nullable USD range/median, `market:{provider,status,basis,fetchedAt,sampleCount,askingCount,soldCount,listings,warnings}`; explicit `mode:"ai"` selects the legacy model-only estimate |
| `POST /api/cover` | `{tapeId,image:dataURL}`; separately uploads a cover for an owned tape |
| `GET /api/cover/:coverId` | Private image available only to its signed-in owner; native image requests use the session cookie |
| `GET/PUT /api/settings` | Per-user OMDb settings |
| `GET /api/backup` | Version/source metadata, record and cover IDs, export fingerprint; no credentials |
| `GET /api/backup/tapes?cursor=0` | Up to 100 full collection records and `nextCursor` |
| `GET /api/backup/scouts/:id?cursor=0` | Scout metadata, up to 100 items, `totalItems`, `nextCursor` |
| `GET /api/backup/covers/:id` | Owner-checked `{id,contentType,data:base64,sha256}` |
| `POST /api/backup/restore` | Version/source envelope plus `kind: 'covers'|'tapes'|'scouts'`, `records`; additive results report source/destination IDs and `created`, `existing`, `staged` or `failed` |

A scan accepts a maximum 4 MiB decoded image and returns at most 100 tape entries per photo. Greater counts and incomplete coverage are surfaced for closer photos/review, not silently treated as complete.

## Tests and real-photo acceptance

Run all backend, storage, API-client and queue tests, plus syntax checks:

```sh
npm test
npm run check
```

Run the browser suite (mocked API, no production data or paid calls):

```sh
npx playwright install chromium
npm run test:browser
```

For an existing Chrome install, set `PLAYWRIGHT_CHROMIUM_EXECUTABLE` to its executable path. Browser tests cover desktop/mobile layouts, collection search and views, restored scan edits, required review, scout-only saves, estimates and purchases. `npm run preview` provides a static visual preview on port 4173; use Netlify Dev for actual authentication and model calls.

Tests cover strict AI responses, independent counting, one-pass verification, cancellation/recovery, malformed images, partial saves, lost acknowledgements, concurrent retries, preservation of edits, account isolation, scout merges and format-aware valuation. Pricing tests require actual tool-source membership, reject invented/non-USD/shipping amounts and mismatched editions/artists, separate sold and asking samples, exercise unavailable/cancelled searches, and protect newer edits from late results. Backup tests additionally exercise saved market evidence in JSON/CSV/spreadsheet rows, private cover access, schema/type/checksum rejection, malicious fields and paths, concurrent restore retries, original date preservation, atomic multi-part scouts, and a full cross-account export/restore/export round trip through the browser orchestration and server handlers. Account tests cover recovery, cookie authentication, session revocation and concurrent updates. Mock tests do not measure visual recognition accuracy or live Gateway availability.

Background-job tests exercise real store/controller/worker integration with mocked storage and inference, owner isolation, concurrent duplicate dispatch, lost acknowledgements, invalid credentials, count progress, safe error diagnostics, expired leases, retained first readings, temporary-image cleanup and seven-day result expiry. Browser tests simulate long scans and cover reconnecting after reload, pause/resume and completed-result recovery. A production check on October 30, 2026 retried the reported 24-tape photograph successfully: the independent counter found 24, the reader returned 24 title rows, and all 24 markers appeared on the physical spines. Duplicate copies remained separate, and the review draft restored all results after a full reload. The scan was left for the user to choose a save destination. This is one live smoke check, not a 5–10-photo accuracy benchmark; the earlier timings below describe the preceding synchronous implementation.

`scripts/evaluate-scan.mjs` evaluates a supplied local photograph against the ground truth in `tests/scan-fixtures.json`. It never creates library or scout records. Check an image without making a paid call:

```sh
node scripts/evaluate-scan.mjs --fixture rotated-spines --image /absolute/path/photo.png --dry-run
```

For an explicitly authorized live model evaluation, provide the appropriate server-side environment and omit `--dry-run`. With a linked Netlify development environment, use `VHS_EVAL_IMAGE=/absolute/path/photo.png VHS_EVAL_FIXTURE=rotated-spines netlify dev:exec node scripts/evaluate-scan.mjs`; environment options avoid the Netlify CLI consuming evaluator flags. Use `--out /absolute/path/report.json` to retain the evaluation report. Fixtures include rotated spines, rotated covers and a mixed shelf. The mixed-shelf fixture has partial VHS ground truth and excluded non-VHS titles; it is not a complete count benchmark. User photographs are not committed to this repository.

Earlier live Gateway checks on the three supplied photographs produced mixed results: the eight-spine image returned all eight exact titles with the correct count in 9.2 seconds; the nine-cover image returned count nine and eight exact titles in 27.2 seconds, while the sticker-obscured “Walking Across Egypt” remained a medium-confidence correction. On the dense mixed shelf, the initial reading returned 42 candidates in 23.5 seconds and the independent counter reported 59, six uncertain. The stronger pass timed out after 48 seconds, so the initial readings were retained with required review (71.6 seconds total). All 11 known VHS titles in the partial reference set appeared and none of the five excluded DVD title groups appeared, but the fixture has no complete ground-truth count: this is not a dense-shelf accuracy pass. Closer photos of smaller sections remain necessary for that case. A later spatial-marker run placed all eight real titles correctly but added a ninth low-confidence unknown on a dark furniture panel; the independent counter also counted nine. That result remained review-gated and is not a spatial-accuracy pass.

Before production acceptance, run representative **5-photo and 10-photo batches** on a real phone, with a manually counted/title-labeled reference set. Include glare, rotated spines, unreadable boxes, duplicate copies, overlapping photographs, mixed DVD/CD shelves and non-English titles. Check these outcomes:

- Every physical VHS tape is either identified correctly or visibly unresolved; no unreadable tape quietly disappears. Clearly non-VHS media are excluded.
- Independent count mismatches, failed verification and unknown formats remain visible until reviewed. Repeated physical copies stay separate; overlapping appearances are highlighted for a person to resolve.
- Reload, tab navigation, sign-out/sign-in, network loss, rate limits and a lost save response preserve completed work and do not duplicate confirmed records.
- Scout-only saves never affect owned totals. Retrying a purchase creates at most one owned record for that scout item.
- Measure first-result latency, full-batch latency, correction rate, false-positive rate and model cost. Choose acceptable thresholds against the actual devices, network and collection before claiming performance targets.

There is **no guarantee of 100% recognition or uninterrupted execution**. Independent passes can share mistakes. Accepted scans continue in server background jobs when the browser closes, but clearing browser data removes local photos, edits and job references. Unsubmitted photos cannot progress without the browser, and device storage limits can prevent local persistence. Temporary job retention does not replace a saved collection or a backup. Source images are sent through the Gateway to the model for processing. Inventory loading still fetches the full account collection, so much larger catalogs will eventually need server-side pagination or a queryable database.
