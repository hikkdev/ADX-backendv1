import { describe, expect, it } from 'vitest';
import { readZip, zipFiles } from '../zip';

/** The hand-written zip container — G6 (Q104): round-trips, and the signatures are where a reader expects them. */
describe('zipFiles', () => {
  it('writes an archive whose entries read back byte for byte', () => {
    const json = JSON.stringify({ profile: { name: 'Asha Rao', mobile: '+919845012210' }, orders: [1, 2, 3] });
    const archive = zipFiles(
      [
        { name: 'adx-data-export.json', data: json },
        { name: 'README.txt', data: Buffer.from('What is in this file — ünïcödé too.\n', 'utf8') },
      ],
      new Date(2026, 8, 14, 10, 30, 0),
    );
    expect(archive.readUInt32LE(0)).toBe(0x04034b50);
    expect(archive.readUInt32LE(archive.length - 22)).toBe(0x06054b50);
    expect(archive.readUInt16LE(archive.length - 22 + 10)).toBe(2);

    const entries = readZip(archive);
    expect(entries.map((e) => e.name)).toEqual(['adx-data-export.json', 'README.txt']);
    expect(entries[0]!.data.toString('utf8')).toBe(json);
    expect(entries[1]!.data.toString('utf8')).toBe('What is in this file — ünïcödé too.\n');
  });

  it('compresses: a repetitive file is smaller inside than out', () => {
    const big = 'a'.repeat(50_000);
    const archive = zipFiles([{ name: 'a.txt', data: big }]);
    expect(archive.length).toBeLessThan(big.length / 10);
    expect(readZip(archive)[0]!.data.toString()).toBe(big);
  });

  it('handles an empty archive and an empty entry', () => {
    expect(readZip(zipFiles([]))).toEqual([]);
    const entries = readZip(zipFiles([{ name: 'empty.txt', data: '' }]));
    expect(entries[0]!.data.length).toBe(0);
  });
});
