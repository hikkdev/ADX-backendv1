import crypto from 'crypto';
import { describe, expect, it } from 'vitest';
import { verifyHmacSignature } from '../webhook-signature';

const SECRET = 'a-shared-secret';
const BODY = Buffer.from(JSON.stringify({ id: 'kyc_1', status: 'approved' }));

const sign = (body: Buffer, secret = SECRET) =>
    crypto.createHmac('sha256', secret).update(body).digest('hex');

describe('webhook signature verification', () => {
    it('accepts a body signed with the shared secret', () => {
        expect(
            verifyHmacSignature({ rawBody: BODY, signature: sign(BODY), secret: SECRET })
        ).toEqual({ ok: true });
    });

    /**
     * The whole point. Before this existed, anyone holding a Digio request id
     * could POST `{status: "approved"}` and move a publisher to VERIFIED, which
     * is what unlocks payouts.
     */
    it('rejects a body nobody signed', () => {
        expect(
            verifyHmacSignature({ rawBody: BODY, signature: undefined, secret: SECRET })
        ).toEqual({ ok: false, reason: 'NO_SIGNATURE' });
    });

    it('rejects a signature made with a different secret', () => {
        expect(
            verifyHmacSignature({
                rawBody: BODY,
                signature: sign(BODY, 'not-the-secret'),
                secret: SECRET,
            })
        ).toEqual({ ok: false, reason: 'MISMATCH' });
    });

    it('rejects a valid signature for a different body', () => {
        const tampered = Buffer.from(JSON.stringify({ id: 'kyc_1', status: 'rejected' }));
        expect(
            verifyHmacSignature({ rawBody: tampered, signature: sign(BODY), secret: SECRET })
        ).toEqual({ ok: false, reason: 'MISMATCH' });
    });

    /**
     * Fails closed when unconfigured. A verifier that accepts everything with no
     * secret set reads as protection in review and provides none in production —
     * it would silently restore the hole it was written to close the first time
     * somebody deployed without the variable.
     */
    it('refuses everything when no secret is configured', () => {
        expect(
            verifyHmacSignature({ rawBody: BODY, signature: sign(BODY), secret: undefined })
        ).toEqual({ ok: false, reason: 'NO_SECRET' });
        expect(
            verifyHmacSignature({ rawBody: BODY, signature: sign(BODY), secret: '' })
        ).toEqual({ ok: false, reason: 'NO_SECRET' });
    });

    it('rejects an empty body rather than signing nothing', () => {
        const empty = Buffer.alloc(0);
        expect(
            verifyHmacSignature({ rawBody: empty, signature: sign(empty), secret: SECRET })
        ).toEqual({ ok: false, reason: 'NO_BODY' });
        expect(
            verifyHmacSignature({ rawBody: undefined, signature: sign(BODY), secret: SECRET })
        ).toEqual({ ok: false, reason: 'NO_BODY' });
    });

    it('accepts the presentation variants providers actually send', () => {
        const digest = sign(BODY);
        for (const variant of [
            digest.toUpperCase(),
            `sha256=${digest}`,
            `SHA256=${digest.toUpperCase()}`,
            `  ${digest}  `,
        ]) {
            expect(
                verifyHmacSignature({ rawBody: BODY, signature: variant, secret: SECRET })
            ).toEqual({ ok: true });
        }
    });

    /**
     * `timingSafeEqual` throws when the buffers differ in length, which would be
     * a 500 on any malformed header rather than a clean rejection.
     */
    it('rejects a wrong-length signature without throwing', () => {
        for (const junk of ['', 'abc', 'z'.repeat(64), 'f'.repeat(128)]) {
            expect(() =>
                verifyHmacSignature({ rawBody: BODY, signature: junk, secret: SECRET })
            ).not.toThrow();
        }
        expect(
            verifyHmacSignature({ rawBody: BODY, signature: 'abc', secret: SECRET })
        ).toEqual({ ok: false, reason: 'MISMATCH' });
    });
});
