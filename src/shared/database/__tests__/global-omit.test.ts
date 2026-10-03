import { describe, expect, expectTypeOf, it } from 'vitest';
import { GLOBAL_OMIT, LISTING_PRIVATE_COLUMNS, ORDER_RISK_COLUMNS, ORDER_RISK_KEYS, USER_CREDENTIALS, prisma } from '../prisma';

/**
 * 2 Oct 2026: `GET /orders/:id` answered each party of an order with the
 * others' whole User rows — password hash and encrypted TOTP secret included —
 * because a broad `include: { user: true }` had nothing between it and the
 * JSON. The client now omits every credential column from every read unless
 * the read names it. This pins the list and proves the client carries it.
 */
describe('the Prisma client', () => {
  it('omits the credential columns of every model that holds one', () => {
    expect(GLOBAL_OMIT).toEqual({
      user: { passwordHash: true, totpSecretEnc: true },
      otp: { codeHash: true },
      recoveryCode: { codeHash: true },
      emailSignup: { codeHash: true },
      refreshToken: { tokenHash: true },
      passwordResetToken: { tokenHash: true },
      adminInvite: { tokenHash: true },
      order: {
        completionOtp: true,
        completionOtpPlain: true,
        // Order fraud screening (2 Oct 2026): ADX's alone, off every default read.
        riskScore: true,
        riskSignals: true,
        riskBand: true,
        riskScoredAt: true,
        riskReviewStatus: true,
        riskReviewedById: true,
        riskReviewedAt: true,
        riskReviewNote: true,
        riskClearedSignalKeys: true,
        heldAt: true,
        heldById: true,
        holdReason: true,
        fraudCaseId: true,
      },
      // 3 Oct 2026: the sticker's token and the RC answer, off every default read.
      listing: { qrToken: true, vehicleRcPayload: true },
    });
  });

  it('opts back into exactly the listing’s private columns', () => {
    expect(LISTING_PRIVATE_COLUMNS).toEqual({ qrToken: false, vehicleRcPayload: false });
    expect(Object.keys(LISTING_PRIVATE_COLUMNS).sort()).toEqual(Object.keys(GLOBAL_OMIT.listing).sort());
  });

  it('opts back into exactly the order risk columns', () => {
    expect(Object.entries(ORDER_RISK_COLUMNS).every(([, on]) => on === false)).toBe(true);
    expect([...ORDER_RISK_KEYS].sort()).toEqual(Object.keys(GLOBAL_OMIT.order).filter((key) => !key.startsWith('completionOtp')).sort());
  });

  it('is built with that omit', () => {
    // Prisma keeps the constructor's `omit` on the instance and applies it to
    // every query it builds; reading it back proves the shared client got it.
    expect((prisma as unknown as { _globalOmit?: unknown })._globalOmit).toEqual(GLOBAL_OMIT);
  });

  it('opts back into exactly the two User credential columns', () => {
    expect(USER_CREDENTIALS).toEqual({ passwordHash: false, totpSecretEnc: false });
  });

  it('types a default read without the omitted columns, so a read that needs one has to ask', () => {
    type UserRow = NonNullable<Awaited<ReturnType<typeof prisma.user.findUnique>>>;
    type OrderRow = NonNullable<Awaited<ReturnType<typeof prisma.order.findUnique>>>;
    type OtpRow = NonNullable<Awaited<ReturnType<typeof prisma.otp.findFirst>>>;
    expectTypeOf<UserRow>().not.toHaveProperty('passwordHash');
    expectTypeOf<UserRow>().not.toHaveProperty('totpSecretEnc');
    expectTypeOf<UserRow>().toHaveProperty('name');
    expectTypeOf<OrderRow>().not.toHaveProperty('completionOtp');
    expectTypeOf<OrderRow>().not.toHaveProperty('completionOtpPlain');
    expectTypeOf<OrderRow>().not.toHaveProperty('riskScore');
    expectTypeOf<OrderRow>().not.toHaveProperty('heldAt');
    expectTypeOf<OrderRow>().not.toHaveProperty('riskSignals');
    expectTypeOf<OtpRow>().not.toHaveProperty('codeHash');
  });
});
