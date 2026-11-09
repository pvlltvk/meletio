import {createServer, type IncomingMessage, type ServerResponse} from 'node:http';
import {readFile} from 'node:fs/promises';
import {dirname, join, resolve} from 'node:path';
import {Auth, sessionCookie} from './auth';
import {openDatabase} from './database';
import {Training} from './training';
import {ContentRepository} from './content';
import {Imports} from './imports';
import {ContentMutations} from './content-mutations';
import {ApiError, fields, invalid, stringField, type Content} from './types';

export interface ApplicationOptions {
  databasePath: string;
  content: Content;
  origin: string;
  secureCookies?: boolean;
  now?: () => number;
  stagingRoot?: string;
}

function mediaResponse(request: IncomingMessage, response: ServerResponse, media: {bytes: Uint8Array; mime: string; size: number} | undefined) {
  if (!media) throw new ApiError(404, 'not_found', 'Media not found.');
  const bytes = Buffer.from(media.bytes);
  const size = bytes.length;
  const headers: Record<string, string | number> = {'Content-Type': media.mime, 'Cache-Control': 'no-store', 'Accept-Ranges': 'bytes'};
  let start = 0;
  let end = size - 1;
  let status = 200;
  if (request.headers.range !== undefined) {
    const match = /^bytes=([0-9]*)-([0-9]*)$/.exec(request.headers.range);
    let valid = Boolean(match && (match[1] || match[2]));
    if (match) {
      if (match[1]) {
        start = Number(match[1]);
        end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
        valid = valid && Number.isSafeInteger(start) && Number.isSafeInteger(end) && start < size && start <= end;
      } else {
        const suffix = Number(match[2]);
        start = Math.max(0, size - suffix);
        valid = valid && Number.isSafeInteger(suffix) && suffix > 0 && size > 0;
      }
    }
    if (!valid) {
      response.writeHead(416, {...headers, 'Content-Range': `bytes */${size}`, 'Content-Length': 0});
      response.end();
      return;
    }
    status = 206;
    headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
  }
  headers['Content-Length'] = Math.max(0, end - start + 1);
  response.writeHead(status, headers);
  response.end(request.method === 'HEAD' ? undefined : bytes.subarray(start, end + 1));
}

function readBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  if (request.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') throw new ApiError(415, 'unsupported_type', 'Send JSON requests.');
  return new Promise((resolve, reject) => {
    let size = 0;
    let finished = false;
    const chunks: Buffer[] = [];
    const timer = setTimeout(() => {
      finished = true;
      request.resume();
      reject(new ApiError(408, 'request_timeout', 'Request timed out. Try again.'));
    }, 15000);
    request.on('data', (chunk: Buffer) => {
      if (finished) return;
      size += chunk.length;
      if (size > 16384) {
        finished = true;
        clearTimeout(timer);
        reject(new ApiError(413, 'body_too_large', 'Request is too large.'));
        chunks.length = 0;
      } else {
        chunks.push(chunk);
      }
    });
    request.on('error', error => { clearTimeout(timer); finished = true; reject(error); });
    request.on('aborted', () => { clearTimeout(timer); finished = true; reject(new ApiError(400, 'interrupted_request', 'Request interrupted.')); });
    request.on('end', () => {
      clearTimeout(timer);
      if (finished) return;
      finished = true;
      try {
        const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!body || typeof body !== 'object' || Array.isArray(body)) invalid();
        resolve(body as Record<string, unknown>);
      } catch (error) {
        reject(error instanceof ApiError ? error : new ApiError(400, 'invalid_json', 'Request must contain valid JSON.'));
      }
    });
  });
}

export function createApplication(options: ApplicationOptions) {
  const origin = new URL(options.origin);
  if (!['http:', 'https:'].includes(origin.protocol) || origin.origin !== options.origin || origin.username || origin.password) throw new Error('APP_ORIGIN must be an HTTP(S) origin without a path.');
  const db = openDatabase(options.databasePath);
  const now = options.now || Date.now;
  const auth = new Auth(db, now);
  const content = new ContentRepository(db, options.content);
  const training = new Training(db, content, now);
  const contentMutations = new ContentMutations(db, content, now);
  const imports = new Imports(db, content, options.stagingRoot || join(dirname(options.databasePath), 'import-staging'), now);
  const webRoot = resolve(__dirname, '../../web');
  const publicFiles: Record<string, [string, string]> = {
    '/': ['index.html', 'text/html; charset=utf-8'],
    '/index.html': ['index.html', 'text/html; charset=utf-8'],
    '/preview.html': ['preview.html', 'text/html; charset=utf-8'],
    '/style.css': ['style.css', 'text/css; charset=utf-8'],
    '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
    '/learning.js': ['learning.js', 'text/javascript; charset=utf-8'],
    '/data.js': ['data.js', 'text/javascript; charset=utf-8']
  };

  function json(response: ServerResponse, status: number, value: unknown) {
    response.writeHead(status, {'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store'});
    response.end(JSON.stringify(value));
  }

  const server = createServer((request, response) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'same-origin');
    response.setHeader('X-Frame-Options', 'DENY');
    void (async () => {
      const url = new URL(request.url || '/', options.origin);
      const path = url.pathname;
      const method = request.method || 'GET';
      if (!path.startsWith('/api/')) {
        const file = publicFiles[path];
        if (method !== 'GET' || !file) throw new ApiError(404, 'not_found', 'Page not found.');
        let bytes = await readFile(resolve(webRoot, file[0]));
        if (file[0] === 'index.html') bytes = Buffer.from(bytes.toString('utf8').replace('<script src="data.js"></script>', ''));
        response.writeHead(200, {'Content-Type': file[1], 'Cache-Control': 'no-store'});
        response.end(bytes);
        return;
      }
      if (!['GET', 'POST', 'HEAD'].includes(method)) throw new ApiError(405, 'method_not_allowed', 'Method not allowed.');
      if (method === 'POST' && request.headers.origin !== options.origin) throw new ApiError(403, 'invalid_origin', 'Request origin is not allowed.');
      const cookie = request.headers.cookie;
      if (method === 'POST' && (path === '/api/auth/register' || path === '/api/auth/login')) {
        const body = await readBody(request);
        auth.throttle(request.socket.remoteAddress || 'unknown');
        const user = await auth.credentials(body, path.endsWith('/register'));
        response.setHeader('Set-Cookie', sessionCookie(auth.createSession(user, cookie), Boolean(options.secureCookies)));
        json(response, path.endsWith('/register') ? 201 : 200, {user});
        return;
      }
      const expectedUser = request.headers['x-meletio-user'];
      if (expectedUser !== undefined && auth.user(cookie).id !== expectedUser) throw new ApiError(401, 'account_changed', 'Your account changed in another tab. Log in again to continue.');
      if (path === '/api/imports/uploads' && method === 'POST') {
        const user = auth.user(cookie);
        json(response, 201, await imports.upload(user.id, request));
        return;
      }
      const body = method === 'POST' ? await readBody(request) : {};
      if (path === '/api/auth/logout' && method === 'POST') {
        if (Object.keys(body).length) invalid('Unexpected request field.');
        auth.revoke(cookie);
        response.setHeader('Set-Cookie', sessionCookie('', Boolean(options.secureCookies)));
        json(response, 200, {ok: true});
        return;
      }
      const user = auth.user(cookie);
      const compact = url.searchParams.get('format') === 'compact';
      const deckMatch = /^\/api\/decks\/([a-zA-Z0-9-]{1,128})$/.exec(path);
      const contentMatch = /^\/api\/decks\/([a-zA-Z0-9-]{1,128})(?:\/words\/([a-zA-Z0-9-]{1,128}))?\/(rename|edit|delete)$/.exec(path);
      const mediaMatch = /^\/api\/media\/([a-zA-Z0-9-]{1,128})$/.exec(path);
      const importMatch = /^\/api\/imports\/([a-zA-Z0-9-]{1,128})(?:\/(preview|commit|cancel|media\/([0-9]{1,10})))?$/.exec(path);
      if (path === '/api/auth/me' && method === 'GET') json(response, 200, {user});
      else if (path === '/api/decks' && method === 'GET') json(response, 200, content.list(user.id, url.searchParams.get('cursor') ?? undefined));
      else if (deckMatch && method === 'GET') json(response, 200, {deck: content.deck(user.id, deckMatch[1]), source: content.source(user.id, deckMatch[1])});
      else if (contentMatch && method === 'POST') {
        const [, deckId, wordId, action] = contentMatch;
        if ((wordId && action === 'rename') || (!wordId && action === 'edit')) throw new ApiError(404, 'not_found', 'Endpoint not found.');
        json(response, 200, contentMutations.mutate(user.id, deckId, wordId, action, body));
      }
      else if (mediaMatch && ['GET', 'HEAD'].includes(method)) mediaResponse(request, response, content.media(user.id, mediaMatch[1]));
      else if (path === '/api/imports/current' && method === 'GET') json(response, 200, imports.current(user.id, url.searchParams.get('requestId')));
      else if (path === '/api/imports/current/cancel' && method === 'POST') {
        fields(body, ['requestId']);
        json(response, 200, imports.cancelCurrent(user.id, body.requestId));
      }
      else if (importMatch) {
        const [, id, operation, entryId] = importMatch;
        if (method === 'GET' && !operation) json(response, 200, imports.inspect(user.id, id));
        else if (['GET', 'HEAD'].includes(method) && entryId) mediaResponse(request, response, imports.stagedMedia(user.id, id, entryId));
        else if (method === 'POST' && operation === 'preview') json(response, 200, imports.preview(user.id, id, body));
        else if (method === 'POST' && operation === 'commit') json(response, 200, imports.commit(user.id, id, body));
        else if (method === 'POST' && operation === 'cancel') { fields(body, []); json(response, 200, imports.cancel(user.id, id)); }
        else throw new ApiError(405, 'method_not_allowed', 'Method not allowed.');
      }
      else if (path === '/api/training' && method === 'GET') json(response, 200, training.current(user.id, stringField(url.searchParams.get('deckId'), 'learning set'), compact));
      else if (path === '/api/training' && method === 'POST') json(response, 201, training.mutate(user.id, 'start', undefined, body, compact));
      else if (path === '/api/results' && method === 'GET') json(response, 200, {results: training.results(user.id, stringField(url.searchParams.get('deckId'), 'learning set'))});
      else {
        const match = /^\/api\/training\/([a-zA-Z0-9-]{1,128})(?:\/(answer|advance|retry|snapshot|answers))?$/.exec(path);
        if (!match) throw new ApiError(404, 'not_found', 'Endpoint not found.');
        if (method === 'GET' && !match[2]) json(response, 200, {attempt: training.owned(user.id, match[1], compact)});
        else if (method === 'GET' && match[2] === 'snapshot') json(response, 200, {snapshot: training.snapshot(user.id, match[1])});
        else if (method === 'GET' && match[2] === 'answers') json(response, 200, training.history(user.id, match[1], url.searchParams.get('cursor') ?? undefined));
        else if (method === 'POST' && ['answer', 'advance', 'retry'].includes(match[2])) json(response, 200, training.mutate(user.id, match[2], match[1], body, compact));
        else throw new ApiError(405, 'method_not_allowed', 'Method not allowed.');
      }
    })().catch(error => {
      if (response.headersSent) { response.end(); return; }
      if (error instanceof ApiError) {
        if (error.status === 429) response.setHeader('Retry-After', '5');
        request.resume();
        json(response, error.status, {error: {code: error.code, message: error.message}});
      }
      else {
        console.error('Request failed:', error instanceof Error ? error.name : 'Error');
        json(response, 500, {error: {code: 'internal_error', message: 'Could not complete the request. Please try again.'}});
      }
    });
  });
  server.requestTimeout = 120000;
  server.headersTimeout = 10000;
  let closed = false;
  return {server, close: async () => {
    if (closed) return;
    closed = true;
    await imports.close();
    if (server.listening) await new Promise<void>((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
      server.closeAllConnections();
    });
    db.close();
  }};
}
