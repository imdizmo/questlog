import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { networkInterfaces } from 'node:os';
import { openDb, NewerDatabaseError } from './db';
import { buildApp } from './app';
import { sweepFilesDir } from './files';
import { startScheduler } from './jobs';
import { deleteWorkspace } from './commands/dangerZone';
import { emailConfig } from './email';
import { loadSecret } from './secret';

const port = Number(process.env.PORT ?? 8780);
const dbPath = process.env.JT_DB ?? 'data/jt.db';
mkdirSync(dirname(resolve(dbPath)), { recursive: true });
const filesDir = resolve(process.env.JT_FILES ?? 'data/files');
// `pnpm start --delete-workspace --confirm "<name>"`: the only way to delete a workspace (README, "Disabling and
// deleting a workspace").
if (process.argv.includes('--delete-workspace')) {
  const at = process.argv.indexOf('--confirm');
  try {
    const r = deleteWorkspace(resolve(dbPath), filesDir, at > 0 ? process.argv[at + 1] : undefined);
    console.log(`The workspace is deleted: database and ${r.removed} attachment(s) removed (${r.missing} already gone).`);
    if (r.refused) console.log(`${r.refused} attachment id(s) pointed outside ${filesDir} and were not touched.`);
    if (r.unknown) console.log(`${r.unknown} other file(s) in ${filesDir} were not the workspace's and were left as they are.`);
    process.exit(0);
  } catch (e) {
    console.error(String((e as Error).message ?? e));
    process.exit(1);
  }
}
mkdirSync(filesDir, { recursive: true });
let db;
try {
  db = openDb(dbPath, process.env.JT_BACKUP_BEFORE_MIGRATE === '1' ? { backupDir: join(dirname(resolve(dbPath)), 'backups') } : {});
} catch (e) {
  if (e instanceof NewerDatabaseError) {
    console.error(e.message);
    process.exit(3);
  }
  throw e;
}
const swept = sweepFilesDir(db, filesDir);
if (swept.tmp || swept.orphans) console.log(`files: removed ${swept.tmp} partial upload(s), ${swept.orphans} orphaned file(s)`);
const email = emailConfig();
const app = buildApp({ db, webRoot: resolve(process.env.JT_WEB ?? 'dist/web'), port, filesDir, email: { ...email, secret: loadSecret(dirname(resolve(dbPath))) } });
const host = process.env.JT_HOST;
await app.listen({ host: host ?? '0.0.0.0', port });
console.log(`QUESTLOG_LISTENING ${port}`);
console.log(`listening on port ${port}`);
if (host) console.log(`  http://${host}:${port}`);
else for (const list of Object.values(networkInterfaces())) {
  for (const i of list ?? []) if (i.family === 'IPv4') console.log(`  http://${i.address}:${port}`);
}
console.log(email.transport === 'smtp' && email.smtp
  ? `email: SMTP via ${email.smtp.host}:${email.smtp.port}${email.smtp.starttls ? ' (STARTTLS)' : ''}, links to ${email.publicUrl}`
  : 'email: log mode, nothing is sent (EMAIL_TRANSPORT=smtp to send)');
const stopScheduler = startScheduler(db, app.hub, { email });
const shutdown = () => { stopScheduler(); void app.close().finally(() => process.exit(0)); };
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.once(sig, shutdown);
// The desktop shell stops the server by closing its stdin.
if (process.env.JT_EXIT_ON_STDIN_CLOSE === '1') {
  let stopping = false;
  const onClose = () => { if (!stopping) { stopping = true; shutdown(); } };
  process.stdin.on('end', onClose);
  process.stdin.on('close', onClose);
  process.stdin.resume();
}
