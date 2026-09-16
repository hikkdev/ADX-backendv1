import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The review desk — DR 10's listing review queue.
 *
 * `POST /listings/:id/publish` existed and nothing called it, so every spot a
 * publisher submitted sat at PENDING_REVIEW for ever. This is the other half:
 * what the desk reads before deciding, and the one answer it could not give
 * before — "no, and here is why".
 */

const { repository, rateCards } = vi.hoisted(() => ({
  repository: {
    findById: vi.fn(),
    findPendingReview: vi.fn(),
    findReviewCase: vi.fn(),
    sendBack: vi.fn(),
  },
  rateCards: { checkGate: vi.fn(), assertPublishable: vi.fn() },
}));

vi.mock('../prisma-listings.repository', () => ({ prismaListingsRepository: repository }));
vi.mock('../../rate-cards', () => rateCards);

import { getReviewCase, getReviewQueue, sendBackListing } from '../listings.service';
import { reviewQueueQuerySchema } from '../listings.schema';

/** The desk's default page — what the queue asks for when nobody has filtered. */
const QUERY = reviewQueueQuerySchema.parse({});
import { sendBackListingSchema } from '../listings.schema';

/** A Prisma Decimal, as far as the service can tell. */
const decimal = (value: string) => ({ toString: () => value });

const pending = (over: Record<string, unknown> = {}) => ({
  id: 'lst_1',
  displayId: 'ADX-LST-00042',
  title: 'MG Road billboard',
  category: 'OUTDOOR',
  subType: null,
  status: 'PENDING_REVIEW',
  city: 'Bengaluru',
  address: 'MG Road',
  placement: 'Facing the junction',
  widthFt: decimal('20.00'),
  heightFt: decimal('10.00'),
  areaSqFt: decimal('200.00'),
  ratePerDay: decimal('1500.00'),
  basePrice: decimal('45000.00'),
  pricingUnit: 'PER_MONTH',
  rateGrade: null,
  submittedAt: new Date('2026-09-09T10:00:00Z'),
  createdAt: new Date('2026-09-08T10:00:00Z'),
  rejectionReason: null,
  publisher: { id: 'pub_1', name: 'Sharma Hoardings', displayId: 'PUB-1909-2601', city: 'Bengaluru', mobile: '+919876543210' },
  agent: { id: 'agt_1', displayId: 'AGT-1009-2601', user: { name: 'Ravi' } },
  photos: [{ id: 'ph_1', url: 'https://x/1.jpg', type: 'main', createdAt: new Date() }],
  documents: [
    { id: 'doc_1', kind: 'OWNER_NOC', url: 'https://x/noc.pdf', status: 'VERIFIED', rejectionReason: null, submittedAt: new Date(), reviewedAt: new Date() },
    { id: 'doc_2', kind: 'MUNICIPAL_PERMIT', url: 'https://x/permit.pdf', status: 'PENDING', rejectionReason: null, submittedAt: new Date(), reviewedAt: null },
    { id: 'doc_3', kind: 'ADDRESS_PROOF', url: 'https://x/addr.pdf', status: 'REJECTED', rejectionReason: 'Unreadable', submittedAt: new Date(), reviewedAt: new Date() },
  ],
  ...over,
});

const OK_GATE = { state: 'OK', cardId: 'rc_1', cardRate: '2000.00', floor: '1600.00' };

beforeEach(() => {
  vi.clearAllMocks();
  rateCards.checkGate.mockResolvedValue(OK_GATE);
});

describe('the queue', () => {
  it('lists what is waiting with its documents, photos and the gate verdict', async () => {
    repository.findPendingReview.mockResolvedValue({ items: [pending()], total: 1 });
    const [row] = (await getReviewQueue(QUERY)).items;

    expect(row).toMatchObject({
      id: 'lst_1',
      displayId: 'ADX-LST-00042',
      publisher: { id: 'pub_1', name: 'Sharma Hoardings', displayId: 'PUB-1909-2601' },
      agent: { id: 'agt_1', displayId: 'AGT-1009-2601', name: 'Ravi' },
      photoCount: 1,
      documentSummary: { total: 3, pending: 1, verified: 1, rejected: 1 },
      gate: OK_GATE,
      priorReason: null,
    });
  });

  /* Money is a decimal string end to end. The repository hands the service
     Decimals; the wire gets strings, never a float. */
  it('sends the asking price as decimal strings, with the pair the publisher typed', async () => {
    repository.findPendingReview.mockResolvedValue({ items: [pending()], total: 1 });
    const [row] = (await getReviewQueue(QUERY)).items;
    expect(row!.asking).toEqual({ ratePerDay: '1500.00', basePrice: '45000.00', pricingUnit: 'PER_MONTH' });
    expect(row!.widthFt).toBe('20.00');
    expect(row!.areaSqFt).toBe('200.00');
  });

  /* The verdict depends on the card in force for each listing's media type,
     grade and city, so it is asked per row rather than once. */
  it('asks the gate once per listing', async () => {
    repository.findPendingReview.mockResolvedValue({ items: [pending(), pending({ id: 'lst_2' })], total: 2 });
    rateCards.checkGate
      .mockResolvedValueOnce(OK_GATE)
      .mockResolvedValueOnce({ state: 'BELOW_FLOOR', cardId: 'rc_1', cardRate: '2000.00', floor: '1600.00', rate: '1500.00' });

    const rows = (await getReviewQueue(QUERY)).items;
    expect(rateCards.checkGate).toHaveBeenCalledTimes(2);
    expect(rows[1]!.gate.state).toBe('BELOW_FLOOR');
  });

  it('keeps a self-serve listing readable with no agent and no publisher name lost', async () => {
    repository.findPendingReview.mockResolvedValue({ items: [pending({ agent: null })], total: 1 });
    const [row] = (await getReviewQueue(QUERY)).items;
    expect(row!.agent).toBeNull();
    expect(row!.publisher?.name).toBe('Sharma Hoardings');
  });

  /* A resubmission keeps the reason it was sent back for, so the reviewer can
     check the fix against the ask. */
  it('surfaces the reason a resubmitted listing was last sent back for', async () => {
    repository.findPendingReview.mockResolvedValue({ items: [pending({ rejectionReason: 'Photos are blurry' })], total: 1 });
    const [row] = (await getReviewQueue(QUERY)).items;
    expect(row!.priorReason).toBe('Photos are blurry');
  });
});

describe('the case', () => {
  it('answers 404 for a listing that is not there', async () => {
    repository.findReviewCase.mockResolvedValue(null);
    await expect(getReviewCase('nope')).rejects.toMatchObject({ statusCode: 404 });
  });

  it('adds the vocabulary, content rules, every photo and every document', async () => {
    repository.findReviewCase.mockResolvedValue(
      pending({
        description: 'Backlit, faces the junction',
        latitude: 12.97,
        longitude: 77.6,
        mediaType: { id: 'mt_1', name: 'Hoarding' },
        sizeClass: { id: 'sc_1', name: 'Large' },
        material: null,
        venueType: { id: 'vt_1', name: 'Roadside' },
        contentRules: [{ stance: 'PROHIBITED', category: { id: 'cc_1', name: 'Alcohol' } }],
      })
    );
    const result = await getReviewCase('lst_1');

    expect(result.vocabulary).toEqual({ mediaType: 'Hoarding', sizeClass: 'Large', material: null, venueType: 'Roadside' });
    expect(result.contentRules).toEqual([{ stance: 'PROHIBITED', category: { id: 'cc_1', name: 'Alcohol' } }]);
    expect(result.photos).toHaveLength(1);
    expect(result.documents).toHaveLength(3);
    expect(result.publisherMobile).toBe('+919876543210');
    expect(result.gate).toEqual(OK_GATE);
  });
});

describe('sending a listing back', () => {
  beforeEach(() => {
    repository.findById.mockResolvedValue({ id: 'lst_1', status: 'PENDING_REVIEW' });
    repository.sendBack.mockImplementation(async (id: string, input: { status: string; reason: string }) => ({
      id,
      status: input.status,
      rejectionReason: input.reason,
    }));
  });

  it('returns a draft the publisher can fix, carrying the reason', async () => {
    const result = await sendBackListing('lst_1', { reason: 'Photos are blurry', outcome: 'CHANGES_REQUESTED' });
    expect(repository.sendBack).toHaveBeenCalledWith('lst_1', { status: 'DRAFT', reason: 'Photos are blurry' });
    expect(result).toMatchObject({ status: 'DRAFT', rejectionReason: 'Photos are blurry' });
  });

  it('rejects outright when told to', async () => {
    await sendBackListing('lst_1', { reason: 'Not an advertising surface', outcome: 'REJECTED' });
    expect(repository.sendBack).toHaveBeenCalledWith('lst_1', {
      status: 'REJECTED',
      reason: 'Not an advertising surface',
    });
  });

  /* A draft was never submitted and a live listing is past this desk; writing
     a reason onto either would be a decision on a row nobody is waiting on. */
  it.each(['DRAFT', 'ACTIVE', 'REJECTED', 'AWAITING_DOCUMENTS'])(
    'refuses to send back a listing that is %s',
    async (status) => {
      repository.findById.mockResolvedValue({ id: 'lst_1', status });
      await expect(
        sendBackListing('lst_1', { reason: 'Photos are blurry', outcome: 'CHANGES_REQUESTED' })
      ).rejects.toMatchObject({ statusCode: 409 });
      expect(repository.sendBack).not.toHaveBeenCalled();
    }
  );

  it('answers 404 for a listing that is not there', async () => {
    repository.findById.mockResolvedValue(null);
    await expect(
      sendBackListing('nope', { reason: 'Photos are blurry', outcome: 'CHANGES_REQUESTED' })
    ).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe('the send-back body', () => {
  /* "No" with nothing after it is a support ticket, not a correction. */
  it('needs a reason that is a sentence', () => {
    expect(sendBackListingSchema.safeParse({ reason: '   ' }).success).toBe(false);
    expect(sendBackListingSchema.safeParse({ reason: 'no' }).success).toBe(false);
    expect(sendBackListingSchema.safeParse({}).success).toBe(false);
  });

  it('defaults to asking for changes and trims the reason', () => {
    const parsed = sendBackListingSchema.parse({ reason: '  Photos are blurry  ' });
    expect(parsed).toEqual({ reason: 'Photos are blurry', outcome: 'CHANGES_REQUESTED' });
  });

  it('refuses an outcome it does not know', () => {
    expect(sendBackListingSchema.safeParse({ reason: 'Photos are blurry', outcome: 'MAYBE' }).success).toBe(false);
  });
});
