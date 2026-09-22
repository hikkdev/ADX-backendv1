import express, { Router } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Q83/Q148 — the console's flow editor.
 *
 * What is pinned: the schema and the flow list are ADMIN reads; a PATCH of
 * one flow leaves the rest of the row alone, keeps `main:previous`, writes
 * the replaced flow as `flows.<key>:v<N>` (five kept), bumps the version,
 * and audits what moved; a body that fails the vocabulary is a 400 and
 * writes nothing; a stale editor is a 409; an enum group is patched the
 * same way; and GET /config prints a version on every flow.
 */

const { repository, audit, settings } = vi.hoisted(() => ({
  repository: { find: vi.fn(), findByKey: vi.fn(), save: vi.fn(), saveByKey: vi.fn(), listByPrefix: vi.fn(), deleteByKey: vi.fn() },
  audit: { logActivity: vi.fn(), auditDiff: vi.fn(() => ({})) },
  settings: { getPlatformSettings: vi.fn(), updatePlatformSettings: vi.fn(), flattenSettings: vi.fn(() => ({})) },
}));

vi.mock('../prisma-app-config.repository', () => ({ prismaAppConfigRepository: repository }));
vi.mock('../../../shared/audit', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../shared/audit')>();
  return { ...actual, ...audit };
});
vi.mock('../platform-settings', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../platform-settings')>();
  return { ...actual, ...settings };
});

import { errorHandler } from '../../../shared/errors';
import { tokenFor } from '../../../shared/testing';
import { buildListingFlow } from '../../../scripts/data/listing-flow';
import { CODE_ONBOARDING_TEMPLATE } from '../../users';
import { configRouter } from '../app-config.routes';
import { getFlow, seedAppConfig } from '../app-config.service';

function app() {
  const instance = express();
  instance.use(express.json({ limit: '2mb' }));
  const api = Router();
  api.use('/config', configRouter);
  instance.use('/api/v1', api);
  instance.use(errorHandler);
  return instance;
}

const admin = tokenFor(['ADMIN'], 'admin-1');
const publisher = tokenFor(['PUBLISHER'], 'pub-1');
const cities = [{ id: 'Bengaluru', title: 'Bengaluru' }];
const listing = () => JSON.parse(JSON.stringify(buildListingFlow(cities))) as ReturnType<typeof buildListingFlow>;
const onboarding = () => JSON.parse(JSON.stringify(CODE_ONBOARDING_TEMPLATE)) as typeof CODE_ONBOARDING_TEMPLATE;

let row: { key: string; value: Record<string, unknown>; updatedAt: Date };

beforeEach(() => {
  vi.clearAllMocks();
  row = {
    key: 'main',
    value: {
      enums: { languages: [{ value: 'en', label: 'English' }] },
      flows: { listing: { ...listing(), version: 3, updatedAt: '2026-09-11T00:00:00.000Z' }, onboarding: onboarding() },
    },
    updatedAt: new Date('2026-09-12T00:00:00.000Z'),
  };
  repository.find.mockImplementation(async () => row);
  repository.findByKey.mockResolvedValue(null);
  repository.listByPrefix.mockResolvedValue([]);
  repository.save.mockImplementation(async (value: Record<string, unknown>) => {
    row = { ...row, value };
    return row;
  });
  repository.saveByKey.mockImplementation(async (key: string, value: object) => ({ key, value, updatedAt: new Date() }));
});

describe('GET /config/schema and GET /config/flows', () => {
  it('are ADMIN reads', async () => {
    expect((await request(app()).get('/api/v1/config/schema')).status).toBe(401);
    expect((await request(app()).get('/api/v1/config/schema').set('Authorization', `Bearer ${publisher}`)).status).toBe(403);
    expect((await request(app()).get('/api/v1/config/flows').set('Authorization', `Bearer ${publisher}`)).status).toBe(403);
  });

  it('the schema is the apps\' vocabulary: hyphenated kinds, Record branches, the ladder\'s step kinds and required columns', async () => {
    const res = await request(app()).get('/api/v1/config/schema').set('Authorization', `Bearer ${admin}`);
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    const kinds = res.body.data.flows.wizard.kinds.map((k: { kind: string }) => k.kind);
    expect(kinds).toHaveLength(23);
    expect(kinds).toEqual(expect.arrayContaining(['selectable-cards', 'geo-point', 'content-stance', 'base-price']));
    expect(res.body.data.flows.onboarding.stepKinds).toEqual(['account-type', 'form', 'kyc-intro', 'capture', 'checklist', 'review', 'agreement']);
    expect(res.body.data.flows.onboarding.requiredKycColumns.INDIVIDUAL).toEqual(['govIdFrontUrl', 'panFrontUrl', 'addressProofUrl', 'selfieUrl', 'selfVideoUrl']);
    expect(res.body.data.enums.entry.value).toContain('string');
  });

  it('the flow list names every key with its version, shape, description and when it moved — the four known keys always (Q126/Q141)', async () => {
    const res = await request(app()).get('/api/v1/config/flows').set('Authorization', `Bearer ${admin}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([
      { key: 'listing', version: 3, updatedAt: '2026-09-11T00:00:00.000Z', label: 'Listing', description: expect.stringContaining('listing wizard'), audience: 'Publishers', shape: 'wizard', stored: true },
      { key: 'onboarding', version: 1, updatedAt: '2026-09-12T00:00:00.000Z', label: 'Onboarding', description: expect.stringContaining('onboarding ladder'), audience: 'Publishers and advertisers', shape: 'ladder', stored: true },
      { key: 'agent-job', version: 0, updatedAt: null, label: 'Agent job', description: expect.stringContaining('A1–A8'), audience: 'Agents', shape: 'steps', stored: false },
      { key: 'employee-intake', version: 0, updatedAt: null, label: 'Employee intake', description: expect.stringContaining('intake ladder'), audience: 'Employees', shape: 'steps', stored: false },
      // LH7: the invite landing's copy per side.
      { key: 'lead-landing', version: 0, updatedAt: null, label: 'Invite landing', description: expect.stringContaining('adx.in/j/<code>'), audience: 'Prospects', shape: 'steps', stored: false },
    ]);
  });

  it('G13-B: a stored audience wins over the code default, a PATCH may set it, and an unknown key has none', async () => {
    row.value = { ...row.value, flows: { ...(row.value['flows'] as object), listing: { ...listing(), audience: 'Publishers only' }, extra: { label: 'Extra', screens: [], branches: {} } } };
    const res = await request(app()).get('/api/v1/config/flows').set('Authorization', `Bearer ${admin}`);
    expect(res.body.data[0]).toMatchObject({ key: 'listing', audience: 'Publishers only' });
    expect(res.body.data.find((flow: { key: string }) => flow.key === 'extra')).toMatchObject({ key: 'extra', audience: null });

    const patched = await request(app())
      .patch('/api/v1/config/flows/onboarding')
      .set('Authorization', `Bearer ${admin}`)
      .send({ ...onboarding(), audience: 'Everyone who signs up' });
    expect(patched.status).toBe(200);
    expect(patched.body.data.audience).toBe('Everyone who signs up');

    const tooLong = await request(app())
      .patch('/api/v1/config/flows/listing')
      .set('Authorization', `Bearer ${admin}`)
      .send({ ...listing(), audience: 'x'.repeat(81) });
    expect(tooLong.status).toBe(400);
  });

  it("a stored description wins over the code's, and the two ladder vocabularies are in the schema", async () => {
    row.value = { ...row.value, flows: { ...(row.value['flows'] as object), listing: { ...listing(), description: 'Ours.' } } };
    const res = await request(app()).get('/api/v1/config/flows').set('Authorization', `Bearer ${admin}`);
    expect(res.body.data[0]).toMatchObject({ key: 'listing', description: 'Ours.' });
    const schema = await request(app()).get('/api/v1/config/schema').set('Authorization', `Bearer ${admin}`);
    expect(schema.body.data.flows['agent-job'].proofs).toEqual(['PICKUP', 'CHECK_IN', 'CONDITION', 'INSTALLATION']);
    expect(schema.body.data.flows['agent-job'].requiredProofs).toEqual(['CHECK_IN', 'CONDITION', 'INSTALLATION']);
    // G11-1: a label per key beside the bare list.
    expect(schema.body.data.flows['agent-job'].proofOptions).toEqual(expect.arrayContaining([{ key: 'CHECK_IN', label: 'Check in' }]));
    expect(schema.body.data.flows['employee-intake'].proofOptions).toEqual(expect.arrayContaining([{ key: 'govIdFrontUrl', label: 'Government ID front' }]));
    expect(schema.body.data.flows['employee-intake'].requiredProofs).toEqual(['govIdFrontUrl', 'panFrontUrl', 'addressProofUrl', 'selfieUrl']);
    // LH7: the landing's blocks may sit on both sides; nothing is required.
    expect(schema.body.data.flows['lead-landing']).toMatchObject({ repeatable: true, requiredProofs: [], proofs: expect.arrayContaining(['RATE_ESTIMATE', 'PACKAGES', 'PROPOSALS']) });
    expect(schema.body.data.flows['agent-job'].repeatable).toBe(false);
  });
});

describe('GET /config', () => {
  it('prints a version on every flow, 1 for one written without', async () => {
    row.value = { enums: {}, flows: { listing: { label: 'Listing', screens: [], branches: {} } } };
    const res = await request(app()).get('/api/v1/config');
    expect(res.status).toBe(200);
    expect(res.body.data.flows.listing.version).toBe(1);
  });
});

describe('PATCH /config/flows/:key', () => {
  it('replaces one flow, keeps main:previous and the replaced version, bumps the version and audits the screens that moved', async () => {
    const before = JSON.parse(JSON.stringify(row.value));
    const next = listing();
    next.branches.indoor.screens[0]!.title = 'Where is it?';
    next.branches.media.screens.pop(); // drop media/review
    delete (next as { version?: number }).version;

    const res = await request(app()).patch('/api/v1/config/flows/listing').set('Authorization', `Bearer ${admin}`).send(next);

    expect(res.status).toBe(200);
    expect(res.body.data.version).toBe(4);
    expect(typeof res.body.data.updatedAt).toBe('string');
    expect(repository.saveByKey).toHaveBeenNthCalledWith(1, 'main:previous', before);
    expect(repository.saveByKey).toHaveBeenNthCalledWith(2, 'flows.listing:v3', expect.objectContaining({ version: 3 }));
    const saved = repository.save.mock.calls[0]![0] as { flows: Record<string, { version: number }>; enums: unknown };
    expect(saved.flows['listing']!.version).toBe(4);
    expect(saved.flows['onboarding']).toEqual(before.flows.onboarding); // untouched
    expect(saved.enums).toEqual(before.enums);
    expect(audit.logActivity).toHaveBeenCalledWith(
      'admin-1',
      'APP_CONFIG_UPDATED',
      expect.objectContaining({
        module: 'app-config',
        targetType: 'AppConfig',
        targetId: 'main',
        metadata: expect.objectContaining({
          flow: 'listing',
          version: { before: 3, after: 4 },
          screens: { added: [], removed: ['media/review'], changed: ['indoor/venue'] },
        }),
      }),
    );
  });

  it('keeps only the last five snapshots', async () => {
    repository.listByPrefix.mockResolvedValue([1, 2, 3, 4, 5, 6, 7].map((v) => ({ key: `flows.listing:v${v}`, value: {}, updatedAt: new Date() })));
    const next = listing();
    delete (next as { version?: number }).version;
    const res = await request(app()).patch('/api/v1/config/flows/listing').set('Authorization', `Bearer ${admin}`).send(next);
    expect(res.status).toBe(200);
    expect(repository.listByPrefix).toHaveBeenCalledWith('flows.listing:v');
    expect(repository.deleteByKey.mock.calls.map((c) => c[0])).toEqual(['flows.listing:v2', 'flows.listing:v1']);
  });

  it('refuses a flow that fails the vocabulary and writes nothing', async () => {
    const bad = listing();
    bad.screens[0]!.fields[0]!.options!.push({ id: 'digital', title: 'Digital', description: 'Screens' });
    delete (bad as { version?: number }).version;
    const res = await request(app()).patch('/api/v1/config/flows/listing').set('Authorization', `Bearer ${admin}`).send(bad);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(repository.save).not.toHaveBeenCalled();
    expect(repository.saveByKey).not.toHaveBeenCalled();
    expect(audit.logActivity).not.toHaveBeenCalled();
  });

  it('E10-2: a nested refusal carries details.issues with the full Zod path, the flattened form still beside it', async () => {
    const bad = listing();
    // Three levels down a branch: the flattened form reads this as "branches: invalid" and nothing to point at.
    (bad.branches.indoor.screens[1]!.fields[0] as { type: string }).type = 'hologram';
    delete (bad as { version?: number }).version;
    const res = await request(app()).patch('/api/v1/config/flows/listing').set('Authorization', `Bearer ${admin}`).send(bad);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    const details = res.body.error.details as { fieldErrors: Record<string, string[]>; formErrors: string[]; issues: { path: string[]; pointer: string; message: string; code: string }[] };
    expect(details.fieldErrors).toBeDefined();
    expect(details.formErrors).toBeDefined();
    expect(details.issues.length).toBeGreaterThan(0);
    const nested = details.issues.find((issue) => issue.pointer === 'branches.indoor.screens[1].fields[0].type');
    expect(nested, JSON.stringify(details.issues)).toBeDefined();
    expect(nested).toMatchObject({ path: ['branches', 'indoor', 'screens', '1', 'fields', '0', 'type'], message: expect.any(String), code: expect.any(String) });
    // The flattened form says only which top-level key failed — the reason the issues list exists.
    expect(Object.keys(details.fieldErrors)).toEqual(['branches']);
    for (const issue of details.issues) expect(issue.path.every((segment) => typeof segment === 'string')).toBe(true);
    expect(repository.save).not.toHaveBeenCalled();
  });

  it('is a 409 for an editor on a version that is no longer current', async () => {
    const stale = { ...listing(), version: 2 };
    const res = await request(app()).patch('/api/v1/config/flows/listing').set('Authorization', `Bearer ${admin}`).send(stale);
    expect(res.status).toBe(409);
    expect(res.body.error.details).toEqual({ currentVersion: 3 });
    expect(repository.save).not.toHaveBeenCalled();
  });

  it('validates the onboarding key as a ladder: a missing required column is refused, a fitting edit is stored and audited', async () => {
    const broken = onboarding();
    broken.ladders.PUBLISHER.INDIVIDUAL = broken.ladders.PUBLISHER.INDIVIDUAL.filter((id) => id !== 'address-proof');
    delete (broken as { version?: number }).version;
    const refused = await request(app()).patch('/api/v1/config/flows/onboarding').set('Authorization', `Bearer ${admin}`).send(broken);
    expect(refused.status).toBe(400);
    expect(JSON.stringify(refused.body.error.details)).toContain('never captures addressProofUrl');

    const edited = onboarding();
    edited.steps['selfie'] = { ...edited.steps['selfie']!, title: 'A photo of you' };
    edited.ladders.ADVERTISER.BUSINESS = edited.ladders.ADVERTISER.BUSINESS.filter((id) => id !== 'contact');
    const res = await request(app()).patch('/api/v1/config/flows/onboarding').set('Authorization', `Bearer ${admin}`).send(edited);
    expect(res.status).toBe(200);
    expect(res.body.data.version).toBe(2);
    expect(repository.saveByKey).toHaveBeenNthCalledWith(2, 'flows.onboarding:v1', expect.objectContaining({ version: 1 }));
    expect(audit.logActivity).toHaveBeenCalledWith(
      'admin-1',
      'APP_CONFIG_UPDATED',
      expect.objectContaining({
        metadata: expect.objectContaining({
          flow: 'onboarding',
          version: { before: 1, after: 2 },
          steps: { added: [], removed: [], changed: ['selfie'] },
          ladders: { added: [], removed: [], changed: ['ADVERTISER/BUSINESS'] },
        }),
      }),
    );
  });

  it('is ADMIN-only and refuses a key that is not a flow key', async () => {
    expect((await request(app()).patch('/api/v1/config/flows/listing').set('Authorization', `Bearer ${publisher}`).send(listing())).status).toBe(403);
    expect((await request(app()).patch('/api/v1/config/flows/Not%20A%20Key').set('Authorization', `Bearer ${admin}`).send(listing())).status).toBe(400);
  });
});

describe('a party mid-ladder', () => {
  it('is served the version they started from, and today\'s when that snapshot is gone', async () => {
    const current = await getFlow('onboarding');
    expect(current?.['version']).toBe(1);

    row.value = { ...row.value, flows: { ...(row.value['flows'] as object), onboarding: { ...onboarding(), version: 3 } } };
    repository.findByKey.mockImplementation(async (key: string) => (key === 'flows.onboarding:v2' ? { key, value: { ...onboarding(), version: 2 }, updatedAt: new Date() } : null));

    expect((await getFlow('onboarding', 2))?.['version']).toBe(2);
    expect((await getFlow('onboarding', 3))?.['version']).toBe(3);
    expect((await getFlow('onboarding', 1))?.['version']).toBe(3); // pruned: today's ladder rather than none
    expect(await getFlow('campaign')).toBeNull();
  });
});

describe('PATCH /config/flows/lead-landing (LH7)', () => {
  it('takes a block on both sides, refuses it twice on one side, and refuses an unknown block', async () => {
    const ladder = {
      label: 'Invite landing',
      steps: [
        { key: 'publisher', number: 1, title: 'Earn from your wall', hint: 'One\nTwo', cta: 'Get my rate', proofs: [{ key: 'RATE_ESTIMATE', label: 'What spaces like yours earn' }, { key: 'PROPOSALS', label: 'Your estimate' }] },
        { key: 'advertiser', number: 2, title: 'Reach your customers', proofs: [{ key: 'PACKAGES', label: 'Packages' }, { key: 'PROPOSALS', label: 'Your proposal' }] },
      ],
    };
    const ok = await request(app()).patch('/api/v1/config/flows/lead-landing').set('Authorization', `Bearer ${admin}`).send(ladder);
    expect(ok.status).toBe(200);
    expect(ok.body.data.version).toBe(1);
    const twice = { steps: [{ ...ladder.steps[0], proofs: [...ladder.steps[0]!.proofs, { key: 'PROPOSALS', label: 'Again' }] }] };
    const refused = await request(app()).patch('/api/v1/config/flows/lead-landing').set('Authorization', `Bearer ${admin}`).send(twice);
    expect(refused.status).toBe(400);
    expect(JSON.stringify(refused.body.error.details.issues)).toContain('on this step twice');
    const unknown = { steps: [{ key: 'publisher', number: 1, title: 'x', proofs: [{ key: 'NOPE', label: 'x' }] }] };
    expect((await request(app()).patch('/api/v1/config/flows/lead-landing').set('Authorization', `Bearer ${admin}`).send(unknown)).status).toBe(400);
  });
});

describe('PATCH /config/flows/agent-job and /employee-intake (Q126/Q141)', () => {
  const jobLadder = () => ({
    label: 'Agent job',
    description: 'The eight steps.',
    steps: [
      { key: 'offer', number: 1, title: 'Job offer', proofs: [] as { key: string; label: string }[] },
      { key: 'pickup', number: 2, title: 'Material pickup', proofs: [{ key: 'PICKUP', label: 'Material photographed at pickup' }] },
      { key: 'check-in', number: 4, title: 'Site QR verification', proofs: [{ key: 'CHECK_IN', label: 'Checked in at the site' }] },
      { key: 'before', number: 5, title: 'Before shots', proofs: [{ key: 'CONDITION', label: 'Site photographed before install' }] },
      { key: 'after', number: 7, title: 'After shots', cta: 'Submit', proofs: [{ key: 'INSTALLATION', label: 'Advertisement photographed in place' }] },
    ],
  });

  it('stores a first ladder at version 1 with its description, audits the steps, and lists it as stored', async () => {
    const res = await request(app()).patch('/api/v1/config/flows/agent-job').set('Authorization', `Bearer ${admin}`).send(jobLadder());
    expect(res.status).toBe(200);
    expect(res.body.data.version).toBe(1);
    expect(res.body.data.description).toBe('The eight steps.');
    expect(repository.saveByKey).toHaveBeenCalledTimes(1); // main:previous only — nothing to snapshot
    expect(audit.logActivity).toHaveBeenCalledWith(
      'admin-1',
      'APP_CONFIG_UPDATED',
      expect.objectContaining({
        metadata: expect.objectContaining({ flow: 'agent-job', version: { before: null, after: 1 }, steps: { added: ['offer', 'pickup', 'check-in', 'before', 'after'], removed: [], changed: [] } }),
      }),
    );
    const list = await request(app()).get('/api/v1/config/flows').set('Authorization', `Bearer ${admin}`);
    expect(list.body.data.find((f: { key: string }) => f.key === 'agent-job')).toMatchObject({ version: 1, stored: true, description: 'The eight steps.', shape: 'steps' });
    expect(await getFlow('agent-job')).toMatchObject({ version: 1, label: 'Agent job' });
  });

  it('refuses a ladder that drops a required proof, names one twice, or asks for a proof the code cannot check', async () => {
    const dropped = jobLadder();
    dropped.steps.pop();
    let res = await request(app()).patch('/api/v1/config/flows/agent-job').set('Authorization', `Bearer ${admin}`).send(dropped);
    expect(res.status).toBe(400);
    expect(res.body.error.details.issues[0]).toMatchObject({ pointer: 'steps', message: 'No step collects INSTALLATION' });

    const twice = jobLadder();
    twice.steps[1]!.proofs.push({ key: 'CHECK_IN', label: 'Again' });
    res = await request(app()).patch('/api/v1/config/flows/agent-job').set('Authorization', `Bearer ${admin}`).send(twice);
    expect(res.status).toBe(400);
    expect(res.body.error.details.issues.map((i: { pointer: string }) => i.pointer)).toContain('steps[2].proofs[0].key');

    const unknown = jobLadder();
    unknown.steps[0]!.proofs.push({ key: 'SIGNATURE', label: 'Signed' });
    res = await request(app()).patch('/api/v1/config/flows/agent-job').set('Authorization', `Bearer ${admin}`).send(unknown);
    expect(res.status).toBe(400);
    expect(repository.save).not.toHaveBeenCalled();
  });

  it('the employee intake ladder speaks EmployeeKyc columns and must cover the four the desk verifies on', async () => {
    const ladder = {
      steps: [
        { key: 'identity', number: 1, title: 'Government ID', proofs: [{ key: 'govIdFrontUrl', label: 'ID front' }, { key: 'govIdBackUrl', label: 'ID back' }] },
        { key: 'pan', number: 2, title: 'PAN', proofs: [{ key: 'panNumber', label: 'PAN number' }, { key: 'panFrontUrl', label: 'PAN card' }] },
        { key: 'address', number: 3, title: 'Address proof', proofs: [{ key: 'addressProofUrl', label: 'Proof of address' }] },
        { key: 'selfie', number: 4, title: 'Selfie', proofs: [{ key: 'selfieUrl', label: 'Live selfie' }] },
      ],
    };
    const res = await request(app()).patch('/api/v1/config/flows/employee-intake').set('Authorization', `Bearer ${admin}`).send(ladder);
    expect(res.status).toBe(200);
    expect(res.body.data.version).toBe(1);

    const short = { steps: ladder.steps.slice(0, 3) };
    const refused = await request(app()).patch('/api/v1/config/flows/employee-intake').set('Authorization', `Bearer ${admin}`).send(short);
    expect(refused.status).toBe(400);
    expect(refused.body.error.details.issues[0].message).toBe('No step collects selfieUrl');
  });
});

describe('PATCH /config/enums/:group', () => {
  it('replaces one group, keeps main:previous and audits the values that moved', async () => {
    const before = JSON.parse(JSON.stringify(row.value));
    const entries = [{ value: 'en', label: 'English (India)' }, { value: 'kn', label: 'Kannada' }];
    const res = await request(app()).patch('/api/v1/config/enums/languages').set('Authorization', `Bearer ${admin}`).send(entries);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual(entries);
    expect(repository.saveByKey).toHaveBeenCalledWith('main:previous', before);
    const saved = repository.save.mock.calls[0]![0] as { flows: unknown; enums: Record<string, unknown> };
    expect(saved.flows).toEqual(before.flows);
    expect(saved.enums['languages']).toEqual(entries);
    expect(audit.logActivity).toHaveBeenCalledWith(
      'admin-1',
      'APP_CONFIG_UPDATED',
      expect.objectContaining({
        targetId: 'main',
        metadata: { changedKeys: ['enums'], enumGroup: 'languages', entries: { added: ['kn'], removed: [], changed: ['en'] } },
      }),
    );
  });

  it('refuses a duplicated value and a group name that is not camelCase', async () => {
    const dup = await request(app()).patch('/api/v1/config/enums/languages').set('Authorization', `Bearer ${admin}`).send([{ value: 'en', label: 'A' }, { value: 'en', label: 'B' }]);
    expect(dup.status).toBe(400);
    expect(repository.save).not.toHaveBeenCalled();
    const name = await request(app()).patch('/api/v1/config/enums/Not-A-Group').set('Authorization', `Bearer ${admin}`).send([{ value: 'a', label: 'A' }]);
    expect(name.status).toBe(400);
  });
});

/* Lot F (the Lot E verifier's minor): `npm run seed:config` goes through the
   same door as the editor — a byte-equal flow keeps its version, a changed one
   is bumped and the flow it replaces is kept as `flows.<key>:v<N>`. */
describe('seedAppConfig', () => {
  it('keeps the version of a byte-equal flow (whatever order jsonb hands the keys back in) and writes no snapshot', async () => {
    const current = listing();
    const reordered = Object.fromEntries(Object.entries(current).reverse()) as typeof current;
    const report = await seedAppConfig({ flows: { listing: reordered, onboarding: onboarding() }, enums: { languages: [] } });
    expect(report['listing']).toEqual({ version: 3, changed: false });
    expect(report['onboarding']).toEqual({ version: 1, changed: false });
    expect(repository.saveByKey).not.toHaveBeenCalled();
    const saved = repository.save.mock.calls[0]![0] as { flows: Record<string, { version: number }>; enums: unknown };
    expect(saved.flows['listing']!.version).toBe(3);
    expect(saved.enums).toEqual({ languages: [] });
  });

  it('bumps a changed flow by one and keeps the replaced one as flows.<key>:v<N>, five deep', async () => {
    repository.listByPrefix.mockResolvedValue([1, 2, 3, 4, 5, 6].map((v) => ({ key: `flows.listing:v${v}`, value: {}, updatedAt: new Date() })));
    const next = listing();
    next.branches.media.screens.pop();
    const report = await seedAppConfig({ flows: { listing: next, onboarding: onboarding() }, enums: {} });
    expect(report['listing']).toEqual({ version: 4, changed: true });
    expect(repository.saveByKey).toHaveBeenCalledTimes(1);
    expect(repository.saveByKey).toHaveBeenCalledWith('flows.listing:v3', expect.objectContaining({ version: 3 }));
    expect(repository.deleteByKey.mock.calls.map((c) => c[0])).toEqual(['flows.listing:v1']);
    const saved = repository.save.mock.calls[0]![0] as { flows: Record<string, { version: number; updatedAt?: string }> };
    expect(saved.flows['listing']!.version).toBe(4);
    expect(typeof saved.flows['listing']!.updatedAt).toBe('string');
  });

  it('starts every flow at version 1 on a fresh row', async () => {
    repository.find.mockResolvedValue(null);
    const report = await seedAppConfig({ flows: { listing: listing(), onboarding: onboarding() }, enums: {} });
    expect(report).toEqual({ listing: { version: 1, changed: true }, onboarding: { version: 1, changed: true } });
    expect(repository.saveByKey).not.toHaveBeenCalled();
  });
});
