import {createHash, randomUUID} from 'node:crypto';
import {mkdirSync, readFileSync, writeFileSync, rmSync, statSync, readdirSync, createWriteStream, realpathSync} from 'node:fs';
import type {IncomingMessage} from 'node:http';
import {join, relative, resolve, sep} from 'node:path';
import type {DatabaseSync} from 'node:sqlite';
import {transaction} from './database';
import {ContentRepository} from './content';
import {ApiError, fields, invalid, stringField} from './types';
import {inspectPackageInChild} from './import-worker';
import {extractField} from './import-html';

type Parsed = Awaited<ReturnType<typeof inspectPackageInChild>>;
type Media = Parsed['media'][number];
interface Stage {id: string; owner_id: string; request_id: string; archive_hash: string | null; directory: string; status: string; expires_at: number; created_at: number; preview_json: string | null; error: string | null}
interface Source {sourceDeckId: string; noteTypeId: string; includeChildren: boolean; mapping: {term: string; meaning: string; image: string | null; audio: string | null}; termLang: string; meaningLang: string; termDir: string; meaningDir: string}
interface Existing {id: string; source_guid: string; source_modified: number; content_hash: string; term: string; meaning: string; image_media_id: string | null; audio_media_id: string | null; sort_order: number; local_term: string | null; local_meaning: string | null; deleted_at: number | null}
interface ImportedDeck {id: string; title: string; revision: number; source_json: string; last_package_hash: string}
interface Candidate {guid: string; modified: number; term: string; meaning: string; image: Media | null; audio: Media | null; retainedImageId?: string | null; retainedAudioId?: string | null; hash: string; action: 'added' | 'updated' | 'unchanged' | 'older' | 'conflicting'; wordId: string; resetLocal?: boolean}
interface MediaReport {total: number; images: number; audio: number; resizedImages: number; withoutImage: number; withoutAudio: number; unselectedImages: number; unselectedAudio: number; missingFiles: number; unsupportedFiles: number; oversizedFiles: number}
interface Report {added: number; updated: number; unchanged: number; skipped: number; conflicting: number; older: number; retained: number; warnings: string[]; issues: {guid: string; message: string}[]; media?: MediaReport; localEdits?: number; locallyDeleted?: number; restored?: number}
interface Preview {previewId: string; source: Source; title: string; destinationDeckId: string | null; expectedRevision: number; candidates: Candidate[]; report: Report; practiceAvailable: boolean; samples: unknown[]; repairMedia?: boolean; replaceLocalChanges?: boolean}

export const importLimits = {uploadBytes: 100 * 1024 * 1024, unpackedBytes: 128 * 1024 * 1024, mediaBytes: 512 * 1024, notes: 2000, expiresInSeconds: 1800};
const active = "status IN ('uploading','inspecting','ready')";
const reservation = importLimits.uploadBytes + importLimits.unpackedBytes + 16 * 1024 * 1024;
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const notFound = () => new ApiError(404, 'not_found', 'Import not found.');

function language(value: unknown) {
  const tag = stringField(value, 'language', 64);
  if (!/^[A-Za-z]{2,8}(?:-[A-Za-z]{4})?(?:-(?:[A-Za-z]{2}|[0-9]{3}))?(?:-(?:[A-Za-z0-9]{5,8}|[0-9][A-Za-z0-9]{3}))*$/.test(tag)) invalid('Use a valid language tag.');
  try { Intl.getCanonicalLocales(tag); } catch { invalid('Use a valid language tag.'); }
  return tag;
}

function directorySize(path: string): number {
  try { return readdirSync(path, {withFileTypes: true}).reduce((size, file) => size + (file.isDirectory() ? directorySize(join(path, file.name)) : statSync(join(path, file.name)).size), 0); }
  catch { return 0; }
}

export class Imports {
  private controllers = new Map<string, AbortController>();
  private pending = new Set<Promise<unknown>>();
  private closed = false;
  private timer: ReturnType<typeof setInterval>;

  constructor(private db: DatabaseSync, private content: ContentRepository, private root: string, private now: () => number) {
    mkdirSync(root, {recursive: true, mode: 0o700});
    // An interrupted process cannot still own its uploads or parser children.
    db.prepare("UPDATE import_stages SET status = 'failed', error = 'Upload interrupted. Try again.' WHERE status IN ('uploading','inspecting')").run();
    const closed = db.prepare("SELECT * FROM import_stages WHERE status IN ('failed','expired','cancelled','committed')").all() as unknown as Stage[];
    for (const stage of closed) this.removeDirectory(stage);
    this.cleanup();
    this.timer = setInterval(() => this.cleanup(), 60000);
    this.timer.unref();
  }

  private removeDirectory(stage: Stage) {
    const local = relative(resolve(this.root), resolve(stage.directory));
    if (local && local !== '..' && !local.startsWith('..' + sep) && !local.startsWith(sep)) rmSync(stage.directory, {recursive: true, force: true});
  }

  private cleanup() {
    const expired = this.db.prepare("SELECT * FROM import_stages WHERE expires_at <= ? AND status NOT IN ('committed','expired','cancelled')").all(this.now()) as unknown as Stage[];
    for (const stage of expired) {
      this.controllers.get(stage.id)?.abort();
      this.db.prepare("UPDATE import_stages SET status = 'expired', preview_json = NULL WHERE id = ?").run(stage.id);
      this.removeDirectory(stage);
    }
  }

  private owned(userId: string, id: string, allowClosed = false): Stage {
    this.cleanup();
    const stage = this.db.prepare('SELECT * FROM import_stages WHERE id = ? AND owner_id = ?').get(id, userId) as Stage | undefined;
    if (!stage) throw notFound();
    if (!allowClosed && ['expired', 'cancelled', 'committed'].includes(stage.status)) throw new ApiError(410, 'expired_import', 'This import is no longer active. Upload the package again.');
    return stage;
  }

  private parsed(stage: Stage): Parsed {
    if (stage.status !== 'ready') throw new ApiError(409, 'import_not_ready', stage.error || 'The package is not ready yet.');
    return JSON.parse(readFileSync(join(stage.directory, 'parsed.json'), 'utf8')) as Parsed;
  }

  private view(stage: Stage) {
    const parsed = stage.status === 'ready' ? this.parsed(stage) : null;
    const sourceChoices = parsed?.sourceChoices || [];
    const identities = parsed?.sourceIdentities || [];
    const owned = parsed ? this.db.prepare(`SELECT d.id, COALESCE(o.title,d.title) AS title, d.revision,
      json_extract(d.source_json,'$.sourceDeckId') AS sourceDeckId, json_extract(d.source_json,'$.noteTypeId') AS noteTypeId
      FROM json_each(?) candidate CROSS JOIN imported_decks d INDEXED BY imported_decks_source LEFT JOIN deck_overrides o ON o.deck_id = d.id
      WHERE d.owner_id = ? AND o.deleted_at IS NULL
      AND json_extract(d.source_json,'$.sourceDeckId') = json_extract(candidate.value,'$.sourceDeckId')
      AND json_extract(d.source_json,'$.noteTypeId') = json_extract(candidate.value,'$.noteTypeId')
      LIMIT 50`).all(JSON.stringify(identities), stage.owner_id) as {id: string; title: string; revision: number; sourceDeckId: string; noteTypeId: string}[] : [];
    const matches: typeof owned = [];
    for (const match of owned) {
      if (Buffer.byteLength(JSON.stringify([...matches, match])) > 128 * 1024) break;
      matches.push(match);
    }
    const saved = stage.preview_json ? JSON.parse(stage.preview_json) as Preview & {committed?: unknown} : null;
    const suggestion = sourceChoices.length === 1 ? sourceChoices[0].suggestion : sourceChoices.length ? null : parsed?.suggestion || null;
    return {uploadId: stage.id, requestId: stage.request_id, status: stage.status, expiresAt: stage.expires_at, limits: importLimits, decks: parsed?.decks || [], noteTypes: parsed?.noteTypes || [], suggestion, sourceChoices, sourceIdentities: identities, matchingDestinations: matches, error: stage.error, preview: stage.status === 'ready' && saved ? this.publicPreview(stage, saved) : null, result: stage.status === 'committed' && saved?.committed ? this.recovered(stage.owner_id, saved.committed) : null};
  }

  private recovered(userId: string, value: unknown) {
    const result = value as {deckId: string; revision: number; report: Report; deleted?: boolean};
    const row = this.db.prepare(`SELECT d.id FROM imported_decks d LEFT JOIN deck_overrides o ON o.deck_id = d.id
      WHERE d.id = ? AND d.owner_id = ? AND o.deleted_at IS NULL`).get(result.deckId, userId);
    return row ? result : {...result, deleted: true};
  }

  current(userId: string, requestId: string | null) {
    this.cleanup();
    const stage = requestId
      ? this.db.prepare('SELECT * FROM import_stages WHERE owner_id = ? AND request_id = ?').get(userId, stringField(requestId, 'request ID', 128)) as Stage | undefined
      : this.db.prepare(`SELECT * FROM import_stages WHERE owner_id = ? AND (${active} OR status = 'committed') ORDER BY created_at DESC, rowid DESC LIMIT 1`).get(userId) as Stage | undefined;
    return stage ? this.view(stage) : {stage: null};
  }

  inspect(userId: string, id: string) { return this.view(this.owned(userId, id)); }

  cancel(userId: string, id: string) {
    const stage = this.owned(userId, id, true);
    if (stage.status === 'committed') throw new ApiError(409, 'already_committed', 'The learning set is already imported.');
    this.controllers.get(id)?.abort();
    this.db.prepare("UPDATE import_stages SET status = 'cancelled', preview_json = NULL WHERE id = ?").run(id);
    this.removeDirectory(stage);
    return {ok: true};
  }

  cancelCurrent(userId: string, requestId: unknown) {
    const key = stringField(requestId, 'request ID', 128);
    const row = this.db.prepare('SELECT id FROM import_stages WHERE owner_id = ? AND request_id = ?').get(userId, key) as {id: string} | undefined;
    return row ? this.cancel(userId, row.id) : {ok: true};
  }

  upload(userId: string, request: IncomingMessage) {
    if (this.closed) throw new ApiError(503, 'shutting_down', 'The application is restarting. Try again shortly.');
    const promise = this.receiveUpload(userId, request);
    this.pending.add(promise);
    void promise.finally(() => this.pending.delete(promise)).catch(() => {});
    return promise;
  }

  private async receiveUpload(userId: string, request: IncomingMessage) {
    this.cleanup();
    if (request.headers['content-type']?.split(';')[0].trim() !== 'application/octet-stream') throw new ApiError(415, 'unsupported_type', 'Upload an .apkg file as binary data.');
    const requestId = stringField(request.headers['x-import-request-id'], 'request ID', 128);
    const filename = stringField(request.headers['x-import-filename'], 'package filename', 256);
    if (!/\.apkg$/i.test(filename) || /(?:^|[/\\])collection\.apkg$/i.test(filename)) invalid('Choose a deck .apkg export, not a collection package.');
    if (Number(request.headers['content-length']) > importLimits.uploadBytes) { request.resume(); throw new ApiError(413, 'upload_too_large', 'The package exceeds the 100 MiB upload limit.'); }
    let stage = this.db.prepare('SELECT * FROM import_stages WHERE owner_id = ? AND request_id = ?').get(userId, requestId) as Stage | undefined;
    if (stage && ['uploading', 'inspecting'].includes(stage.status)) throw new ApiError(409, 'upload_in_progress', 'This upload is still in progress. Check its status.');
    if (stage && stage.status !== 'failed') {
      if (stage.status !== 'ready') throw new ApiError(410, 'expired_import', 'Upload this package again with a new request ID.');
      if (this.controllers.has(stage.id)) throw new ApiError(409, 'upload_in_progress', 'This upload is still in progress. Check its status.');
      const controller = new AbortController();
      this.controllers.set(stage.id, controller);
      try {
        const digest = await this.readUpload(request, null, controller.signal);
        if (digest !== stage.archive_hash) throw new ApiError(409, 'request_conflict', 'Request ID was used for a different package.');
        return this.view(this.owned(userId, stage.id));
      } finally { this.controllers.delete(stage.id); }
    }
    const other = this.db.prepare(`SELECT id FROM import_stages WHERE owner_id = ? AND ${active}`).get(userId);
    if (other) throw new ApiError(409, 'active_import', 'Finish or cancel your current import first.');
    const stages = this.db.prepare(`SELECT * FROM import_stages WHERE ${active}`).all() as unknown as Stage[];
    const used = stages.reduce((size, entry) => size + (entry.status === 'ready' ? directorySize(entry.directory) : reservation), 0);
    if (stages.length >= 2 || used + reservation > 256 * 1024 * 1024) throw new ApiError(429, 'import_busy', 'Finish or cancel another import, then try again.');
    if (!stage) {
      const id = randomUUID();
      stage = {id, owner_id: userId, request_id: requestId, archive_hash: null, directory: join(this.root, id), status: 'uploading', expires_at: this.now() + 1800000, created_at: this.now(), preview_json: null, error: null};
      this.db.prepare('INSERT INTO import_stages VALUES (?, ?, ?, NULL, ?, ?, ?, ?, NULL, NULL)').run(id, userId, requestId, stage.directory, stage.status, stage.expires_at, stage.created_at);
    } else {
      this.removeDirectory(stage);
      this.db.prepare("UPDATE import_stages SET status = 'uploading', error = NULL, expires_at = ? WHERE id = ?").run(this.now() + 1800000, stage.id);
      stage.expires_at = this.now() + 1800000;
    }
    const controller = new AbortController();
    this.controllers.set(stage.id, controller);
    try {
      mkdirSync(stage.directory, {recursive: true, mode: 0o700});
      const archive = join(stage.directory, 'archive.apkg');
      const digest = await this.readUpload(request, archive, controller.signal);
      this.db.prepare("UPDATE import_stages SET archive_hash = ?, status = 'inspecting' WHERE id = ?").run(digest, stage.id);
      const parsed = await inspectPackageInChild(archive, stage.directory, controller.signal);
      if (controller.signal.aborted) throw new ApiError(410, 'cancelled_import', 'Import cancelled.');
      writeFileSync(join(stage.directory, 'parsed.json'), JSON.stringify(parsed), {mode: 0o600});
      this.db.prepare("UPDATE import_stages SET status = 'ready', error = NULL WHERE id = ?").run(stage.id);
      return this.view(this.owned(userId, stage.id));
    } catch (error) {
      const row = this.db.prepare('SELECT status FROM import_stages WHERE id = ?').get(stage.id) as {status: string};
      if (!['cancelled', 'expired'].includes(row.status)) this.db.prepare("UPDATE import_stages SET status = 'failed', error = ? WHERE id = ?").run(error instanceof ApiError ? error.message : 'Could not store or inspect this package. Try again.', stage.id);
      this.removeDirectory(stage);
      throw error;
    } finally { this.controllers.delete(stage.id); }
  }

  private readUpload(request: IncomingMessage, path: string | null, signal: AbortSignal): Promise<string> {
    return new Promise((resolve, reject) => {
      const output = path ? createWriteStream(path, {flags: 'wx', mode: 0o600}) : null;
      const digest = createHash('sha256');
      let size = 0;
      let finished = false;
      const timeout = setTimeout(() => fail(new ApiError(408, 'upload_timeout', 'Upload timed out. Try again.')), 120000);
      const abort = () => fail(new ApiError(410, 'cancelled_import', 'Import cancelled.'));
      function clean() { clearTimeout(timeout); request.setTimeout(0); signal.removeEventListener('abort', abort); }
      function fail(error: Error) {
        if (finished) return;
        finished = true;
        clean();
        output?.destroy();
        request.resume();
        reject(error);
      }
      request.setTimeout(30000, () => fail(new ApiError(408, 'upload_timeout', 'Upload stopped receiving data.')));
      signal.addEventListener('abort', abort, {once: true});
      request.on('aborted', () => fail(new ApiError(400, 'interrupted_upload', 'Upload interrupted. Try again.')));
      request.on('error', fail);
      output?.on('error', fail);
      output?.on('drain', () => request.resume());
      request.on('data', (chunk: Buffer) => {
        if (finished) return;
        size += chunk.length;
        if (size > importLimits.uploadBytes) { fail(new ApiError(413, 'upload_too_large', 'The package exceeds the 100 MiB upload limit.')); return; }
        digest.update(chunk);
        if (output && !output.write(chunk)) request.pause();
      });
      request.on('end', () => {
        if (finished) return;
        const done = () => {
          if (finished) return;
          finished = true;
          clean();
          resolve(digest.digest('hex'));
        };
        if (output) output.end(done); else done();
      });
      if (signal.aborted) abort();
    });
  }

  private source(body: Record<string, unknown>): Source {
    const mapping = body.mapping;
    if (!mapping || typeof mapping !== 'object' || Array.isArray(mapping)) invalid('Choose the note fields.');
    const values = mapping as Record<string, unknown>;
    fields(values, ['term', 'meaning', 'image', 'audio']);
    if (typeof body.includeChildren !== 'boolean') invalid('Choose whether to include child decks.');
    if (!['ltr', 'rtl'].includes(String(body.termDir)) || !['ltr', 'rtl'].includes(String(body.meaningDir))) invalid('Invalid text direction.');
    return {sourceDeckId: stringField(body.sourceDeckId, 'source deck'), noteTypeId: stringField(body.noteTypeId, 'note type'), includeChildren: body.includeChildren, mapping: {term: stringField(values.term, 'term field'), meaning: stringField(values.meaning, 'meaning field'), image: values.image == null ? null : stringField(values.image, 'image field'), audio: values.audio == null ? null : stringField(values.audio, 'audio field')}, termLang: language(body.termLang), meaningLang: language(body.meaningLang), termDir: String(body.termDir), meaningDir: String(body.meaningDir)};
  }

  private matchingSource(userId: string, source: Source) {
    return Boolean(this.db.prepare(`SELECT d.id FROM imported_decks d LEFT JOIN deck_overrides o ON o.deck_id = d.id
      WHERE d.owner_id = ? AND o.deleted_at IS NULL AND json(d.source_json) = json(?) LIMIT 1`).get(userId, JSON.stringify(source)));
  }

  preview(userId: string, id: string, body: Record<string, unknown>) {
    fields(body, ['sourceDeckId', 'noteTypeId', 'includeChildren', 'mapping', 'title', 'termLang', 'meaningLang', 'termDir', 'meaningDir', 'destinationDeckId', 'repairMedia', 'replaceLocalChanges']);
    if (body.repairMedia !== undefined && typeof body.repairMedia !== 'boolean') invalid('Choose whether to restore missing media.');
    const repairMedia = body.repairMedia === true;
    if (body.replaceLocalChanges !== undefined && typeof body.replaceLocalChanges !== 'boolean') invalid('Choose whether to replace local changes.');
    const replaceLocalChanges = body.replaceLocalChanges === true && !repairMedia;
    const stage = this.owned(userId, id);
    const parsed = this.parsed(stage);
    const source = this.source(body);
    const title = stringField(body.title, 'learning set title', 120).trim();
    if (!title) invalid('Enter a learning set title.');
    const destination = body.destinationDeckId == null ? null : stringField(body.destinationDeckId, 'destination');
    const target = destination ? this.db.prepare(`SELECT d.* FROM imported_decks d LEFT JOIN deck_overrides o ON o.deck_id = d.id
      WHERE d.id = ? AND d.owner_id = ? AND o.deleted_at IS NULL`).get(destination, userId) as ImportedDeck | undefined : null;
    if (destination && !target) throw notFound();
    if (repairMedia && !target) invalid('Choose an existing learning set to restore missing media.');
    const identity = (value: Source) => ({...value, mapping: {term: value.mapping.term, meaning: value.mapping.meaning}});
    if (target && (repairMedia ? hash(identity(JSON.parse(target.source_json))) !== hash(identity(source)) : hash(JSON.parse(target.source_json)) !== hash(source))) throw new ApiError(409, 'mapping_changed', 'Use the same source deck, note type, fields and languages when updating this learning set.');
    if (!destination && this.matchingSource(userId, source)) throw new ApiError(409, 'existing_import', 'This selection was imported before. Choose its existing learning set to update.');
    const selectedDeck = parsed.decks.find(deck => deck.id === source.sourceDeckId);
    const model = parsed.noteTypes.find(model => model.id === source.noteTypeId);
    if (!selectedDeck || !model) invalid('Select a source deck and note type from this package.');
    if (selectedDeck.filtered) invalid('Filtered Anki decks cannot be imported. Export the original deck instead.');
    if (model.type !== 0) invalid('Cloze and unsupported note types cannot be imported as vocabulary.');
    if (new Set(model.fields).size !== model.fields.length) invalid('This note type has ambiguous field names.');
    for (const name of Object.values(source.mapping)) if (name !== null && !model.fields.includes(name)) invalid('The selected field is not present in this note type.');
    const wanted = new Set(parsed.decks.filter(deck => deck.id === selectedDeck.id || (source.includeChildren && deck.name.startsWith(selectedDeck.name + '::'))).map(deck => deck.id));
    const notes = parsed.notes.filter(note => note.noteTypeId === model.id && note.deckIds.some(deckId => wanted.has(deckId)));
    if (notes.length > importLimits.notes) throw new ApiError(422, 'too_many_notes', 'Select at most 2,000 notes per learning set.');
    const counts = target ? this.db.prepare(`SELECT COUNT(*) AS total, COUNT(o.deleted_at) AS deleted FROM imported_words w
      LEFT JOIN word_overrides o ON o.word_id = w.id WHERE w.deck_id = ?`).get(target.id) as {total: number; deleted: number} : {total: 0, deleted: 0};
    if (counts.total - counts.deleted > importLimits.notes) throw new ApiError(422, 'content_too_large', 'The resulting learning set exceeds the 2,000-note limit.');
    const visible = target ? this.db.prepare(`SELECT w.*, o.term AS local_term, o.meaning AS local_meaning, o.deleted_at FROM imported_words w
      LEFT JOIN word_overrides o ON o.word_id = w.id WHERE w.deck_id = ? AND o.deleted_at IS NULL ORDER BY w.sort_order, w.id LIMIT ?`).all(target.id, importLimits.notes) as unknown as Existing[] : [];
    const selectedDeleted = target ? this.db.prepare(`SELECT w.*, o.term AS local_term, o.meaning AS local_meaning, o.deleted_at
      FROM json_each(?) selected CROSS JOIN imported_words w JOIN word_overrides o ON o.word_id = w.id
      WHERE w.deck_id = ? AND w.source_guid = selected.value AND o.deleted_at IS NOT NULL LIMIT ?`)
      .all(JSON.stringify(notes.map(note => note.guid)), target.id, importLimits.notes) as unknown as Existing[] : [];
    const existing = [...visible, ...selectedDeleted];
    const old = new Map(existing.map(word => [word.source_guid, word]));
    const report: Report = {added: 0, updated: 0, unchanged: 0, skipped: 0, conflicting: 0, older: 0, retained: 0, warnings: [], issues: [], localEdits: 0, locallyDeleted: counts.deleted, restored: 0};
    const coverage: MediaReport = {total: 0, images: 0, audio: 0, resizedImages: 0, withoutImage: 0, withoutAudio: 0, unselectedImages: 0, unselectedAudio: 0, missingFiles: 0, unsupportedFiles: 0, oversizedFiles: 0};
    report.media = coverage;
    const issue = (guid: string, message: string) => { if (report.issues.length < 100) report.issues.push({guid, message}); };
    const warning = (message: string) => { if (report.warnings.length < 100) report.warnings.push(message); };
    const media = new Map(parsed.media.map(entry => [entry.name, entry]));
    const choose = (names: string[], kind: string, guid: string) => {
      if (names.length > 1) warning(`${guid}: multiple ${kind} references; the first supported file is selected.`);
      for (const name of names) {
        let normalized = name;
        try { normalized = decodeURIComponent(name); } catch {}
        const entry = media.get(name) || media.get(normalized);
        if (!entry || entry.error || !entry.path || !entry.mime?.startsWith(kind + '/') || entry.size > importLimits.mediaBytes) {
          if (!entry) coverage.missingFiles++;
          else if (entry.error?.match(/512|size|limit|large/i) || entry.size > importLimits.mediaBytes) coverage.oversizedFiles++;
          else coverage.unsupportedFiles++;
          warning(`${guid}: ${entry?.error || 'missing or unsupported ' + kind}: ${name}`); continue;
        }
        return entry;
      }
      return null;
    };
    const seen = new Set<string>();
    const candidates: Candidate[] = [];
    const storedHash = (id: string | null) => id ? (this.db.prepare('SELECT sha256 FROM imported_media WHERE id = ? AND owner_id = ?').get(id, userId) as {sha256: string} | undefined)?.sha256 || null : null;
    for (const note of notes) {
      if (seen.has(note.guid)) invalid('The package contains duplicate note identities.');
      seen.add(note.guid);
      const field = (name: string | null) => name === null ? '' : note.fields[model.fields.indexOf(name)] || '';
      const term = extractField(field(source.mapping.term)).text.trim();
      const meaning = extractField(field(source.mapping.meaning)).text.trim();
      if (!term || !meaning || [...term].length > 2000 || [...meaning].length > 2000 || /\{\{c\d+::/.test(term + meaning)) {
        report.skipped++; issue(note.guid, 'Missing/oversized term or meaning, or unsupported cloze content.'); continue;
      }
      const image = choose(extractField(field(source.mapping.image)).images, 'image', note.guid);
      const audio = choose(extractField(field(source.mapping.audio)).audio, 'audio', note.guid);
      const previous = old.get(note.guid);
      if (repairMedia && (!previous || term !== previous.term || meaning !== previous.meaning)) {
        report.skipped++; issue(note.guid, 'Media repair retains existing words and text; this note does not match.'); continue;
      }
      const retainedImageId = repairMedia ? previous?.image_media_id : null;
      const retainedAudioId = repairMedia ? previous?.audio_media_id : null;
      const fingerprint = hash([term, meaning, retainedImageId ? storedHash(retainedImageId) : image?.sha256 || null, retainedAudioId ? storedHash(retainedAudioId) : audio?.sha256 || null]);
      let action: Candidate['action'] = 'added';
      if (previous) action = fingerprint === previous.content_hash ? 'unchanged' : note.modified < previous.source_modified ? 'older' : repairMedia || note.modified > previous.source_modified ? 'updated' : 'conflicting';
      report[action]++;
      if (action === 'older' || action === 'conflicting') { report.skipped++; issue(note.guid, 'This export is older or conflicts with the saved note; the saved content is retained.'); }
      const resetLocal = replaceLocalChanges && Boolean(previous) && action !== 'older' && action !== 'conflicting' && note.modified >= previous!.source_modified;
      candidates.push({guid: note.guid, modified: repairMedia ? previous!.source_modified : note.modified, term, meaning, image, audio, retainedImageId, retainedAudioId, hash: fingerprint, action, wordId: previous?.id || randomUUID(), resetLocal});
      const accepted = action === 'added' || action === 'updated';
      const hasImage = accepted ? Boolean(retainedImageId || image) : Boolean(previous?.image_media_id);
      const hasAudio = accepted ? Boolean(retainedAudioId || audio) : Boolean(previous?.audio_media_id);
      if (!hasImage && note.mediaFields?.images.length && !extractField(field(source.mapping.image)).images.length) coverage.unselectedImages++;
      if (!hasAudio && note.mediaFields?.audio.length && !extractField(field(source.mapping.audio)).audio.length) coverage.unselectedAudio++;
    }
    if (coverage.unselectedImages) warning(`${coverage.unselectedImages} words have pictures outside the selected picture field. Check the field mapping.`);
    if (coverage.unselectedAudio) warning(`${coverage.unselectedAudio} words have recordings outside the selected audio field. Check the field mapping or restore missing media.`);
    report.retained = counts.total - candidates.filter(note => old.has(note.guid)).length;
    const merged = new Map(existing.map(word => [word.source_guid, {id: word.id, term: word.term, meaning: word.meaning, image: word.image_media_id ? `/api/media/${word.image_media_id}` : null, audio: word.audio_media_id ? `/api/media/${word.audio_media_id}` : null}]));
    for (const note of candidates) if (note.action === 'added' || note.action === 'updated') merged.set(note.guid, {id: note.wordId, term: note.term, meaning: note.meaning, image: note.retainedImageId ? `/api/media/${note.retainedImageId}` : note.image ? `/api/media/${randomUUID()}` : null, audio: note.retainedAudioId ? `/api/media/${note.retainedAudioId}` : note.audio ? `/api/media/${randomUUID()}` : null});
    const reset = new Set(candidates.filter(note => note.resetLocal).map(note => note.guid));
    for (const word of existing) {
      if (reset.has(word.source_guid)) {
        if (word.local_term !== null || word.local_meaning !== null || word.deleted_at !== null) report.restored!++;
        if (word.deleted_at !== null) report.locallyDeleted!--;
        continue;
      }
      if (word.deleted_at !== null) { merged.delete(word.source_guid); continue; }
      const effective = merged.get(word.source_guid)!;
      if (word.local_term !== null || word.local_meaning !== null) {
        effective.term = word.local_term ?? effective.term;
        effective.meaning = word.local_meaning ?? effective.meaning;
        report.localEdits!++;
      }
    }
    coverage.total = merged.size;
    coverage.resizedImages = candidates.filter(note => merged.has(note.guid) && (note.action === 'added' || note.action === 'updated') && !note.retainedImageId && note.image?.optimized).length;
    coverage.images = [...merged.values()].filter(word => word.image).length;
    coverage.audio = [...merged.values()].filter(word => word.audio).length;
    coverage.withoutImage = coverage.total - coverage.images;
    coverage.withoutAudio = coverage.total - coverage.audio;
    if (!merged.size && !target) invalid('No usable vocabulary was found.');
    const localTitle = target ? (this.db.prepare('SELECT title FROM deck_overrides WHERE deck_id = ?').get(target.id) as {title: string | null} | undefined)?.title : null;
    const effectiveTitle = localTitle ?? title;
    const serialized = {id: target?.id || randomUUID(), title: effectiveTitle, termLang: source.termLang, meaningLang: source.meaningLang,
      termDir: source.termDir, meaningDir: source.meaningDir, wordCount: merged.size,
      revision: target ? target.revision + 1 : 1, imported: true, editable: true,
      words: [...merged.values()].map(word => ({...word, termLang: source.termLang, meaningLang: source.meaningLang}))};
    if (merged.size > importLimits.notes || Buffer.byteLength(JSON.stringify(serialized)) > 1024 * 1024) throw new ApiError(422, 'content_too_large', 'The resulting learning set exceeds the 2,000-note or 1 MiB text limit.');
    let practiceAvailable = false;
    try {
      const {buildQuestions} = require(resolve(__dirname, '../../web/learning.js')) as {buildQuestions: (words: unknown[]) => unknown[]};
      practiceAvailable = buildQuestions([...merged.values()].map(word => ({...word, termLang: source.termLang, meaningLang: source.meaningLang}))).length > 0;
    } catch {}
    const samples = candidates.filter(note => merged.has(note.guid)).slice(0, 3).map(note => {
      const word = merged.get(note.guid)!;
      const accepted = note.action === 'added' || note.action === 'updated';
      return {guid: note.guid, term: word.term, meaning: word.meaning, action: note.action,
        image: accepted && !note.retainedImageId && note.image ? `/api/imports/${stage.id}/media/${note.image.entryId}` : word.image,
        audio: accepted && !note.retainedAudioId && note.audio ? `/api/imports/${stage.id}/media/${note.audio.entryId}` : word.audio,
        imageName: note.image?.name || null, audioName: note.audio?.name || null};
    });
    const preview: Preview = {previewId: randomUUID(), source, title, destinationDeckId: destination, expectedRevision: target?.revision || 0, repairMedia, replaceLocalChanges, candidates, report, practiceAvailable, samples};
    this.db.prepare('UPDATE import_stages SET preview_json = ? WHERE id = ?').run(JSON.stringify(preview), id);
    return this.publicPreview(stage, preview);
  }

  private publicPreview(stage: Stage, preview: Preview) {
    const title = preview.destinationDeckId ? (this.db.prepare('SELECT title FROM deck_overrides WHERE deck_id = ?').get(preview.destinationDeckId) as {title: string | null} | undefined)?.title ?? preview.title : preview.title;
    return {uploadId: stage.id, previewId: preview.previewId, expiresAt: stage.expires_at, source: preview.source, title, destinationDeckId: preview.destinationDeckId, repairMedia: preview.repairMedia || false, replaceLocalChanges: preview.replaceLocalChanges || false, report: preview.report, samples: preview.samples, practiceAvailable: preview.practiceAvailable};
  }

  private mediaBytes(stage: Stage, media: Media) {
    if (!media.path || !media.mime || !media.sha256) invalid('Missing media.');
    const file = realpathSync(media.path);
    const local = relative(realpathSync(stage.directory), file);
    if (!local || local === '..' || local.startsWith('..' + sep) || local.startsWith(sep)) invalid('Invalid media path.');
    const bytes = readFileSync(file);
    if (bytes.length > importLimits.mediaBytes || createHash('sha256').update(bytes).digest('hex') !== media.sha256) invalid('The staged media changed. Upload again.');
    return {bytes, mime: media.mime, size: bytes.length};
  }

  stagedMedia(userId: string, id: string, entryId: string) {
    const stage = this.owned(userId, id);
    const entry = this.parsed(stage).media.find(media => media.entryId === entryId);
    if (!entry || entry.error || !entry.path) throw notFound();
    return this.mediaBytes(stage, entry);
  }

  commit(userId: string, id: string, body: Record<string, unknown>) {
    fields(body, ['previewId', 'requestId', 'acceptSkipped']);
    const requestId = stringField(body.requestId, 'request ID', 128);
    const previewId = stringField(body.previewId, 'preview ID', 128);
    if (typeof body.acceptSkipped !== 'boolean') invalid('Confirm the import report.');
    const fingerprint = hash([id, previewId, body.acceptSkipped]);
    const receipt = this.db.prepare('SELECT fingerprint, response FROM import_commits WHERE owner_id = ? AND request_id = ?').get(userId, requestId) as {fingerprint: string; response: string} | undefined;
    if (receipt) {
      if (receipt.fingerprint !== fingerprint) throw new ApiError(409, 'request_conflict', 'Request ID was used for another import.');
      return this.recovered(userId, JSON.parse(receipt.response));
    }
    const stage = this.owned(userId, id);
    if (stage.status !== 'ready' || !stage.preview_json) invalid('Preview the package before importing.');
    const preview = JSON.parse(stage.preview_json) as Preview;
    if (preview.previewId !== previewId) throw new ApiError(409, 'stale_preview', 'The preview changed. Review it again.');
    if ((preview.report.skipped || preview.report.warnings.length) && !body.acceptSkipped) invalid('Confirm the skipped notes and media warnings before importing.');
    const response = transaction(this.db, () => {
      const existing = preview.destinationDeckId ? this.db.prepare(`SELECT d.* FROM imported_decks d LEFT JOIN deck_overrides o ON o.deck_id = d.id
        WHERE d.id = ? AND d.owner_id = ? AND o.deleted_at IS NULL`).get(preview.destinationDeckId, userId) as ImportedDeck | undefined : null;
      if ((preview.destinationDeckId && !existing) || (existing?.revision || 0) !== preview.expectedRevision) throw new ApiError(409, 'stale_preview', 'This learning set changed. Preview the package again.');
      if (!existing && this.matchingSource(userId, preview.source)) throw new ApiError(409, 'existing_import', 'This selection was imported before. Choose the existing learning set.');
      const deckId = existing?.id || randomUUID();
      const changed = !existing || preview.report.added + preview.report.updated > 0 || Boolean(preview.report.restored) || existing.title !== preview.title || (preview.repairMedia && hash(JSON.parse(existing.source_json)) !== hash(preview.source));
      const revision = existing ? existing.revision + (changed ? 1 : 0) : 1;
      if (!existing) this.db.prepare('INSERT INTO imported_decks VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(deckId, userId, preview.title, preview.source.termLang, preview.source.meaningLang, preview.source.termDir, preview.source.meaningDir, revision, JSON.stringify(preview.source), stage.archive_hash!, this.now(), this.now());
      const storeMedia = (media: Media | null): string | null => {
        if (!media) return null;
        const found = this.db.prepare('SELECT id FROM imported_media WHERE owner_id = ? AND sha256 = ? AND mime = ?').get(userId, media.sha256!, media.mime!) as {id: string} | undefined;
        if (found) return found.id;
        const value = this.mediaBytes(stage, media);
        const mediaId = randomUUID();
        this.db.prepare('INSERT INTO imported_media VALUES (?, ?, ?, ?, ?, ?)').run(mediaId, userId, media.sha256!, value.mime, value.size, value.bytes);
        return mediaId;
      };
      let order = Number((this.db.prepare('SELECT MAX(sort_order) AS last FROM imported_words WHERE deck_id = ?').get(deckId) as {last: number | null}).last ?? -1) + 1;
      for (const note of preview.candidates) {
        if (note.resetLocal && !preview.repairMedia) this.db.prepare('DELETE FROM word_overrides WHERE word_id = ?').run(note.wordId);
        if (note.action === 'unchanged') {
          if (!preview.repairMedia) this.db.prepare('UPDATE imported_words SET source_modified = MAX(source_modified, ?) WHERE deck_id = ? AND source_guid = ?').run(note.modified, deckId, note.guid);
          continue;
        }
        if (note.action !== 'added' && note.action !== 'updated') continue;
        const image = note.retainedImageId || storeMedia(note.image);
        const audio = note.retainedAudioId || storeMedia(note.audio);
        if (note.action === 'added') this.db.prepare('INSERT INTO imported_words VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(note.wordId, deckId, note.guid, note.modified, note.hash, note.term, note.meaning, image, audio, order++);
        else this.db.prepare('UPDATE imported_words SET source_modified = ?, content_hash = ?, term = ?, meaning = ?, image_media_id = ?, audio_media_id = ? WHERE deck_id = ? AND source_guid = ?').run(note.modified, note.hash, note.term, note.meaning, image, audio, deckId, note.guid);
      }
      this.db.prepare('UPDATE imported_decks SET title = ?, revision = ?, last_package_hash = ?, updated_at = ? WHERE id = ?').run(preview.title, revision, stage.archive_hash!, this.now(), deckId);
      if (preview.repairMedia) this.db.prepare('UPDATE imported_decks SET source_json = ? WHERE id = ?').run(JSON.stringify(preview.source), deckId);
      const current = this.content.deck(userId, deckId);
      if (current.words.length > importLimits.notes || Buffer.byteLength(JSON.stringify(current)) > 1024 * 1024) throw new ApiError(422, 'content_too_large', 'The resulting learning set exceeds its content limit.');
      const result = {deckId, revision, report: preview.report};
      this.db.prepare('INSERT INTO import_commits VALUES (?, ?, ?, ?, ?)').run(userId, requestId, fingerprint, JSON.stringify(result), this.now());
      this.db.prepare("UPDATE import_stages SET status = 'committed', preview_json = ? WHERE id = ?").run(JSON.stringify({committed: result}), stage.id);
      return result;
    });
    this.removeDirectory(stage);
    return response;
  }

  async close() {
    this.closed = true;
    clearInterval(this.timer);
    for (const controller of this.controllers.values()) controller.abort();
    await Promise.allSettled([...this.pending]);
  }
}
