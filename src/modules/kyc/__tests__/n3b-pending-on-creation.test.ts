import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * N3-B (the owner, 14 Sep 2026, verbatim): "the moment a user (advertiser,
 * publisher or partner or agent or employee) creates an account or gets an
 * account at ADX, their KYC automatically becomes pending hence they should
 * be automatically appearing in the KYC Queue in their respective section."
 *
 * The stamp is the schema's: `kycStatus KycStatus @default(PENDING)` on
 * Publisher, Advertiser and PrintPartner, and no creation path writes
 * anything else over it — self sign-up, agent-assisted onboarding, the
 * console's Create, the print partner's creation, the publisher import (which
 * writes PENDING by name). Agents and employees keep no mirror column: their
 * state is derived from the record alone, and a profile with no record is
 * AWAITING_DOCUMENTS by the queue's rule (`shared/kyc-state`) — so every
 * party is in its queue from the moment the account exists.
 */

const ROOT = path.join(__dirname, '..', '..', '..', '..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/** The body of one Prisma model. */
function model(schema: string, name: string): string {
  const match = schema.match(new RegExp(`model ${name} \\{([\\s\\S]*?)\\n\\}`));
  if (!match) throw new Error(`model ${name} not found`);
  return match[1]!;
}

describe('every party is PENDING from the moment the account exists', () => {
  const schema = read('prisma/schema.prisma');

  it.each(['Publisher', 'Advertiser', 'PrintPartner'])('%s.kycStatus defaults to PENDING in the schema', (name) => {
    expect(model(schema, name)).toMatch(/kycStatus\s+KycStatus\s+@default\(PENDING\)/);
  });

  it.each(['AgentProfile', 'Employee'])('%s keeps no mirror column — the queue derives the state from the record, AWAITING_DOCUMENTS with none', (name) => {
    expect(model(schema, name)).not.toMatch(/kycStatus/);
  });

  it.each([
    ['publisher self sign-up, agent onboarding and the console Create', 'src/modules/publishers/prisma-publishers.repository.ts', /create\(data: NewPublisher\) \{[\s\S]*?\n  \},/],
    ['advertiser self sign-up, agent open-account and the console Create', 'src/modules/advertisers/prisma-advertisers.repository.ts', /async function createAdvertiser\([\s\S]*?\n\}/],
    ['print partner creation', 'src/modules/print-partners/prisma-print-partners.repository.ts', /tx\.printPartner\.create\(\{[\s\S]*?\n      \}\)/],
  ])('%s writes no kycStatus over the default', (_label, file, body) => {
    const source = read(file);
    const creation = source.match(body);
    expect(creation, `${file}: creation not found`).not.toBeNull();
    expect(creation![0]).not.toMatch(/kycStatus/);
  });

  it('the publisher import stamps PENDING by name', () => {
    expect(read('src/modules/publishers/import/prisma-publisher-import.repository.ts')).toMatch(/kycStatus: 'PENDING'/);
  });

  it('no creation path anywhere in src writes a kycStatus other than PENDING at creation', () => {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== 'generated' && entry.name !== '__tests__') walk(full);
        } else if (full.endsWith('prisma-') || /prisma-[a-z-]+\.repository\.ts$/.test(entry.name)) files.push(full);
      }
    };
    walk(path.join(ROOT, 'src'));
    expect(files.length).toBeGreaterThan(20);
    const offenders: string[] = [];
    for (const file of files) {
      const source = fs.readFileSync(file, 'utf8');
      // A create with a kycStatus literal that is not PENDING.
      for (const match of source.matchAll(/\.create(?:Many)?\(\{[\s\S]*?\}\)/g)) {
        const literal = match[0].match(/kycStatus:\s*'([A-Z_]+)'/);
        if (literal && literal[1] !== 'PENDING') offenders.push(`${path.relative(ROOT, file)}: ${literal[0]}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
