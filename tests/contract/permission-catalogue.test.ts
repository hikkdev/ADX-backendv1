import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { PERMISSIONS, isPermission } from '../../src/shared/auth/permissions';

/**
 * Every permission id named anywhere in `src` must exist in the catalogue.
 *
 * A permission is a string, and a string that does not match anything fails
 * silently — the guard simply never passes, or the role simply never grants.
 * This walks the source for anything shaped like an id and checks it, so a
 * typo is a red test rather than a support ticket six weeks later.
 */

const SRC = path.join(__dirname, '..', '..', 'src');

/** Where the ids are written: the two guards, the role seeds, the catalogue itself. */
const CALL_SITES = [
  /requirePermission\(([^)]*)\)/g,
  /hasPermission\([^,]+,\s*('[^']+'|"[^"]+")/g,
  /missingPermissions\([^,]+,\s*\[([^\]]*)\]/g,
];

/** `<group>.<tier-or-capability>` — lower-case, dot-separated, no spaces. */
const ID_SHAPED = /^[a-z][a-z0-9]*(?:\.[a-z0-9]+)+$/;

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'generated' ? [] : sourceFiles(full);
    return entry.isFile() && full.endsWith('.ts') && !full.endsWith('.d.ts') ? [full] : [];
  });
}

function idsIn(source: string): string[] {
  const found: string[] = [];
  for (const pattern of CALL_SITES) {
    for (const match of source.matchAll(pattern)) {
      const args = match[1] ?? '';
      for (const literal of args.matchAll(/'([^']+)'|"([^"]+)"/g)) {
        const id = literal[1] ?? literal[2] ?? '';
        if (ID_SHAPED.test(id)) found.push(id);
      }
    }
  }
  return found;
}

describe('the permission catalogue covers every id the code names', () => {
  const files = sourceFiles(SRC);

  it('finds the source tree (fails loudly if the walk breaks)', () => {
    expect(files.length).toBeGreaterThan(200);
  });

  it('has no id referenced in src that the catalogue does not define', () => {
    const unknown: string[] = [];
    for (const file of files) {
      for (const id of idsIn(fs.readFileSync(file, 'utf8'))) {
        if (!isPermission(id)) unknown.push(`${path.relative(SRC, file)}: ${id}`);
      }
    }
    expect(unknown).toEqual([]);
  });

  it('finds at least the ids this lot introduced, so the scan is not vacuous', () => {
    const referenced = new Set(files.flatMap((file) => idsIn(fs.readFileSync(file, 'utf8'))));
    expect(referenced).toContain('system.impersonate');
    expect(referenced).toContain('hr.documents.view');
  });

  it('keeps every catalogue id in `<group>.<name>` shape', () => {
    for (const id of PERMISSIONS) expect(id, id).toMatch(ID_SHAPED);
  });
});
