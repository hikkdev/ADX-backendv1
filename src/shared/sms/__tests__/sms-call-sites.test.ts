import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { SMS_KINDS } from '../kinds';

/**
 * Lot E (Q128): every SMS names a kind.
 *
 * A free-text send is a DLT rejection waiting to happen, so this walks `src/`
 * for every `sendSms(` call outside the sender itself and checks the call
 * names one of the registered kinds. The check is textual on purpose — a
 * kind that arrives through a variable is a kind the reviewer cannot see.
 */
const SRC = path.resolve(__dirname, '../../..');
/** The one caller whose kind is the template's, not a literal. */
const DISPATCHER = new Set(['modules/notifications/dispatch.service.ts']);

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'generated' || entry.name === '__tests__' || entry.name === 'node_modules') continue;
      walk(full, out);
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
      out.push(full);
    }
  }
  return out;
}

/** The text of each call from `sendSms(` to its matching parenthesis. */
function callsIn(source: string): string[] {
  const calls: string[] = [];
  let from = 0;
  for (;;) {
    const start = source.indexOf('sendSms(', from);
    if (start < 0) break;
    let depth = 0;
    let i = start + 'sendSms'.length;
    for (; i < source.length; i += 1) {
      if (source[i] === '(') depth += 1;
      if (source[i] === ')') {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    calls.push(source.slice(start, i + 1));
    from = i + 1;
  }
  return calls;
}

describe('sendSms call sites', () => {
  const files = walk(SRC).filter((f) => !f.replace(/\\/g, '/').includes('/shared/sms/'));
  const sites = files.flatMap((file) => {
    const source = fs.readFileSync(file, 'utf8');
    if (!/\bsendSms\(/.test(source)) return [];
    // Definitions and imports are not calls.
    return callsIn(source)
      .filter((call) => !/^sendSms\(\s*(input|mobile|to)\s*[:)]/.test(call))
      .map((call) => ({ file: path.relative(SRC, file), call }));
  });

  it('finds the callers (fails loudly if the sender is renamed)', () => {
    expect(sites.length).toBeGreaterThan(0);
  });

  it('names a registered kind on every call', () => {
    const kinds = SMS_KINDS.map((k) => `'${k}'`).join('|');
    const named = new RegExp(`kind:\\s*(${kinds})`);
    for (const site of sites) {
      const file = site.file.replace(/\\/g, '/');
      if (DISPATCHER.has(file)) {
        // The dispatcher sends the template's own `smsKind`, which the
        // template save already checked with `isSmsKind`; the kind is a
        // variable here because this is the one place every template's
        // kind passes through.
        expect(site.call, `${file}: ${site.call.slice(0, 120)}`).toMatch(/kind:\s*smsKind\b/);
        continue;
      }
      expect(site.call, `${file}: ${site.call.slice(0, 120)}`).toMatch(named);
    }
  });
});
