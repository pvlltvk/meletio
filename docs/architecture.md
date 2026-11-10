# Architecture

A TypeScript/CommonJS server serves an explicit public file allowlist and a vanilla
JavaScript UI. Node built-ins provide HTTP, crypto, SQLite and child processes.
The locked runtime dependencies are yauzl (lazy ZIP reading), htmlparser2
(non-executing HTML/entity parsing) and Sharp (bounded picture optimization).
Node24+ is intended; verification here uses
Node26.13.0, including the emitted CommonJS loading htmlparser2's ESM.

The portable preview embeds demo-only DATA and keeps visit-only progress. The live
app loads owner-scoped catalog metadata after authentication, at most50 entries
and128KiB per page. Selected vocabulary is fetched separately and capped at1MiB.
An API failure never switches the app to the portable demo.

## Accounts and private API

Authentication uses canonical email, asynchronous salted scrypt and opaque session
cookies (HttpOnly, SameSite=Strict, optionally Secure). Only token hashes are stored;
login rotates sessions and logout revokes them. No recovery/email verification is
provided. Exact configured Origin is required for mutations. The browser supplies
its cached user ID; a cookie account mismatch rejects private operations before
accepting uploads or applying changes. Owner checks also cover snapshots, answer
history, staged files and committed media. Private responses use no-store/nosniff.
Media supports authorized GET/HEAD and one byte range for audio seeking.

Routes include auth, paged /api/decks, /api/decks/:id, /api/media/:id,
/api/training and /api/training/:id/{answer,advance,retry,snapshot,answers}, results,
and /api/imports/{uploads,current} plus stage preview/commit/cancel/media endpoints.
Normal JSON bodies are bounded at16KiB/15seconds. Binary upload authentication and
Origin checks run before streaming. The app binds loopback unless configured.

## Private Anki import

Uploads use client-known request IDs so a lost initial response is recoverable.
Staging is private, expires after30minutes and allows one active stage/account,
two process-wide,256MiB total. In-flight space reserves upload+extraction+parser
JSON budgets. Uploads are bounded at100MiB,120seconds wall/30seconds inactivity.
A single parser subprocess runs with128MiB V8 old heap,15seconds wall,16MiB stdout
and64KiB stderr. Abort/timeout/shutdown kills and reaps the child. These are explicit
byte/time bounds; they do not establish a measured process RSS ceiling.

The parser accepts legacy Anki exports with ordinary schema11 SQLite tables and a
JSON media map. Verified legacy2 metadata selects the real collection.anki21 over
Anki's collection.anki2 warning stub. Modern zstd/protobuf exports are rejected
with compatible re-export instructions. It reads copied SQLite read-only with
trusted_schema off, never attaches it to the app database, and rejects unknown
schema variants, views, triggers and virtual tables. ZIP paths, duplicates,
encryption, symlinks, compression, declared/actual sizes and CRCs are checked.
Total unpacked bytes128MiB, collection32MiB, media map2MiB,5000entries,
10000source notes/cards,2000selected notes,64KiB/field,2000characters/term or meaning.

HTML becomes plain text with entities and block breaks. Scripts/styles/templates
are excluded. The first supported image (preferring data-vocab-image) and sound
reference are chosen from mapped fields. No template execution or remote fetch.
Images PNG/JPEG/WebP and audio MP3/WAV/Ogg/M4A/MP4 require signatures and <=512KiB.
Oversized supported pictures up to8MiB/16million pixels are decoded sequentially
inside the parser child and resized without cropping to WebP, max1024px/512KiB.
Sharp uses strict errors, disabled cache, concurrency1 and3second processing
timeouts; the child retains its15second wall limit. Existing smaller media remain
byte-identical. Larger inputs, oversized audio and unsafe/failed images are
reported skips. Source archives remain unchanged. Content-based suggestions
choose populated source/media fields; preview reports picture/audio coverage and
warns when a selected field ignores media elsewhere in the note.

The parser caches source identities and source/model choices. Destination
suggestions use an owner/source identity index and cap matches at50/128KiB.
Preview persists a canonical mapping/report and expected destination revision.
Commit atomically inserts immutable owner-specific media BLOBs, stable GUID words,
content revision and an idempotency receipt. Newer source modifications update;
omitted/older/conflicting notes retain saved content. Updates require the original
mapping. Explicit repairMedia preview permits only image/audio mapping changes,
fills absent media and preserves existing media, text, word identities, ordering,
source timestamps and practice. A repair may fill missing media at equal source
timestamps; older or text-mismatched notes remain unchanged. Repair updates the
canonical media mapping atomically. Receipts replay after stage cleanup and reject changed key input.
Staging files are removed after commit/cancel/expiry and closed stages on startup.

## Vocabulary changes and audio

Schema3 adds deck_overrides, word_overrides and content_mutations. Nullable text
overrides and deletion timestamps preserve base imported rows, GUIDs and source
timestamps/hashes. Current catalog/deck/source/update reads exclude removed
content. Historical owner media and snapshots remain readable. POST rename/delete
and nested word edit/delete routes check owner, Origin, cached account and deck
revision. Effective1MiB edit/rename validation, overrides, revision and owner-scoped
replay receipt share one transaction.

Schema4 adds default_deck_overrides keyed by owner/set and
default_word_overrides keyed by owner/set/word. Bundled content and stable IDs
remain unchanged; effective defaults carry a private revision and editable
capability while imported stays false. The same mutation routes validate and
persist those overlays transactionally. Anki matching/repair still uses imported
source rows only. A hidden last set leaves an empty catalog with import access.

Imports update source rows while local overrides win by default. Explicit
replaceLocalChanges clears overlays only for accepted current source notes;
older/conflicting exports cannot discard edits or restore removed words.
Preview reads at most2000visible rows and2000selected tombstones. Historical
counts use aggregates rather than materializing every old source text. New retries
filter removed IDs from the old snapshot while retaining remaining historical
text/media. Deleted sets block new starts/retries without purging stored practice.

Audio prepares at most one visible target, reuses its player and reports
loading/playing/idle/error. Native play stays inside the manual click. Navigation
and account changes release buffers; stale events/promises are ignored. Private
media remain no-store; no persistent audio cache is added.
Visible Listen text stays stable. A200ms presentation timer shows slow loading
only while still pending; actual playback receives a subtle indicator. Completion
and navigation cancel it, and status announcements do not shift visible layout.

## Durable training and migration

Schema2,3 and4 use additive transactions. Existing users/sessions/attempts
and receipts remain byte-identical; unknown newer versions are rejected. SQLite
uses foreign keys, WAL and a busy timeout; SQL values are parameterized.

New attempts store one immutable dictionary/question-ID snapshot (<=2MiB), small
mutable state and append-only answer rows. Each answer/Continue transaction stores
a constant-size receipt. Compact responses are capped at4KiB; answer history pages
at100entries. The UI loads a snapshot once, hydrates local questions and merges
answer deltas. Historical full JSON attempts/receipts remain readable. Legacy DTOs
are reconstructed under a2MiB cap; large callers must request format=compact.

First answers and Continue are separate transactions, so feedback resumes exactly.
Revision/position checks reject stale writes; same request IDs replay the original
projection. Missed retries use original snapshot content and full-deck distractors.
Current vocabulary can update independently from active/completed practice.
Media BLOBs, snapshots and receipts are retained without automatic compaction.
`make backup BACKUP_PATH=/absolute/external/file.sqlite` opens the source read-only
and uses `VACUUM INTO` to include committed WAL data in a consistent snapshot.
It clears ephemeral import-stage rows only in the snapshot, retains committed
import receipts, checks integrity and atomically publishes a new `0600` file from
a private temporary directory. Canonical parent checks reject project-local
destinations and publication never overwrites an existing file. Source staging
paths are never followed or removed. Restored snapshots require unfinished import
previews to be uploaded again. Password handoff files and staging directories are
not part of the database-only backup. Restore while stopped into a fresh database
directory, preserving the old whole directory and its SQLite sidecars for rollback;
never combine a restored snapshot with old sidecars. A manual backup requires a
stopped copy of the complete data directory, including any SQLite sidecars.
This is a single-process laptop deployment; production scaling, synchronization,
offline queues and retention policy remain separate work.


## Password and registration controls

Registration defaults closed; a strict REGISTRATION=open|closed setting enables
initial account creation when needed. GET /api/auth/config exposes only a no-store
boolean so the login screen can hide registration without blocking existing users.

POST /api/account/password verifies the current password and derives a new salted
scrypt hash outside SQLite transactions. A synchronous transaction rechecks the
current session and credential hash, updates with compare-and-swap and revokes
other sessions. The caller's cookie stays valid. Login also rechecks the verified
hash atomically with new-session issuance, preventing a delayed old-password login
from recreating access after a change. Password requests never use generic
mutation receipts or stored password-body fingerprints. A lost response is shown
as uncertain rather than automatically resubmitted. No new schema tables.

Failure windows allow 5/account and 20/socket-address per 15 minutes. Independent
admission windows allow 60/address and 120 overall credential requests per minute;
two concurrent scrypt derivations remain the limit. Each per-key map holds at
most 1000 entries with expiry and oldest-entry eviction. Successful verification
clears that account's failures without erasing unrelated address failures.
The server uses the socket address and does not trust forwarded headers.
