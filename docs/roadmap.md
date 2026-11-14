# Roadmap and decisions

## Current

Language-agnostic local application: study, gallery, search/details, multiple
choice, results/missed-word retry, durable per-account/per-deck resume and optional
automatic pronunciation. TypeScript backend, SQLite and email/password accounts
are implemented. Private one-way Anki deck import supports compatible exports,
field mapping, images/audio, preview and stable-ID updates. Python has been removed
from build, serving and tests.

Import now starts from file selection with a concise preview and Advanced options.
All signed-in sets support word editing/deletion and set renaming/deletion.
Default-set changes stay private to each account; imported local changes survive
reimport by default. Study has a simpler banner and Listen keeps a steady label
with delayed loading feedback. WAL-safe backup/restore and repeatable external
browser checks are implemented. Physical-device lesson acceptance remains separate.

The vanilla frontend and minimal Quizlet-inspired visual direction remain. No
timers, streak pressure or rewards. Demo content uses original SVG pictures and
no recordings. Human pronunciation remains optional; no speech is synthesized.

## Next product milestones

Reordered after the 2026-11-14 project review: authoring, recall and hosting come
before further import or account work.

1. Authoring API for scripts and AI agents: create learning sets, add or update
   words in batches, and upload a picture and recording per word, so vocabulary
   no longer depends on Anki desktop. Needs personal access tokens created and
   revoked in Settings, because the browser session cookie and Origin check do
   not suit non-browser clients; tokens are stored hashed and scoped to one
   account. Uploads keep the import media limits and signature checks; writes
   stay idempotent by request ID. Documented in `docs/api.md` with examples.
2. Create sets and add words inside the app, using the same endpoints.
3. Add a recall exercise (typed answer or reveal and self-grade) alongside
   multiple choice.
4. Make VPS hosting a supported path: container image, reverse-proxy example with
   HTTPS, an opt-in trusted-proxy client address for the login limits, Secure
   cookies derived from an https `APP_ORIGIN`, a Content-Security-Policy, private
   database file permissions and scheduled backups.
5. Bound storage growth: lesson snapshots keep only the lesson's words and
   choices; add retention for receipts and superseded attempts.
6. Replace the fixed 1/3/7/14/30 ladder with FSRS, or at least remove the 30-day
   cap.
7. Export learning sets (CSV or `.apkg`).
8. Installable PWA with offline study, sliding session renewal, then split
   `web/app.js` into modules.

Later, not scheduled: real iPhone/Safari/VoiceOver checks, email recovery and
account lifecycle, synchronization and conflict semantics, iOS/Android packaging.
Anki import receives fixes only until milestones 1–4 are done.

Current progress is independent application progress. Compatible .apkg import is
implemented; modern compressed exports, AnkiConnect, scheduling and two-way
synchronization remain separate decisions. Direct AnkiWeb account access is outside
the current scope.

Short lessons now select up to10 due/new words and save independent per-word
review dates. Full practice and missed-word retries do not alter those dates.

There is no service worker, installable PWA, native build, offline save queue or
Anki synchronization. React/Capacitor migrations remain future possibilities. Media
licensing, final branding and production security need review before publication
or deployment. No publication or deployment is part of this increment.
