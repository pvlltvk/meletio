import {resolve} from 'node:path';
import {isIP} from 'node:net';
import {prepare} from '../scripts/prepare';
import {createApplication} from './app';

async function main() {
  const host = process.env.HOST || '127.0.0.1';
  if (!isIP(host) && host !== 'localhost') throw new Error('HOST must be an IP address or localhost.');
  const port = Number(process.env.PORT || '4173');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be between 1 and 65535.');
  const secure = process.env.SECURE_COOKIES || 'false';
  if (!['true', 'false'].includes(secure)) throw new Error('SECURE_COOKIES must be true or false.');
  const defaultHost = host.includes(':') ? `[${host}]` : host;
  const origin = process.env.APP_ORIGIN || `http://${defaultHost}:${port}`;
  const content = prepare(resolve(__dirname, '../..'));
  const application = createApplication({databasePath: resolve(process.env.DATABASE_PATH || 'data/meletio.sqlite'), content, origin, secureCookies: secure === 'true'});
  application.server.on('error', error => {
    console.error('Server failed:', error.message);
    void application.close().finally(() => { process.exitCode = 1; });
  });
  application.server.listen(port, host, () => console.log(`Meletio: ${origin}`));
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => {
    void application.close().catch(() => { process.exitCode = 1; });
  });
}

void main().catch(error => {
  console.error(error instanceof Error ? error.message : 'Could not start Meletio.');
  process.exitCode = 1;
});
