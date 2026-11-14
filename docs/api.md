# Authoring API

Scripts can create private learning sets, add or update words in batches, and
upload pictures and human recordings. These sets appear in the existing app and
use its normal practice and lesson scheduling.

This API writes **native authored sets**. Anki-imported and default sets retain
their existing browser editing controls. Browser create-set/add-word forms are
a separate roadmap milestone.

## Access tokens

Log in and open **Settings → Manage access tokens**. Give the token a name and
choose **Create token**. Copy the secret immediately: it is displayed once and
cleared on navigation. Listing tokens returns metadata, never their secrets.
If creation has an uncertain result, reopen the controls, revoke the named token
if it exists, and create another. Creation is never automatically retried.

Tokens expire after 90 days; an account can have 20 active tokens. Revoke them
individually in Settings. Changing your password revokes all personal tokens;
logging out affects only the browser session. Treat a token as a secret: it can
read and change your native sets and access your account's uploaded media.

Send `Authorization: Bearer <token>` on `/api/authoring/` requests. A token cannot
log in, change passwords, manage tokens, import Anki files or access training and
results APIs. Tokens are stored as SHA-256 hashes, with a separate public ID.
The server does not accept tokens in query strings.

Non-browser bearer requests may omit `Origin`. A supplied foreign Origin is
rejected on writes. A supplied Authorization header always selects token
authentication; an invalid token never falls back to a browser cookie. A valid
token selects its account even if an unrelated cookie is present. The optional
`X-Meletio-User` header must match that selected account.

The same authoring endpoints accept browser session cookies. Cookie writes
require the exact configured Origin and retain the existing account-header
checks. There is no cross-origin browser API support. This feature does not add
internet deployment hardening; use the existing local/private deployment rules.

## Endpoints

All JSON responses use `Cache-Control: no-store`. Send JSON writes with
`Content-Type: application/json`. IDs are opaque strings: save returned IDs
rather than constructing them. Unknown fields are rejected.

| Method | Path | Request | Response |
| --- | --- | --- | --- |
| GET | `/api/authoring/decks` | Optional `cursor` query parameter | `{uiLanguage,decks,nextCursor}` |
| POST | `/api/authoring/decks` | `{requestId,title,termLang,meaningLang,termDir,meaningDir}` | `{deck}`; HTTP 201 |
| GET | `/api/authoring/decks/:id` | — | `{deck}` including words |
| POST | `/api/authoring/decks/:id/words` | `{requestId,revision,words:[...]}` | `{deckId,revision,words}` |
| POST | `/api/authoring/media` | Raw bytes; `X-Request-Id`, `X-Media-Filename` | `{id,kind,mime,size}`; HTTP 201 |
| GET/HEAD | `/api/authoring/media/:id` | Optional single `Range: bytes=...` | Same-owner immutable media bytes |

Catalog pages contain at most 50 sets and 128 KiB. Follow `nextCursor` until it
is null. Only native sets owned by the authenticated account are included.
Metadata contains `id`, `title`, languages/directions, `wordCount`, `revision`,
`authored: true`, `imported: false`, and `editable: true`.

Set languages are valid language tags, such as `el`, `en`, or `ar`. Directions
must be `ltr` or `rtl`. They are fixed when the set is created. An empty set is
valid; multiple-choice practice still needs four distinct words and meanings.
Rename/delete sets and edit/delete words with the existing app controls.

Each batch word has this shape:

```json
{
  "id": "omit-to-create-or-use-a-returned-word-id-to-update",
  "term": "νερό",
  "meaning": "water",
  "imageMediaId": null,
  "audioMediaId": null
}
```

Omit `id` to create a word. An update requires its existing ID, term, and meaning.
Omitting a word leaves it unchanged. Omitted media fields preserve current media;
null clears a reference; a media ID attaches an upload of the correct kind owned
by the same account. Returned words have stable IDs and browser media URLs.
Use `/api/authoring/media/:id` for bearer downloads; browser `/api/media/:id` URLs
remain cookie protected.

The whole batch succeeds or fails atomically. Duplicate update IDs, unknown or
deleted words, foreign IDs, invalid media, stale revisions and exceeded limits
leave the set unchanged. Browser edits cannot silently mask an accepted API edit.
Changing word text makes it new for review scheduling. Media-only changes retain
review dates. Saved attempts keep their original content and media.

## Retries and revisions

Use a new `requestId` for each intended content write. Retain that ID and the
exact request until its result is known. A successful write and its response
receipt are saved in the same transaction. Repeating the same request replays
the original result, including across server restarts and later set changes.
JSON object-key order does not matter; array order does.

Request IDs are scoped to an account across content writes. Reusing one for
another route, target, body or upload returns HTTP 409 `request_conflict`.
For media, both filename and file bytes are part of the request identity.
Separate new request IDs intentionally create new words, even if their text
matches an existing word.

Batch writes also require the current set `revision`, available from the catalog,
read response, or preceding write. A competing edit returns HTTP 409
`stale_content`. Read the current set, reconcile the change, then submit a new
request ID and revision. Retrying a known-success request keeps its original
revision and ID; receipt replay is checked before current revision validation.

## Limits and media formats

- Batch: 1–100 words, at most 1 MiB of request JSON.
- Set: at most 2,000 visible words and 1 MiB of effective set JSON.
- Title: 120 Unicode code points. Term/meaning: 2,000 each.
- Other JSON requests: 16 KiB. JSON bodies have a 15-second deadline.
- Each upload: at most 512 KiB and a 15-second deadline. Resize larger pictures before upload.
- Images: PNG, JPEG and WebP. Audio: MP3, WAV, Ogg and M4A/MP4 audio.

Send the original filename, including a supported extension, in
`X-Media-Filename`. Filename extensions must match the importer's existing file
signature checks. These checks do not establish full codec/structural validity
or playback support on every device. SVG, HTML and remote URLs are not supported. Use human recordings; speech
generation is outside this API. No remote file is fetched and no
image is processed in the HTTP server. Existing Anki image resizing is unchanged.

Authentication runs before upload consumption and is checked again before a
write commits. Interrupted, timed-out or oversized uploads do not create media
or receipts. Uploaded media are immutable and deduplicated within an account.
Removing a current reference retains bytes for saved historical attempts.
Unattached media and old receipts follow the current retention behavior; they
are not automatically purged.

## Example workflow

Run this in Bash after creating a token in Settings. It uses only synthetic
vocabulary and saves request/response files in a private temporary directory.
For a retry, reuse the saved request file or upload request ID unchanged.

```bash
MELETIO_URL='http://127.0.0.1:4173'
read -rs -p 'Access token: ' MELETIO_TOKEN
printf '\n'
authoring_dir=$(mktemp -d)
chmod 700 "$authoring_dir"

api() {
  local api_path="$1"
  shift
  curl --silent --show-error --fail-with-body --config - \
    "$MELETIO_URL$api_path" "$@" <<EOF
header = "Authorization: Bearer $MELETIO_TOKEN"
EOF
}

node -e 'console.log(JSON.stringify({requestId:crypto.randomUUID(),
  title:"Example Greek",termLang:"el",meaningLang:"en",termDir:"ltr",meaningDir:"ltr"}))' \
  > "$authoring_dir/create.json"
api /api/authoring/decks -H 'Content-Type: application/json' \
  --data-binary @"$authoring_dir/create.json" > "$authoring_dir/set.json"
deck_id=$(node -p 'JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8")).deck.id' \
  "$authoring_dir/set.json")

node -e 'console.log(JSON.stringify({requestId:crypto.randomUUID(),revision:1,
  words:[{term:"νερό",meaning:"water"},{term:"ψωμί",meaning:"bread"},
  {term:"γάτα",meaning:"cat"},{term:"βιβλίο",meaning:"book"}]}))' \
  > "$authoring_dir/words.json"
api "/api/authoring/decks/$deck_id/words" -H 'Content-Type: application/json' \
  --data-binary @"$authoring_dir/words.json" > "$authoring_dir/words-result.json"
api "/api/authoring/decks/$deck_id" > "$authoring_dir/current.json"
```

To upload a picture or recording, save an ID and reuse it on retries:

```bash
media_request_id=$(node -e 'console.log(crypto.randomUUID())')
api /api/authoring/media -H 'Content-Type: application/octet-stream' \
  -H "X-Request-Id: $media_request_id" -H 'X-Media-Filename: picture.png' \
  --data-binary @/absolute/path/picture.png > "$authoring_dir/media.json"

node -e 'const fs=require("node:fs");
  const batch=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
  const media=JSON.parse(fs.readFileSync(process.argv[2],"utf8"));
  const word=batch.words[0];
  console.log(JSON.stringify({requestId:crypto.randomUUID(),revision:batch.revision,
    words:[{id:word.id,term:word.term,meaning:word.meaning,imageMediaId:media.id}]}))' \
  "$authoring_dir/words-result.json" "$authoring_dir/media.json" \
  > "$authoring_dir/attach.json"
api "/api/authoring/decks/$deck_id/words" -H 'Content-Type: application/json' \
  --data-binary @"$authoring_dir/attach.json" > "$authoring_dir/attachment-result.json"
media_id=$(node -p 'JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8")).id' \
  "$authoring_dir/media.json")
api "/api/authoring/media/$media_id" --output "$authoring_dir/downloaded.png"
cmp /absolute/path/picture.png "$authoring_dir/downloaded.png"
unset MELETIO_TOKEN
```

Use the same upload operation with a recording filename, then `audioMediaId` in
a new batch at the current revision. Keep response files and media private,
outside the source repository. Clear `MELETIO_TOKEN` when finished even if you
stop the workflow early.

## Errors and token management

Errors use the existing `{error:{code,message}}` shape. HTTP 400 rejects invalid
fields/IDs/JSON, 401 rejects absent/invalid/expired/revoked credentials or account
changes, 403 rejects unsafe Origin or a forbidden operation, 404 hides unavailable
sets/words/media, 409 reports request/revision conflicts, 413 rejects excessive
request bytes, 415 rejects unsupported request types and 422 rejects effective
content limits. A failed request has no successful replay receipt.

Settings uses the cookie-only account API:

| Method | Path | Input/result |
| --- | --- | --- |
| GET | `/api/account/tokens` | `{tokens:[{id,name,createdAt,expiresAt}]}`; active tokens only |
| POST | `/api/account/tokens` | `{name}` → `{id,name,createdAt,expiresAt,token}`; HTTP 201 |
| POST | `/api/account/tokens/:id/revoke` | `{}` → `{revoked:true}`; idempotent and owner scoped |

Token creation has no request receipt, to avoid retaining the plaintext secret.
Dates are Unix milliseconds. This API has no deletion/purge of stored history,
email recovery or grant to another account.
