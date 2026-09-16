import { spawn } from 'child_process';
import fs from 'fs';
import { redactUrl } from './database-url';

/**
 * pg_dump and pg_restore as child processes — Lot E (decision 95).
 *
 * The connection string travels as an argument, never through the shell:
 * `spawn` with an argument array does no word-splitting and no `$` expansion,
 * so a password with shell characters is safe and nothing is echoed. What the
 * tool writes to stderr is scrubbed of the host, user and password before it
 * reaches a log or an error message.
 */

const DEFAULT_TIMEOUT_MS = 60 * 60 * 1000;

type RunResult = { code: number; stderr: string };

function run(bin: string, args: string[], url: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`${bin} exceeded ${Math.round(timeoutMs / 60000)} minutes and was stopped`));
    }, timeoutMs);
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < 8000) stderr += chunk.toString();
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      const reason = err.message.includes('ENOENT')
        ? `${bin} is not on PATH (install the PostgreSQL client tools)`
        : redactUrl(err.message, url);
      reject(new Error(reason));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stderr: redactUrl(stderr.trim(), url).slice(0, 2000) });
    });
  });
}

/** A custom-format (`-Fc`) dump of the whole database at `url`, written to `outPath`. */
export async function pgDump(url: string, outPath: string): Promise<void> {
  const result = await run(
    'pg_dump',
    ['--format=custom', '--no-owner', '--no-privileges', '--file', outPath, '--dbname', url],
    url,
  );
  if (result.code !== 0) throw new Error(`pg_dump exited with ${result.code}: ${result.stderr}`);
  const { size } = await fs.promises.stat(outPath);
  if (size === 0) throw new Error('pg_dump produced an empty file');
}

/**
 * Restores a custom-format dump into the database at `url`, dropping what is
 * there first. The target must already exist; `--clean --if-exists` makes a
 * rerun into the same scratch database idempotent.
 *
 * pg_restore exits 1 when it ignored errors on individual objects — an
 * extension the scratch role may not create, an owner that does not exist
 * there — and the data has still landed, so 1 is reported as a warning and
 * the caller proves the result by querying it. Anything else is a failure.
 */
export async function pgRestore(url: string, dumpPath: string): Promise<{ warnings: string | null }> {
  const result = await run(
    'pg_restore',
    ['--no-owner', '--no-privileges', '--clean', '--if-exists', '--dbname', url, dumpPath],
    url,
  );
  if (result.code === 0) return { warnings: null };
  if (result.code === 1) return { warnings: result.stderr || 'pg_restore ignored some errors' };
  throw new Error(`pg_restore exited with ${result.code}: ${result.stderr}`);
}
