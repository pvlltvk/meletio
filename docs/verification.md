# Verification

Requires Node.js 26, at least 26.13.0 and below 27, and npm. `.node-version` selects
the exact development/CI version. Older Node.js lines are not supported. Use the
lockfile without upgrading dependencies.

## Commands

```sh
npm ci
make check build
node tests/restart-smoke.js
node tests/source-smoke.js
```

The checks use synthetic fixtures, temporary on-disk SQLite databases and
loopback listeners. They do not require personal decks, recordings or accounts.
ESLint correctness checks, strict TypeScript and JavaScript syntax checks are
included in `make check`; `make lint` runs only lint. No formatter is configured.
The source smoke copies source, lint/version configuration and original demo assets,
installs locked dependencies, checks/builds, and verifies process restart without
generated files or private data. It needs npm registry access unless packages
are cached, plus local loopback access. Temporary fixtures clean themselves up.

## CI and lint

The workflow runs on pull requests, pushes to `main` and manual dispatch. One
Ubuntu job installs the `.node-version` runtime with locked npm dependencies,
then runs `make check build` and `node tests/restart-smoke.js`. It uses pinned
official checkout/setup-node actions, read-only repository permissions, no
persisted checkout credentials, a 15-minute timeout and cancellation of superseded
runs. No secrets, deployment or publishing step is required. A fresh checkout
already verifies the source-only boundary; the fuller source-smoke command is
available locally without duplicating all tests in CI.

The ESLint flat configuration covers server/scripts/tests TypeScript, Node test
JavaScript, browser scripts and the shared learning module. Browser-runner globals
describe the application variables used inside `page.evaluate`; unknown globals
still fail. The shared learning module also rejects shadowed variables. Existing
CommonJS interop, intentional empty catches and explicit `any` in TypeScript test
fixtures are retained. Control-character regex checks are exempted only in the
two import parsers that deliberately reject those characters. No style rules or
formatter are added.

## Repeatable browser session

These browser checks use an external Playwright MCP server, rather than a bundled
npm browser dependency. The required tools are `browser_navigate`,
`browser_run_code_unsafe` (with `filename` support) and `browser_close` from that
server. The configured local Playwright integration supplies Chromium and the
`page` object. `npm ci` alone does not install that integration or a browser.
No new project dependency is needed when using the existing integration.

From the project root, build and start an isolated session:

```sh
npm run build
node dist/scripts/browser-session.js 4194
```

Keep that process running. It creates a fresh temporary SQLite database and four
synthetic Anki exports, including oversized pictures, child decks and a source
update. It starts open and closed registration servers on the selected port
and the next port, sharing only the synthetic database. The JSON manifest
contains both loopback URLs and nine absolute runner paths under ignored `artifacts/browser-*/`. No test account or import is
created in `data/meletio.sqlite`.

Invoke the external tools with structured arguments, using the paths printed by
your process (the suffix changes each run):

```json
{"url":"http://127.0.0.1:4194/"}
```

Pass that to `browser_navigate`. For each entry of the printed `runners` object,
pass its path to `browser_run_code_unsafe`, for example:

```json
{"filename":"/absolute/project/artifacts/browser-SUFFIX/backend-browser-check.js"}
```

The generated wrappers already bind the correct isolated URL and fixture paths;
do not substitute the live Wi-Fi URL. Each result lists passed groups and any
page errors. Run `browser-check`, `backend-browser-check`, `import-browser-check`,
`media-import-browser-check`, `polish-browser-check`,
`polish-recovery-browser-check`, `follow-up-browser-check`,
`account-browser-check` and `lesson-browser-check`. The existing auth
throttle also applies to tests: if repeated runs hit429, stop and start a fresh
session instead of changing the app's limiter. Close the browser with
`browser_close`, then press Ctrl-C in the session terminal. The process removes
its temporary database, exports and generated wrappers. There is no live restore
or live vocabulary mutation in this procedure.

## Coverage and recorded results

The current automated baseline passes 141 Node tests and 55 browser groups
(portable8, account/training9, import7, media3, polish6, recovery2, follow-up6,
account management8, lessons6).
The source-only install/build and process-restart checks also pass.

Coverage includes:

- Salted password hashes, session expiry/revocation, origin/account guards and
  private content/media ownership.
- Closed/configurable registration, strict startup validation, password changes,
  session preservation/revocation, concurrent hash/session races and bounded
  failure/admission limits. Password drafts clear on pagehide and cached restore;
  lost responses do not retry or update a later account.
- Meaningful lint negative probes for undefined/unused/shadowed values, consistent
  Node26 policy, and a pinned least-privilege CI workflow. GitHub execution has
  not been verified because no push or remote setup is authorized.
- Short due-first lessons, server-timed review intervals/resets, partial saves,
  independent account/set/word state, text/language changes, stale snapshots and
  additive schema5 preservation/rollback. Manual practice/retries leave dates
  unchanged. Lesson browser checks cover saved feedback, retry/replay, no-due
  status, stale tabs, four-size/RTL layout and navigation/refresh keyboard focus.
- Authoritative first answers, conflict/replay handling, saved snapshots,
  per-account progress and restart persistence.
- Untrusted archives/SQLite/media, bounded parser workers, image resizing,
  staged import/recovery, stable source updates and preserved local edits.
- Private default-set edits, repeated word IDs across sets, deletion/empty
  catalogs, schema migration preservation and rollback.
- Search locale fallbacks, current-word audio preparation/reuse, delayed loading,
  honest playback state, retry/stop and stale event cancellation.
- Consistent WAL backups, private external destinations, no overwrite, source
  preservation and isolated restoration without stale temporary upload paths.
- Narrow/short/wide layouts, RTL, typography, keyboard focus and reduced motion.

Browser audio fixtures contain silence or stub native playback; they do not
establish pronunciation quality or actual iPhone onset latency. Check changes
on physical iPhone/Safari and with VoiceOver separately. Production hosting,
offline synchronization and constrained-host resource behavior are not covered
by these local checks.
