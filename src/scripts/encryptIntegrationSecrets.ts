/**
 * Cashfree Phase 1 (the owner, 1 Oct 2026: "Go ahead, Encrypt it") — the
 * integrations row's secrets, sealed once the key exists.
 *
 *   npm run integrations:encrypt -- --check    # lists what is plaintext; writes nothing
 *   npm run integrations:encrypt -- --write    # seals every plaintext secret on the row
 *
 * The keys saved on the console's integration cards used to sit in the
 * `AppConfig` row as plain JSON. From Phase 1 every write seals them
 * (`shared/integrations/secret-box.ts`), but a row written before
 * `INTEGRATIONS_ENCRYPTION_KEY` was set still holds plaintext until its
 * section is next saved. This seals the lot in one go.
 *
 * It prints section and field NAMES and their state — PLAINTEXT, SEALED, or
 * UNREADABLE (sealed under another key) — and never a value or a
 * ciphertext. `--write` without a key refuses; it is idempotent (a second
 * run seals nothing); a secret it cannot open is left exactly as it is.
 */
import '../config/load-env';
import { closeDatabase } from '../shared/database';
import { redis } from '../shared/cache';
import { describeIntegrationSecrets, integrationsKey, readStoredIntegrationsRow, sealStoredIntegrationsRow } from '../shared/integrations';

async function main(): Promise<number> {
  const write = process.argv.includes('--write');
  const check = process.argv.includes('--check') || !write;
  const keyPresent = Boolean(integrationsKey());

  const before = describeIntegrationSecrets(await readStoredIntegrationsRow());
  const plaintext = before.filter((row) => row.state === 'PLAINTEXT');
  const unreadable = before.filter((row) => row.state === 'UNREADABLE');

  console.log(`INTEGRATIONS_ENCRYPTION_KEY: ${keyPresent ? 'set' : 'NOT SET'}`);
  console.log(`Secrets on the integrations row: ${before.length} (${before.length - plaintext.length - unreadable.length} sealed, ${plaintext.length} plaintext, ${unreadable.length} unreadable)`);
  for (const row of before) console.log(`  ${row.state.padEnd(10)} ${row.field}`);
  if (unreadable.length > 0) {
    console.log(keyPresent ? 'UNREADABLE fields were sealed under another key; they read as not set until that key is restored or the value is saved again.' : 'Sealed fields cannot be read without the key; they read as not set.');
  }

  if (check && !write) {
    if (plaintext.length > 0) console.log(keyPresent ? 'Run with --write to seal the PLAINTEXT fields.' : 'Set INTEGRATIONS_ENCRYPTION_KEY, then run with --write.');
    return 0;
  }

  if (!keyPresent) {
    console.error('Refusing to write: INTEGRATIONS_ENCRYPTION_KEY is not set. Generate 32 random bytes (base64) and set it first.');
    return 1;
  }
  if (plaintext.length === 0) {
    console.log('Nothing to seal.');
    return 0;
  }
  const after = describeIntegrationSecrets(await sealStoredIntegrationsRow());
  const left = after.filter((row) => row.state === 'PLAINTEXT');
  console.log(`Sealed ${plaintext.length - left.length} field(s); ${left.length} still plaintext.`);
  return left.length === 0 ? 0 : 1;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err: unknown) => {
    // The error's message only — a stack could carry the row.
    console.error('integrations:encrypt failed:', err instanceof Error ? err.message : 'unknown error');
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDatabase().catch(() => undefined);
    redis.disconnect();
  });
