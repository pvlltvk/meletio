import {spawn} from 'node:child_process';
import {IMPORT_LIMITS, type ParsedPackage} from './import-types';
import {ApiError} from './types';

let parsing = false;

export async function inspectPackageInChild(archivePath: string, stageDirectory: string, signal?: AbortSignal): Promise<ParsedPackage> {
  if (signal?.aborted) throw new ApiError(410, 'cancelled_import', 'Import cancelled.');
  if (parsing) throw new ApiError(429, 'parser_busy', 'Another package is being inspected. Try again shortly.');
  parsing = true;
  try {
    return await new Promise<ParsedPackage>((resolve, reject) => {
      const child = spawn(process.execPath, ['--max-old-space-size=128', __filename, archivePath, stageDirectory], {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {NODE_NO_WARNINGS: '1'}
      });
      const chunks: Buffer[] = [];
      let outputBytes = 0;
      let stderrBytes = 0;
      let failure: Error | null = null;
      const kill = (error: Error) => {
        failure ??= error;
        child.kill('SIGKILL');
      };
      const abort = () => kill(new ApiError(410, 'cancelled_import', 'Import cancelled.'));
      const exit = () => { child.kill('SIGKILL'); };
      const timeout = setTimeout(() => kill(new ApiError(422, 'parser_timeout', 'Package inspection exceeded the 15 second limit. Try a smaller export.')), 15000);
      signal?.addEventListener('abort', abort, {once: true});
      process.once('exit', exit);
      if (signal?.aborted) abort();
      child.on('error', () => { failure ??= new ApiError(503, 'parser_unavailable', 'Package inspection could not start. Try again.'); });
      child.stdout.on('data', (chunk: Buffer) => {
        outputBytes += chunk.length;
        if (outputBytes > IMPORT_LIMITS.parserOutputBytes) {
          kill(new ApiError(422, 'parser_output_limit', 'Package inspection output exceeds the 16 MiB limit. Try a smaller export.'));
        } else chunks.push(chunk);
      });
      child.stderr.on('data', (chunk: Buffer) => {
        stderrBytes += chunk.length;
        if (stderrBytes > 64 * 1024) kill(new ApiError(422, 'parser_error_limit', 'Package inspection produced too many errors. Check the export format.'));
      });
      child.on('close', code => {
        clearTimeout(timeout);
        signal?.removeEventListener('abort', abort);
        process.removeListener('exit', exit);
        if (failure) { reject(failure); return; }
        try {
          const output: unknown = JSON.parse(Buffer.concat(chunks, outputBytes).toString('utf8'));
          if (code !== 0) {
            const message = output && typeof output === 'object' && 'error' in output && typeof output.error === 'string'
              ? output.error.slice(0, 1000) : 'Could not inspect the Anki package. Check the export format.';
            reject(new ApiError(422, 'invalid_package', message));
            return;
          }
          if (!output || typeof output !== 'object' || !('notes' in output) || !('decks' in output) || !('noteTypes' in output) || !('media' in output)
            || !Array.isArray(output.notes) || !Array.isArray(output.decks) || !Array.isArray(output.noteTypes) || !Array.isArray(output.media)) {
            throw new Error('Invalid parser response');
          }
          resolve(output as ParsedPackage);
        } catch {
          reject(new ApiError(422, 'invalid_package', 'Could not inspect the Anki package. Check the export format and size limits.'));
        }
      });
    });
  } finally { parsing = false; }
}

if (require.main === module) {
  const {parsePackage} = require('./import-package') as typeof import('./import-package');
  parsePackage(process.argv[2], process.argv[3]).then(result => {
    process.stdout.write(JSON.stringify(result));
  }, (error: unknown) => {
    process.exitCode = 1;
    const message = error instanceof Error ? error.message.slice(0, 1000) : 'Invalid Anki package';
    process.stdout.write(JSON.stringify({error: message}));
  });
}
