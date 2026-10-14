# VHS Vault

A private VHS collection and scouting workspace for Netlify. Capture a shelf, review the readings, then either add the tapes you own or save a separate list of possible finds from a shop visit.

The interface uses warm paper, dark green ink, persimmon and acid yellow, with a desktop workspace, mobile navigation and a dedicated capture/review studio. The frontend remains plain JavaScript modules with no build step.

## Capture → review → collect or scout

1. Add up to **10 photos** from the camera, file picker or drag and drop. Image preparation runs one photo at a time to avoid decoding ten large images together. Resized JPEGs retain up to 2400 pixels on the longest edge and are checked against upload limits.
2. Start the queue. At most **two photos** are processed at once; each photo shows its own progress, result and retry action. You can pause and resume the queue.
3. For each photo, two independent model calls run in parallel: one counts physical VHS tapes without seeing the title list, and the other identifies titles and visible evidence. Their counts are compared. The counter enumerates occupied positions, so its total can be checked against an actual list rather than an assumed grid.
4. If the counts disagree, counting fails, tape boundaries are uncertain or a title needs review, the client requests **one stronger verification pass**. It receives the original photo and the fallible draft. A missing, mismatched or uncertain count also receives an independent stronger recount in parallel. If this extra call fails, the initial readings remain available. There is no recursive “verify until confident” loop.
5. Correct or exclude uncertain titles. Unresolved count differences require checking the source photo and confirming that every tape is accounted for. Add missed titles manually. Possible repeat titles are highlighted across the batch and owned collection; separate physical copies are never automatically discarded.
6. Choose the destination. **Collection** adds owned tapes. **Scout list** saves a named shop visit or possible purchase list without increasing collection totals. Film metadata and posters are optional, separate from saving recognized titles.

Scanning is **VHS-specific**: clearly identifiable DVDs, CDs, Blu-rays and books should be excluded even when they share a shelf with tapes. Uncertain media formats require human review. Manual entries can carry other formats, and value estimates respect their explicit format.

## Scouting and estimates

Scout lists are private to the signed-in account and persist on the server. They retain recognized titles, format, edition, visible evidence and source photo names/positions. Source images themselves remain in the browser scan draft; they are not copied into cloud scout lists.

Open a scout list to search, filter, correct a find, request estimates for all selected items, or add purchased items to the collection. Title, format, year, edition, artist and visible evidence can be edited; changes to identification invalidate its old estimate while preserving the physical-item and source references. Delayed estimates are rejected if another tab has changed the identification. Estimates run two at a time and each finished pair is saved before the next starts. Pause cancels in-flight lookups; navigating away also stops the queue. Saved results remain, while failed and unprocessed selections stay available for retry in the current view. Purchasing uses the same stable physical-item ID as the original scan, so retrying an interrupted purchase does not create another copy.

Prices are **uncertain AI estimates in USD, not live sold prices or appraisals**. Missing, contradictory and unknown estimates display no numeric price. “Worth checking” is a transparent triage rule: the AI's typical estimate is at least $20. It does not establish rarity, authenticity, demand or buying profit. Each item links to an eBay sold-listing search so the collector can compare the exact format, edition and condition. The app does not fetch or validate those sales.

## What makes retries safe

- Scan drafts use IndexedDB, keyed by account, and preserve photo progress, review edits and stable item IDs. Returning to the workspace restores the draft paused, ready to resume. Saving is blocked if these IDs cannot be persisted. Browser Web Locks prevent simultaneous editing of the same account draft in supported browsers; use a single scan tab on older browsers.
- The save API accepts up to 100 tapes per request and uses atomic conditional writes for stable `clientId` values. Repeating a request returns existing records, including subsequent edits, instead of overwriting them.
- Every creation is confirmed with a strong read before the UI acknowledges success. This also guards against the conditional-write false-success behavior reported for the current Blobs SDK.
- Partial saves return exact failed item IDs and indexed failure details. Confirmed records are removed from the remaining save queue; the rest stay available for retry.
- Scout-list saves merge new item IDs using conditional revisions. Repeating a scan submission preserves list renames, saved estimates and purchase references. Ownership references are checked against the authenticated user's collection.
- Storage work is bounded: eight concurrent tape writes and sixteen inventory reads per request. Rendering limits the initial number of review rows and scout rows, with more available on demand.

These protections apply when callers supply stable IDs. Legacy direct-create callers without `clientId` retain their older create behavior; the new file importer uses a separate stable-identity restore API. A deliberate new scan of the same physical tape creates new IDs; overlap warnings and human review are still necessary.

## Accounts and recovery

Create an account with an email address, an optional display name and a password of 12–128 characters. Existing accounts and their older password hashes remain supported. Account settings let you update your display name, change your password, create or replace a recovery key, and sign out every session. Password changes and password recovery revoke older sessions. Profile, password and settings changes merge against fresh conditional revisions so a concurrent settings save cannot restore an old password or undo session revocation.

New sessions use a 90-day `HttpOnly`, `Secure`, `SameSite=Strict` cookie. Local HTTP development uses a separate cookie without `Secure`. The API still accepts legacy bearer sessions for migration; `/api/auth/me` sets their cookie. The browser keeps a non-secret session marker to prevent a request from silently switching accounts after another tab signs in. Cookie mutations require a matching origin. Uploaded covers require the owner's current session and are served with `private, no-store` caching. Auth routes have a Netlify IP/domain rate limit; password hashes use salted scrypt, and the stored recovery key is hashed.

Save the recovery key shown at signup or when replacing it. **Recovery uses your email address and that key, not an email reset link.** There is no mail provider or email-verification service configured. Recovering a password replaces the recovery key and shows the new one. A signed-in user who still knows their password can generate a replacement key. Without a working password/session or the saved recovery key, the app cannot independently establish account ownership.

## Backups, spreadsheets and restoring

Open **Account & backup → Backup & import** to download saved data or preview an import before it writes anything.

| Format | What it contains |
| --- | --- |
| Full JSON backup | All saved collection fields and original timestamps/IDs; complete scout lists with estimates, purchase links and photo-name/position references; uploaded cover image bytes with SHA-256 checksums |
| CSV | The owned collection as a spreadsheet-friendly table, including sale fields, notes, arrays, timestamps and stable IDs |
| Excel `.xlsx` | The same collection table in an Excel workbook |

CSV and Excel are collection interchange formats. They do **not** contain scout lists or image files. Cover URLs remain in those tables; restoring uploaded covers into a different account requires the full JSON backup. Text imports accept comma-, tab- or semicolon-separated tables with a Title column. Unknown columns, invalid values and duplicate record IDs are surfaced in preview; spreadsheet formulas are not executed. Keep exported Record ID, Client ID and Source Account ID columns to preserve identity. Rows without IDs receive deterministic IDs from their contents and duplicate occurrence, so retrying the same table is safe; changing an unidentified row's contents creates a different identity. Rows without an explicit sale status default to Keep.

The full backup uses `format: "tape-deck-account-backup"`, `version: 1`, `source: {accountId}`, `exportedAt`, and `tapes`, `scouts`, `covers` arrays. Unsupported versions are rejected. Export checks the saved-record fingerprint before and after collection and refuses a file if the account changed. Uploaded covers are fetched through authenticated, owner-checked backup routes. Remote poster URLs are retained, but the app does not download third-party poster bytes.

Restore is **additive**: missing records are added, existing records and their later edits are kept, and nothing is deleted. Identity comes from stable record/client IDs, never a movie title. Same-account record IDs are preserved; cross-account legacy IDs and uploaded-cover IDs are mapped deterministically and references are repaired. Original created/updated dates and estimates survive. Each write uses a conditional create and a strong confirmation read, so a lost response can be retried with the same file without duplicating confirmed records. Failures identify individual records; completed chunks remain saved while retry resumes the remaining work.

The importer sends covers first, then collection records, then scout lists. Requests are capped at 4 MiB, cover images at 2.5 MiB decoded, and collection chunks at 100 records. Scout lists contain at most 1,000 items and travel in 100-item parts; the server checks the complete list checksum before publishing it. Partial scout lists never appear in the app. Private staged parts are removed after a successful import; abandoned incomplete parts currently require operational cleanup and have no scheduled expiry.

Backups exclude passwords, recovery keys, sessions, API keys, profile/settings credentials and **unfinished browser scan drafts/source photos**. The downloaded file is a portable copy of saved collection/scouting data, not an account-login credential. Cloud records remain in **Netlify Blobs**, and unfinished scan work remains in that browser's **IndexedDB**; this change does not migrate records to a relational database or add server background scans. Downloads are manual backups, not scheduled offsite snapshots or point-in-time recovery. Keep a completed JSON file outside the browser and test importing it into a separate test account before relying on it as your only recovery copy.

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

Install dependencies and start a development environment:

```sh
npm install
npx netlify dev
```

Connect the project to an appropriate Netlify development site for Gateway-backed testing. Site-wide Blobs stores are shared across deploy contexts: use a separate test site or mocked stores for destructive tests. Automated tests in this repository use mocks and do not write production data.

Deploy with `public` as the publish directory and `netlify/functions` as the functions directory; `netlify.toml` already defines these. Netlify AI Gateway requires an eligible site with AI features enabled and a production deployment. Its Anthropic integration supplies `ANTHROPIC_API_KEY` and `ANTHROPIC_BASE_URL` to server functions. No provider key belongs in frontend code.

| Environment variable | Default / purpose |
| --- | --- |
| `VHS_AI_MODEL` | `claude-sonnet-5-5`: everyday identification, independent counting, enrichment and estimates |
| `VHS_AI_THOROUGH_MODEL` | `claude-opus-5-5`: careful mode and the conditional verification pass |
| `ANTHROPIC_API_KEY` | Supplied by Gateway, or a server-side credential for a separately configured local evaluation |
| `ANTHROPIC_BASE_URL` | Gateway's Anthropic-compatible endpoint when using Gateway |
| `OMDB_API_KEY` | Optional site-wide OMDb key; `OMDB_KEY`, `omdb` and `OMDB` are also supported |

Users can also save an OMDb key in Settings. Model choices are controlled on the server. Overrides must support the structured-output and adaptive-thinking request used by the shared AI helper; selecting an arbitrary provider/model name in these environment variables is not a provider switch.

Each model call has a bounded deadline below the synchronous function limit. Identification is capped at 48 seconds; the initial independent count has 20 seconds, and an independent stronger recount has 30 seconds. Everyday identification uses low effort, while careful identification uses medium effort. A quick transient provider error may receive one retry inside the same call budget. Timeouts, invalid JSON and truncated model output are surfaced instead of silently retried. The conditional verification call is a separate HTTP request, so a difficult photo may take considerably longer than one initial call.

References: [Netlify AI Gateway](https://docs.netlify.com/build/ai-gateway/overview/), [Netlify Blobs conditional writes](https://docs.netlify.com/build/data-and-storage/netlify-blobs/), [function configuration](https://docs.netlify.com/build/functions/configuration/), [Claude structured outputs](https://platform.claude.com/docs/en/build-with-claude/structured-outputs).

## API

Authenticated routes use the session cookie and JSON requests/responses. Legacy `Authorization: Bearer <token>` remains supported. Browser requests pin the expected non-secret session marker with `X-VHS-Session`; cookie mutations require a matching `Origin`.

| Route | Contract |
| --- | --- |
| `POST /api/auth/signup`, `/login`, `/logout`; `GET /api/auth/me` | Account and session management |
| `PATCH /api/auth/profile` | `{displayName}`; update the current account profile |
| `POST /api/auth/password`, `/recovery`, `/logout-all` | Confirm `currentPassword` to change password (`newPassword`), replace the recovery key, or revoke every session |
| `POST /api/auth/reset` | `{email,recoveryCode,newPassword}`; recover access, revoke older sessions and return a new recovery key |
| `GET /api/tapes` | Owned collection |
| `POST /api/tapes` | Single item or `{tapes:[...]}`, maximum 100; stable `clientId` enables safe retries. Returns `{tapes,failedCount,failedClientIds,failures}` |
| `PATCH /api/tapes/:id`; `DELETE /api/tapes/:id` | Update or delete an owned tape |
| `POST /api/scan` | `{image:dataURL,mode:'fast'|'thorough',sourceId,verificationContext?}`; returns title drafts, evidence, confidence, format, counts, warnings and verification status |
| `POST /api/enrich` | `{items:[{title,year}]}`, maximum 25; optional film details |
| `GET /api/scouts`; `GET /api/scouts/:id` | List summaries or a full private scout list |
| `POST /api/scouts` | `{clientId,name,items,photos:[{id,name}]}`; stable list/item IDs merge new entries safely, maximum 1000 items per list |
| `PATCH /api/scouts/:id` | `{name?,items?:[{clientId,title?,year?,format?,edition?,artist?,visual?,estimate?,estimateFor?,purchasedTapeId?}]}`, maximum 100 item updates; estimates include their evaluated `{title,year,format,edition,artist}` as `estimateFor` |
| `DELETE /api/scouts/:id` | Delete a scout list; purchased collection records remain |
| `POST /api/value` | `{title,format,year?,artist?,edition?,packaging?,barcode?,sealed?,condition?}`; conservative AI estimate with nullable prices and `liveComps:false` |
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

Tests cover strict AI responses, independent counting, one-pass verification, cancellation/recovery, malformed images, partial saves, lost acknowledgements, concurrent retries, preservation of edits, account isolation, scout merges and format-aware valuation. Backup tests additionally exercise private cover access, schema/type/checksum rejection, malicious fields and paths, concurrent restore retries, original date preservation, atomic multi-part scouts, and a full cross-account export/restore/export round trip through the browser orchestration and server handlers. Account tests cover recovery, cookie authentication, session revocation and concurrent updates. Mock tests do not measure visual recognition accuracy or live Gateway availability.

`scripts/evaluate-scan.mjs` evaluates a supplied local photograph against the ground truth in `tests/scan-fixtures.json`. It never creates library or scout records. Check an image without making a paid call:

```sh
node scripts/evaluate-scan.mjs --fixture rotated-spines --image /absolute/path/photo.png --dry-run
```

For an explicitly authorized live model evaluation, provide the appropriate server-side environment and omit `--dry-run`. With a linked Netlify development environment, use `VHS_EVAL_IMAGE=/absolute/path/photo.png VHS_EVAL_FIXTURE=rotated-spines netlify dev:exec node scripts/evaluate-scan.mjs`; environment options avoid the Netlify CLI consuming evaluator flags. Use `--out /absolute/path/report.json` to retain the evaluation report. Fixtures include rotated spines, rotated covers and a mixed shelf. The mixed-shelf fixture has partial VHS ground truth and excluded non-VHS titles; it is not a complete count benchmark. User photographs are not committed to this repository.

Live Gateway checks on the three supplied photographs produced mixed results: the eight-spine image returned all eight exact titles with the correct count in 9.2 seconds; the nine-cover image returned count nine and eight exact titles in 27.2 seconds, while the sticker-obscured “Walking Across Egypt” remained a medium-confidence correction. On the dense mixed shelf, the initial reading returned 42 candidates in 23.5 seconds and the independent counter reported 59, six uncertain. The stronger pass timed out after 48 seconds, so the initial readings were retained with required review (71.6 seconds total). All 11 known VHS titles in the partial reference set appeared and none of the five excluded DVD title groups appeared, but the fixture has no complete ground-truth count: this is not a dense-shelf accuracy pass. Closer photos of smaller sections remain necessary for that case.

Before production acceptance, run representative **5-photo and 10-photo batches** on a real phone, with a manually counted/title-labeled reference set. Include glare, rotated spines, unreadable boxes, duplicate copies, overlapping photographs, mixed DVD/CD shelves and non-English titles. Check these outcomes:

- Every physical VHS tape is either identified correctly or visibly unresolved; no unreadable tape quietly disappears. Clearly non-VHS media are excluded.
- Independent count mismatches, failed verification and unknown formats remain visible until reviewed. Repeated physical copies stay separate; overlapping appearances are highlighted for a person to resolve.
- Reload, tab navigation, sign-out/sign-in, network loss, rate limits and a lost save response preserve completed work and do not duplicate confirmed records.
- Scout-only saves never affect owned totals. Retrying a purchase creates at most one owned record for that scout item.
- Measure first-result latency, full-batch latency, correction rate, false-positive rate and model cost. Choose acceptable thresholds against the actual devices, network and collection before claiming performance targets.

There is **no guarantee of 100% recognition or uninterrupted execution**. Independent passes can share mistakes. Browser drafts are not server background jobs or cross-device photo storage: closing the browser stops processing, clearing browser data removes drafts, and device storage limits can prevent persistence. Source images are sent through the Gateway to the model for processing. Inventory loading still fetches the full account collection, so much larger catalogs will eventually need server-side pagination or a queryable database.
