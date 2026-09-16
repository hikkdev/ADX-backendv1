import fs from 'fs';
import os from 'os';
import path from 'path';
import { gzipSync } from 'zlib';
import { describe, expect, it } from 'vitest';
import { decryptToPlain, encryptPlain, parseBackupKey } from '../crypto';
import { dumpDate, dumpName, isDumpName, olderThan } from '../dump-names';
import { databaseNameOf, redactUrl, withDatabase } from '../database-url';
import { isProductionDatabase } from '../scratch-db';

const KEY_HEX = 'a'.repeat(64);

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'adx-backup-'));
}

describe('parseBackupKey', () => {
  it('accepts 64 hex characters', () => {
    expect(parseBackupKey(KEY_HEX)).toHaveLength(32);
  });

  it('accepts 32 bytes as base64', () => {
    expect(parseBackupKey(Buffer.alloc(32, 7).toString('base64'))).toHaveLength(32);
  });

  it('refuses anything else without echoing it', () => {
    expect(() => parseBackupKey('short')).toThrow(/BACKUP_KEY/);
    expect(() => parseBackupKey(undefined)).toThrow(/BACKUP_KEY/);
    try {
      parseBackupKey('not-the-key-value-please');
    } catch (err) {
      expect(String(err)).not.toContain('not-the-key-value-please');
    }
  });
});

describe('encryptPlain / decryptToPlain', () => {
  it('round-trips a dump byte for byte', async () => {
    const dir = tmpDir();
    const plain = path.join(dir, 'plain.dump');
    const sealed = path.join(dir, 'sealed.dump.enc');
    const back = path.join(dir, 'back.dump');
    const payload = Buffer.from('PGDMP fake custom-format dump '.repeat(5000));
    fs.writeFileSync(plain, payload);

    const key = parseBackupKey(KEY_HEX);
    await encryptPlain(plain, sealed, key);
    // Header + ciphertext + tag: nothing of the dump survives in the clear.
    const sealedBytes = fs.readFileSync(sealed);
    expect(sealedBytes.subarray(0, 4).toString()).toBe('ADXB');
    expect(sealedBytes.length).toBeGreaterThan(4 + 1 + 12 + 16);
    expect(sealedBytes.includes(Buffer.from('fake custom-format dump'))).toBe(false);

    await decryptToPlain(sealed, back, key);
    expect(fs.readFileSync(back).equals(payload)).toBe(true);
  });

  it('refuses a tampered file and a wrong key', async () => {
    const dir = tmpDir();
    const plain = path.join(dir, 'plain.dump');
    const sealed = path.join(dir, 'sealed.dump.enc');
    fs.writeFileSync(plain, gzipSync(Buffer.from('hello')));
    const key = parseBackupKey(KEY_HEX);
    await encryptPlain(plain, sealed, key);

    const bytes = fs.readFileSync(sealed);
    bytes[bytes.length - 20] = (bytes[bytes.length - 20] ?? 0) ^ 0xff;
    fs.writeFileSync(sealed, bytes);
    await expect(decryptToPlain(sealed, path.join(dir, 'x'), key)).rejects.toThrow();

    await encryptPlain(plain, sealed, key);
    await expect(decryptToPlain(sealed, path.join(dir, 'y'), parseBackupKey('b'.repeat(64)))).rejects.toThrow();
  });

  it('refuses a file that is not a sealed dump', async () => {
    const dir = tmpDir();
    const notOurs = path.join(dir, 'random.bin');
    fs.writeFileSync(notOurs, Buffer.alloc(64, 1));
    await expect(decryptToPlain(notOurs, path.join(dir, 'z'), parseBackupKey(KEY_HEX))).rejects.toThrow(/not a sealed ADX dump/);
  });
});

describe('dump names', () => {
  it('names a dump by its UTC instant, sortable and file-safe', () => {
    const name = dumpName(new Date('2026-09-12T02:00:05Z'));
    expect(name).toBe('2026-09-12T02-00-05Z.dump.enc');
    expect(isDumpName(name)).toBe(true);
    expect(dumpDate(name)?.toISOString()).toBe('2026-09-12T02:00:05.000Z');
  });

  it('ignores anything else in the folder', () => {
    expect(isDumpName('notes.txt')).toBe(false);
    expect(dumpDate('notes.txt')).toBeNull();
  });

  it('rotates on the name, not on storage metadata', () => {
    const now = new Date('2026-10-20T00:00:00Z');
    expect(olderThan('2026-09-12T02-00-05Z.dump.enc', 35, now)).toBe(true);
    expect(olderThan('2026-09-16T02-00-05Z.dump.enc', 35, now)).toBe(false);
    expect(olderThan('notes.txt', 35, now)).toBe(false);
  });
});

describe('database urls', () => {
  const url = 'postgresql://adx_user:s3cret-pw@ep-x-pooler.ap-southeast-1.aws.neon.tech/adx?sslmode=require';

  it('reads the database name off the path', () => {
    expect(databaseNameOf(url)).toBe('adx');
    expect(databaseNameOf('postgresql://u:p@h:5432/')).toBeNull();
    expect(databaseNameOf('not a url')).toBeNull();
  });

  it('swaps the database, keeping host, credentials and query', () => {
    const scratch = withDatabase(url, 'adx_drill');
    expect(databaseNameOf(scratch)).toBe('adx_drill');
    expect(scratch).toContain('s3cret-pw@ep-x-pooler');
    expect(scratch).toContain('sslmode=require');
  });

  it('E7-2: the production guard refuses the same name, and fails closed on a URL it cannot read', () => {
    expect(isProductionDatabase(withDatabase(url, 'adx_drill'), url)).toBe(false);
    expect(isProductionDatabase('postgresql://u:p@other-host/adx', url)).toBe(true);
    // Cannot tell: refuse.
    expect(isProductionDatabase('not a url', url)).toBe(true);
    expect(isProductionDatabase('postgresql://u:p@h:5432/', url)).toBe(true);
    expect(isProductionDatabase(withDatabase(url, 'adx_drill'), 'not a url')).toBe(true);
    expect(isProductionDatabase(withDatabase(url, 'adx_drill'), 'postgresql://u:p@h:5432/')).toBe(true);
  });

  it('redacts the password and host out of tool output', () => {
    const line = 'pg_dump: error: connection to server at "ep-x-pooler.ap-southeast-1.aws.neon.tech" failed for user adx_user password s3cret-pw';
    const out = redactUrl(line, url);
    expect(out).not.toContain('s3cret-pw');
    expect(out).not.toContain('ep-x-pooler');
    expect(out).toContain('[redacted]');
  });
});
