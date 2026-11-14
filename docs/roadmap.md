# Roadmap

Meletio is a self-hosted vocabulary trainer: pictures, human pronunciation and
short review lessons, without timers, streaks or rewards. This page lists what is
planned, in priority order. It is a statement of intent, not a schedule; there
are no dates.

See the [README](../README.md) for what works today and
[architecture](architecture.md) for how it is built.

## Status

Early development, version 0.1. The app runs locally and on a home network. It
is not yet ready to be exposed to the internet; milestone 4 covers that.

## Planned

### 1. Authoring API

Create learning sets, add or update words in batches, and upload a picture and a
recording for each word, from scripts and AI agents.

- Personal access tokens, created and revoked in Settings, stored hashed and
  scoped to one account. The browser session cookie and Origin check do not suit
  non-browser clients.
- Uploads keep the media limits and file-signature checks used by the Anki import.
- Writes are idempotent by request ID, so a retried call does not duplicate words.
- Reference and examples in `docs/api.md`.

### 2. Authoring in the app

Create sets and add words in the browser, using the same endpoints. Vocabulary
no longer depends on Anki desktop.

### 3. Recall practice

A second exercise type alongside multiple choice: type the answer, or reveal it
and grade yourself.

### 4. Supported self-hosting

- Container image and a reverse-proxy example with HTTPS.
- Opt-in trusted-proxy client address, so login limits work behind a proxy.
- `Secure` cookies derived from an https `APP_ORIGIN`.
- Content-Security-Policy.
- Private permissions on the database file and its sidecars.
- Scheduled backups.

### 5. Bounded storage

Lesson snapshots keep only the lesson's words and choices. Old receipts and
superseded attempts get a retention policy.

### 6. Better scheduling

Replace the fixed 1/3/7/14/30-day ladder with FSRS, or at least remove the 30-day
cap.

### 7. Export

Export learning sets as CSV or `.apkg`.

### 8. Installable PWA

Web app manifest, offline study, sliding session renewal, and `web/app.js` split
into modules.

## Later

Not scheduled:

- Checks on real iPhones, Safari and VoiceOver.
- Email recovery, email change and account deletion.
- Synchronization between devices and its conflict rules.
- iOS and Android packaging.
- Modern compressed Anki exports and AnkiConnect.

Anki import receives fixes only until milestones 1–4 are done.

## Not planned

- Direct AnkiWeb account access, or writing schedules back to Anki.
- Synthesized speech in place of human recordings.
- Timers, streaks, points or other pressure mechanics.
- Bundling third-party decks or recordings.

## Contributing

Open an issue before starting work on a milestone, so the approach can be agreed
first. `make check build` must pass.
