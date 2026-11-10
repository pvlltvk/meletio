# Meletio

A minimal, language-agnostic learning app inspired by Melete, the Greek Muse
associated with practice. Learn with pictures, words and multiple-choice practice.

Meletio now has a TypeScript backend, SQLite storage and separate learner accounts.
Practice, feedback and results survive page reloads and server restarts.

## Run locally

Requires Node.js 26, version 26.13.0 or newer within the 26.x release line, and
npm. `.node-version` pins development and CI to 26.13.0. Older Node.js versions
are not supported. Python is not required.

```sh
npm ci
REGISTRATION=open make serve
```

Open **http://127.0.0.1:4173/** and create an account with an email and a password
of at least 12 characters. Email is an account identifier; no verification email
is sent. Each account has its own progress. Log out to switch learners.

Registration is closed by default. Enable it temporarily for initial account
creation as above, then stop the app and restart with `make serve` to close it.
Existing accounts can log in with registration closed.

Use `make serve PORT=4180` for another port. Without Make:

```sh
npm run build
npm start
```

The server binds to laptop loopback by default. Open the exact origin printed by
the server; using `localhost` instead of `127.0.0.1` needs a matching `APP_ORIGIN`.
Phone access and VPS deployment need separate network/HTTPS configuration.

## Lessons and review

Study offers **Start lesson**: up to 10 words, with due reviews first and new
words filling the remaining places. Each learner and learning set has independent
review dates. Resume keeps the same questions, choices and saved feedback.

A correct lesson answer schedules the next review after 1 day, then 3, 7, 14 and
30 days for consecutive correct reviews, capped at 30 days. A wrong answer resets
that progression and makes the word due in 10 minutes. Each first answer saves
its review date immediately, including when you leave a lesson unfinished.
Intervals are elapsed time from the server's saved answer, rather than midnight.

Study shows due/new counts and the next review time when you are up to date.
**Practice all words** and missed-word retries remain available without changing
review dates. Lessons still use choices from the full learning set; even a
one-word lesson needs enough distinct words and meanings for four choices.

Scheduling starts fresh when this feature is installed; existing practice history
is kept. Editing a term, meaning or language makes that word new for scheduling.
Renaming a set or changing pictures/recordings keeps its dates. A lesson already
in progress keeps its original content, but old answers cannot overwrite dates
for changed or removed words. Scheduling is independent from Anki.

## Practice

- Study, searchable vocabulary, word details and settings.
- Multiple-choice practice with first-answer scoring and feedback.
- Resume the same questions and answer choices, including answered feedback.
- Saved results and retry of only missed words, using the full deck for choices.
- Independent progress per account and learning set; Greek and Arabic demo sets.
- Optional automatic pronunciation after answering, off by default.
- Listen keeps its label steady, with delayed loading feedback and a subtle
  playback indicator. The current recording is prepared and reused for replay.
- Explicit retry for failed saves; a stale tab asks you to reload saved progress.

Starting fresh replaces the active attempt for that learning set. Completed results
remain in SQLite; Study offers the latest completed result. The API also exposes
up to 50 completed summaries per learning set. A save must succeed before the UI
shows accepted feedback or advances. Offline saving and synchronization are not
implemented.

The redistributable demo includes original SVG illustrations and no pronunciation
recordings. Words without audio show “No recording.” Personal media remain
outside this project. Browser audio tests inject a silent WAV only in an isolated
test context; this is not pronunciation or demo content.

## Import from Anki

In Settings, choose **Choose Anki file** and select a deck export (`.apkg`).
In Anki, export with **Include Media** and **Support older Anki versions** enabled.
Modern compressed exports and full collection packages need a compatible re-export.

The importer suggests a populated source deck, note type and media fields from
the actual notes, then prepares a preview. Check the word, picture and recording
totals and samples before confirming. Open import options to change fields,
languages or the destination. Imports are private to the account that imports them.
Selection starts the preview automatically; saving still requires **Import** or
**Update**. Changed exports recognize existing source sets. Extra settings live
under **Advanced options**; limits and guidance live under **Import help**.
Anki schedules, templates and cloze notes are not imported.

- Package: **100 MiB** maximum; **2,000 selected notes** and **1 MiB** of resulting set JSON.
- Each image or audio file: **512 KiB** maximum.
- Images: PNG, JPEG, WebP. Audio: MP3, WAV, Ogg, M4A/MP4 audio; playback depends on device codecs.
- Larger supported pictures are resized to WebP, at most 1024 pixels and 512 KiB.
  Source images must be at most 8 MiB and 16 million pixels; originals stay unchanged.
- Missing, unsupported or unprocessable pictures and oversized audio require replacement or explicit consent to skip.
- HTML becomes plain text; scripts, styles and remote media are never rendered or fetched.

To update, choose the existing learning set with its original field mapping.
Note GUIDs preserve word identities. Newer notes update; omitted notes remain;
older/conflicting changes are reported without overwriting saved content. An
identical reimport leaves the content revision unchanged. If an earlier import
missed media, use **Restore missing media** in the selected set's Settings.
This allows correcting media fields and fills empty media references while keeping
existing words, pictures, recordings, source timestamps and progress. Existing practice and
missed-word retries retain their original content and media.

Temporary uploads expire after 30 minutes. Settings can recover or cancel an
uncertain upload. One active import per account and two overall are allowed,
with one package parser at a time. Direct AnkiWeb login is outside this increment.

## Manage vocabulary

Open a word in any signed-in learning set to **Edit word** or **Delete word**.
In Settings, use **Rename set** or **Delete set**. Deletion requires confirmation.
Changes to the default Greek and Arabic sets are private to your account, and
keep the same set identities and saved practice. Changes survive reloads and
restarts; a stale tab keeps your draft so you can review it before saving again.
The portable preview remains read-only. If you remove every set, Settings still
lets you import vocabulary.

Local edits and deletions survive later Anki updates. Advanced import options can
explicitly replace them with accepted source content; older or conflicting notes
do not silently reset local changes. Set renames remain local. Anki is unchanged.

Word removal affects fresh practice and retries. Existing saved attempts on a
retained set keep their questions and answers. Deleting an entire set hides it
and prevents new practice; stored history/media remain. There is no permanent
purge or archived-set history screen yet.

## Account management

In Settings, choose **Change password** and enter your current password, new
password and confirmation. Passwords must contain at least 12 characters. Saving
keeps this browser signed in and signs out other sessions for the account.

Password inputs clear after submission or navigation. A wrong current password
leaves your session intact. If a connection failure leaves the result uncertain,
there is no automatic retry; sign in with the proposed new password to confirm
whether the change saved.

Login and password changes have bounded failure limits per account and socket
address, separate request-rate limits and a two-hash concurrency cap. Successful
logins do not consume the failed-login allowance. Forwarded client-IP headers
are not trusted by this local server.

## Storage and configuration

Default database: `data/meletio.sqlite`. Keep it to preserve accounts, progress,
imported vocabulary and imported media.
SQLite and generated files are ignored by Git. Configuration uses environment
variables; `.env.example` is a reference, and `.env` is **not** loaded automatically.

For personal use, keep runtime data outside the source folder. For example:

```sh
mkdir -p "$HOME/.local/share/meletio/data"
chmod 700 "$HOME/.local/share/meletio/data"
DATABASE_PATH="$HOME/.local/share/meletio/data/meletio.sqlite" npm start
```

If moving an existing database, stop the app first and move the complete data
directory, including its WAL/SHM sidecars. Active import previews also contain
absolute temporary paths; finish or cancel those previews before moving data.
Keep backups, logs, browser captures and any credentials outside this repository.

| Variable | Default | Purpose |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | Bind IP or localhost |
| `PORT` | `4173` | Listening port |
| `DATABASE_PATH` | `data/meletio.sqlite` | Database path, relative to working directory |
| `APP_ORIGIN` | `http://HOST:PORT` | Exact browser origin allowed to make changes |
| `SECURE_COOKIES` | `false` | Set `true` when serving through HTTPS |
| `REGISTRATION` | `closed` | Allow new accounts only when explicitly set to `open` |

Back up while the app is running with an explicit new file outside the project:

```sh
make backup BACKUP_PATH=/absolute/private-backups/meletio-2026-11-09.sqlite
```

The destination directory must already exist. `DATABASE_PATH` selects a different
source database; it defaults to `data/meletio.sqlite`. The command takes a
consistent SQLite snapshot including committed WAL writes, checks its integrity,
and publishes it with private file permissions. It refuses an existing destination
or a path inside the project, including through a directory symlink. It needs no
new dependency and leaves the running database unchanged.

The snapshot includes accounts, sessions, vocabulary, media and saved practice.
Temporary import stages are removed from the snapshot only; committed import
receipts are retained. Restoring a snapshot requires uploading any unfinished
Anki preview again. Staging directories and password-reset handoff files are not
copied. Database backups contain private account and learning data and must not
be published.

To restore, stop the app and move its complete current database directory,
including any `-wal`/`-shm` sidecars, to a private rollback location first. Create
a fresh private database directory and copy the snapshot to `meletio.sqlite`
there with mode `0600`, then start the app with that `DATABASE_PATH`. Never combine
a restored snapshot with old sidecars or replace the database while it is open.
For a manual folder backup, stop the app and copy the entire database directory;
a live copy of only the main SQLite file may omit recent writes.

Imported media are immutable BLOBs in the same SQLite database, served through
opaque URLs checked against the signed-in owner. Temporary files live in
`import-staging/` beside the database with private permissions. Backups grow with
imports and saved practice; historical media and receipts have no automatic
garbage collection. Keep the entire data directory private.

Passwords use salted scrypt hashes; cookies carry opaque expiring sessions, whose
token hashes are stored in SQLite. Logging out revokes that browser session.
There is no password recovery, email delivery, social login, email change or
account deletion interface yet. Do not use a password you cannot recover from
your own password manager. This release is intended for local development; production deployment
and operational hardening have not been verified.

## Portable preview

After `make build`, open http://127.0.0.1:4173/preview.html or open
`web/preview.html` directly as a file. It embeds the demo content and runs without
a server, accounts or durable progress. The banner identifies it as a preview.
Live API failures never silently switch the app into preview mode.

## Develop and verify

```sh
make check build
```

- `server/`: TypeScript HTTP, SQLite, authentication and training modules.
- `scripts/prepare.ts`: validated media embedding and portable preview builder.
- `web/`: vanilla interface, shared learning/audio core and sample configuration.
- `tests/`: learning, preparation, backend API and browser contracts.
- `docs/`: architecture, verification, content boundaries and roadmap.

`npm run lint` or `make lint` runs ESLint on TypeScript and JavaScript source,
scripts and tests without reformatting the code. `npm run typecheck` runs strict
TypeScript checks. `npm test` compiles and runs Node tests with temporary
databases. API tests need local loopback networking. `make check` includes lint,
types, tests and JavaScript syntax checks. No formatter is configured.
Browser test functions need an available Playwright runner; see
[verification](docs/verification.md) for invocation and recorded evidence.

GitHub Actions runs the same checks, build and isolated process-restart smoke on
pull requests, pushes to `main` and manual dispatch, using only the declared
Node.js version. The workflow does not publish artifacts or deploy the app.

## License and integration

MIT for original code and included SVG demo art; see [LICENSE](LICENSE) and
[content notices](THIRD_PARTY_NOTICES.md). Do not add personal decks, credentials
or third-party recordings without appropriate rights.

Meletio is independent and is not affiliated with or endorsed by Anki or its
maintainers. It does not connect to AnkiWeb accounts or change Anki schedules.
See [roadmap](docs/roadmap.md) for future integration boundaries.
