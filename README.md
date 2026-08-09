# 📼 VHS Vault

A mobile-first VHS collection inventory tracker, built to run entirely on **Netlify**. Made for collectors who buy, sell, and trade tapes at swap meets — a garage full of tapes, in your pocket.

## Features

- **Photo scanning is the main way in** — snap a photo of 1 tape or 20 (covers, spines, or a whole table) and Claude vision, via **Netlify AI Gateway**, counts the tapes, reads every title, and flags anything it's unsure about. You confirm/edit the list, then the app looks up full film details for each tape.
- **Four ways to add tapes**: photo scan, type a title, paste a list (one per line), or import a CSV with column mapping.
- **Film metadata**: year, director, actors, genre, runtime, MPAA rating, plot, IMDb rating — from OMDb when you add a free API key (real posters too), with AI filling gaps otherwise. Tapes without posters get generated retro VHS box art.
- **Dealer fields on every tape**: price paid, asking price, sold price + date, condition, edition (big box, ex-rental…), storage location, barcode, notes, status (For Sale / On Hold / Keeper / Sold).
- **Two library layouts**: a visual cover grid and a compact list — plus search, status filters, and sorting by title, year, or price.
- **Stats**: collection value, amount invested, sales revenue and profit, breakdowns by genre, decade, and director.
- **Sales tab**: every sold tape with per-item and total profit.
- **CSV export** of the whole library.
- **User accounts**: email + password signup, sessions stored server-side. Each user's library is private.
- **iOS-native design**: large titles, tab bar, sheets, segmented controls, grouped lists, dark mode, safe-area aware, installable as a home-screen app.

## Stack

| Piece | Choice |
| --- | --- |
| Hosting | Netlify (static `public/` + Functions) |
| Database | Netlify Blobs (zero-config, per-site) |
| AI | Anthropic Claude via Netlify AI Gateway (zero-config in Functions) |
| Movie data | OMDb (optional, per-user API key) with AI fallback |
| Frontend | Vanilla ES modules, no build step |
| Auth | scrypt-hashed passwords + bearer session tokens in Blobs |

## Deploy

1. Push this repo to GitHub and create a Netlify site from it (or `netlify deploy`). Build settings are in `netlify.toml` — publish dir `public/`, functions in `netlify/functions/`.
2. Deploy to production once. On credit-based Netlify plans, **AI Gateway activates automatically** — the functions pick up `ANTHROPIC_API_KEY`/`ANTHROPIC_BASE_URL` with no configuration. (AI usage bills against your Netlify credits.)
3. That's it. Optionally:
   - Set an OMDb API key environment variable as a site-wide default for posters/ratings — any of `OMDB_API_KEY`, `OMDB_KEY`, `omdb`, or `OMDB` works — and/or let each user save their own key in Settings (free at [omdbapi.com](https://www.omdbapi.com/apikey.aspx)). Settings shows whether OMDb is connected, and "Get Posters & Details for All Tapes" retroactively fills covers and metadata for tapes added before the key existed.
   - Set `VHS_AI_MODEL` to override the default model (`claude-opus-5`).

Local dev: `npm install && npx netlify dev` (linked to a Netlify site so Blobs and AI Gateway work).

## API

All endpoints are Netlify Functions with custom paths, JSON in/out, `Authorization: Bearer <token>`:

- `POST /api/auth/signup` · `POST /api/auth/login` · `POST /api/auth/logout` · `GET /api/auth/me`
- `GET/POST /api/tapes` (POST accepts `{tapes: [...]}` batches up to 100) · `PATCH/DELETE /api/tapes/:id`
- `POST /api/scan` — `{image: dataURL}` → `{count, tapes: [{title, year, confidence, visual, edition}], notes}`
- `POST /api/enrich` — `{items: [{title, year}]}` (≤25) → OMDb + AI metadata per item
- `GET/PUT /api/settings` — per-user OMDb key

## Notes

- Photos are resized client-side (max 1568px JPEG) before upload; nothing is stored — the image is only sent to the AI for identification.
- The scan endpoint asks the model to work in two passes (count first, then identify each tape) and to report per-tape confidence, which the UI surfaces as ✅ high / 🟡 medium / 🔴 low badges for review before anything is saved.
