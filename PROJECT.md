# ARC Fuel (formerly CalorieAI) — Project Context

## Overview
**CalorieAI** is an AI-powered daily calorie and macro tracker, built as an installable Progressive Web App (PWA) for use on the owner's (Joe) iPhone via "Add to Home Screen". Users log food in natural language (or by photo) and Claude returns calories + macros. Built for someone doing a **body recomposition** (high-protein focus).

- **Live URL:** https://joejohnston72-dev.github.io/calorieAI/
- **Repo:** https://github.com/joejohnston72-dev/calorieAI
- **Local path:** `/Users/joejohnston/calorieai/`

## Tech Stack
- Vanilla **HTML / CSS / JS** — no framework. **Chart.js** (CDN) for charts.
- **Anthropic API called directly from the browser** (model: Claude Haiku) using header `anthropic-dangerous-direct-browser-access: true`. User's API key stored in `localStorage` (device-local, never backed up).
- All data persisted in **localStorage**.
- **Dark theme**, mobile-first, single-column layout with bottom nav.

## Files
- `index.html` — markup (setup screen + 4 main views)
- `styles.css` — dark theme styling
- `app.js` — all logic (~1000 lines)
- `metabolic.js` — Glycemic Load + GKI logic (loaded BEFORE app.js; shares app.js's globals since both are classic scripts). See "Metabolic tracking" below.
- `sw.js` — service worker (**network-first**, so updates load on reopen)
- `manifest.json` — PWA manifest (relative paths for `/calorieAI/` subpath)
- `icon.svg` — app icon
- `.nojekyll` — tells GitHub Pages to serve files as-is
- `.github/workflows/pages.yml` — GitHub Actions deploy workflow

## Features
- **Food logging:** natural-language text → Claude returns calories + protein/carbs/fat. Also **photo logging** (Claude vision), and **photo + text combined** for best accuracy.
- **4 progress rings:** Calories + Protein (large, the priorities), Carbs + Fat (small).
- **Editable macro targets** (Profile) — user sets custom protein/carbs/fat grams for recomp.
- **Accuracy %** per entry (high=95 / med=80 / low=60) + daily weighted-average badge.
- **Over/under projection** — biases low-confidence entries upward (portions get underestimated).
- **Favourites / Quick Add** chips; **edit-entry modal** (refreshes totals on save); meals **auto-grouped by time of day**.
- **Stats:** BMI, TDEE, 7-day avg, streak, calorie history + macro split + weight charts.
- **Weight tracking**, **Profile**, **Export Data (JSON)**.
- **Metabolic tracking (Glycemic Load + GKI)** — see dedicated section below.
- **Cloud Backup (GitHub Gist):** auto-syncs all data to a private gist after every change; restore on any device with just the token (fixed filename `calorieai-backup.json` means no gist ID to remember). Restore available both on setup screen and in Profile.

## Data Model (localStorage keys)
- `cai_api` — Anthropic API key (device-local, NOT backed up)
- `cai_profile` — `{name, age, sex, height, weight, activity, goalType, customGoal, macroTargets}`
- `cai_logs` — `{ "YYYY-MM-DD": [{id, ts, name, serving, cal, p, c, f, gi, gl, conf, fromPhoto}] }` — `gi` = estimated glycemic index (from the nutrition AI), `gl` = glycemic load = round(gi × carbs ÷ 100)
- `cai_weights` — `[{date:"YYYY-MM-DD", kg}]`
- `cai_favs` — favourite food entries (now also carry `gi`/`gl`)
- `cai_gki` — `[{id, date:"YYYY-MM-DD", ts, glucose, ketones}]` — real blood readings in mmol/L; true GKI = glucose ÷ ketones
- `cai_meta` — `{lastModified}` (drives backup sync / last-write-wins)
- `cai_gist_token`, `cai_gist_id` — cloud backup credentials
- **Cloud backup** (`buildBackupPayload`/`applyBackupPayload`) now includes `gki`; export JSON includes it too.

## Metabolic tracking (Glycemic Load + GKI) — `metabolic.js`
- **Glycemic Load (GL):** the nutrition AI prompt (text + photo) now also returns `glycemic_index` (0–110; 0 for carb-free foods). At log time we store `gi` and compute `gl = round(gi × carbs ÷ 100)` per entry. Shown as a per-food pill in the food log (`glBadgeHTML`), a daily total + zone on the Today "Metabolic" card, and a 14-day daily-GL bar chart in Stats. Zones: per-food low ≤10 / med 11–19 / high ≥20; daily low ≤100 / moderate ≤150 / high >150.
- **GKI (Glucose Ketone Index = glucose ÷ ketones, mmol/L):** supports BOTH real readings and an estimate.
  - *Measured:* "🩸 Log blood reading" modal on the Today card → stored in `cai_gki`; the card shows the latest measured GKI for today when present (badge "measured").
  - *Estimated:* when there's no reading, `estimateGKIForDay(entries, refTs)` derives a rough GKI from the day's carbs + time since the last meal (`estimateGKIRaw`), clearly labelled "estimated". **This is a heuristic, not a clinical value** — deliberately transparent/documented in the file; a real reading always overrides it.
  - Stats has a 14-day GKI chart: solid purple line = measured points, dashed grey = estimated for days with food but no reading. Zones (Seyfried): ≤1 deep / ≤3 high / ≤6 moderate / ≤9 light / >9 not in ketosis.
- **Load order matters:** `metabolic.js` is included before `app.js` in `index.html` so its function declarations exist when app.js's render calls them; it reads app.js's globals (`DB`, `getLogs`, `todayStr`, `afterSave`, `charts`, `last14`, `showToast`, `updateTodayView`) at call time.

## Deployment
- **GitHub Pages via GitHub Actions** (`build_type: workflow`). Pushes to `main` auto-deploy.
- Deploy command: `cd ~/calorieai && git add -A && git commit -m "..." && git push` (git creds cached in macOS Keychain — push works directly).
- Bump `CACHE` const in `sw.js` + `?v=N` query on css/js links in `index.html` when shipping (cache-busting). **Currently v10** (added `metabolic.js` to the SW precache list + the `?v=10` query on css/js).
- GitHub API token retrievable via: `printf "protocol=https\nhost=github.com\n\n" | git credential fill` (user's own token, gist+repo scope) — used to manage Pages via API.

## Critical Gotchas / Lessons Learned
1. **iOS home-screen PWAs have their OWN localStorage**, separate from Safari. **Deleting/reinstalling the app WIPES all data.** This already cost Joe his food logs once. **Never suggest deleting the app.** (This is what motivated Cloud Backup.)
2. **Service worker must be network-first** — the original cache-first SW served stale HTML/JS and blocked all updates. Now network-first: updates load on a normal close-and-reopen.
3. **`let`-scoped module vars** (e.g. `pendingPhoto`) are NOT on `window`; inline `onclick` handlers rely on `function` declarations being global. Matters for testing/debugging.
4. **GitHub Pages now builds via Actions infra.** Joe's account was brand new (created Jun 1 2026) → GitHub auto-disabled Actions ("Actions has been disabled for this user") → Pages silently stopped building and the site 404'd for days. **Resolved Jun 8** when GitHub reinstated Actions; deploy was then triggered via workflow_dispatch. If the site ever mysteriously 404s, check account-level Actions status first.

## Current Status (as of Jun 8 2026)
- **Live and fully working** with all features deployed, including Cloud Backup.
- Joe was given instructions to set up Cloud Backup (create a `gist`-scope token at github.com/settings/tokens → Profile → Cloud Backup → Connect).
- No outstanding bugs.

## ARC integration (Sep 2026)
- **Renamed "ARC Fuel"** (title, manifest, apple-mobile-web-app-title). Repo/URL/localStorage keys unchanged (`/calorieAI/`, `cai_*`).
- **Design:** ARC Slate & Mist tokens (arc/BRANDING.md §5) — Fuel pillar = sand hero, mist-blue primary, Google Sans 400/500/700, Lucide icons, status bar `black`.
- **ARC account sync** (`cloud.js` module + `arcsync.js` classic): same Supabase project/email-OTP auth/`entries` table as ARC. Store `calories`:
  - `YYYY-MM-DD` → `{app, kcal, protein, carbs, fat, goal, proteinGoal, entries, deleted}` — ARC's `getNutritionToday()` reads kcal/goal/protein from this.
  - `cai:profile`/`cai:favs` → `{data, t}` (newest stamp wins, stamps in `cai_stamps`); `cai:weights` (merge by date, `upd` wins); `cai:gki` (union by id).
  - Merge per entry id (newest `upd||ts`), deletes are per-day tombstones (`cai_deleted`). Full sync (launch, resume, online, "Sync now") = pull → merge → push rows whose value differs from the cloud, which heals ARC re-uploading an older row. Debounced push after each save (`scheduleArcPush`, hashes in `cai_pushed`).
- **AI:** when signed in, calls go through ARC's `coach` Edge Function (server key, SSE); the device API key is a fallback only. Needs the function deployed with `ANTHROPIC_API_KEY`.
- **GKI:** estimates show a zone only; numeric GKI only from blood readings (Stats chart = readings only).
- Gist backup kept as "Legacy backup" for restoring old data.
- **Known ARC-side issue:** arc `sw.js` activate deletes every cache that isn't its own (incl. `calorieai-*`) — needs a `startsWith('arc-')` filter. ARC's `getNutritionToday` uses the UTC date.
- SW cache **v13**.
- **ARC component parity (v14):** Today = ARC's layout — weekday title + right meta, Fuel hero (ARC `.next-card` shape in sand) holding the rings and the log input, lavender "Estimate check" coach bubble (only when portions likely under-count), ARC's 3-tile snapshot (streak open/teal · glycemic load + GKI zone, tap to log a reading · Train tile reading ARC's `workout` store for today's session/planned routine, links to ARC), open food-log list. Tabs: Today · Progress · Body · Profile with ARC's active pill + per-pillar colour. Progress = open stats with hairlines, teal headers. CSS block "ARC components" in styles.css mirrors arc/workout/index.html — keep in step.
