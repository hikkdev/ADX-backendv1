import { describe, expect, it } from 'vitest';

/**
 * Lot K2 — RFC 6238 by hand.
 *
 * What is pinned: the RFC's own SHA1 test vectors (Appendix B, with the
 * ASCII secret `12345678901234567890`), 8 digits as published and the 6
 * digits ADX issues; the ±1 step window and nothing wider; base32 both
 * ways; the otpauth URI the QR encodes; and that a sealed secret opens
 * again and cannot be opened under another key.
 */
import {
  TOTP_DIGITS,
  TOTP_STEP_SECONDS,
  base32Decode,
  base32Encode,
  generateTotpSecret,
  hotp,
  matchTotp,
  openSecret,
  otpauthUri,
  sealSecret,
  totp,
  totpStep,
} from '../totp';

/** The RFC's SHA1 seed, as the base32 an authenticator app would be given. */
const RFC_SECRET = base32Encode(Buffer.from('12345678901234567890', 'ascii'));

describe('RFC 6238 test vectors (SHA1)', () => {
  it.each([
    [59, '94287082', '287082'],
    [1111111109, '07081804', '081804'],
    [1234567890, '89005924', '005924'],
    [1111111111, '14050471', '050471'],
    [2000000000, '69279037', '279037'],
    [20000000000, '65353130', '353130'],
  ])('at %d seconds: %s (8 digits), %s (6 digits)', (seconds, eight, six) => {
    expect(totp(RFC_SECRET, seconds * 1000, { digits: 8 })).toBe(eight);
    expect(totp(RFC_SECRET, seconds * 1000)).toBe(six);
  });

  it('is HOTP over the 30-second step counter', () => {
    expect(totpStep(59 * 1000)).toBe(1);
    expect(totpStep(1111111109 * 1000)).toBe(37037036);
    expect(hotp(Buffer.from('12345678901234567890', 'ascii'), 1, 8)).toBe('94287082');
    expect(TOTP_STEP_SECONDS).toBe(30);
    expect(TOTP_DIGITS).toBe(6);
  });
});

describe('matching a typed code', () => {
  const at = 1234567890 * 1000;

  it('accepts the current step and one either side, refuses two away', () => {
    const now = totpStep(at);
    expect(matchTotp(RFC_SECRET, '005924', at)).toBe(now);
    expect(matchTotp(RFC_SECRET, totp(RFC_SECRET, at - 30_000), at)).toBe(now - 1);
    expect(matchTotp(RFC_SECRET, totp(RFC_SECRET, at + 30_000), at)).toBe(now + 1);
    expect(matchTotp(RFC_SECRET, totp(RFC_SECRET, at - 60_000), at)).toBeNull();
    expect(matchTotp(RFC_SECRET, totp(RFC_SECRET, at + 60_000), at)).toBeNull();
  });

  it('tolerates a space in the middle, refuses anything that is not six digits', () => {
    expect(matchTotp(RFC_SECRET, '005 924', at)).not.toBeNull();
    expect(matchTotp(RFC_SECRET, '00592', at)).toBeNull();
    expect(matchTotp(RFC_SECRET, '0059240', at)).toBeNull();
    expect(matchTotp(RFC_SECRET, 'ABCDEF', at)).toBeNull();
    expect(matchTotp(RFC_SECRET, '000000', at)).toBeNull();
  });
});

describe('the secret', () => {
  it('is 20 random bytes as base32, and base32 round-trips', () => {
    const secret = generateTotpSecret();
    expect(secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(base32Decode(secret)).toHaveLength(20);
    expect(base32Encode(base32Decode(secret))).toBe(secret);
    expect(generateTotpSecret()).not.toBe(secret);
    expect(base32Decode('gezd gnbv')).toEqual(Buffer.from('12345', 'ascii'));
    expect(() => base32Decode('01')).toThrow();
  });

  it('is what the otpauth URI carries, with the issuer, digits and period every app reads', () => {
    const uri = otpauthUri('asha.rao@adx.co', 'ABCDEFGHIJKLMNOP');
    expect(uri.startsWith('otpauth://totp/ADX%3Aasha.rao%40adx.co?')).toBe(true);
    const params = new URL(uri).searchParams;
    expect(params.get('secret')).toBe('ABCDEFGHIJKLMNOP');
    expect(params.get('issuer')).toBe('ADX');
    expect(params.get('digits')).toBe('6');
    expect(params.get('period')).toBe('30');
    expect(params.get('algorithm')).toBe('SHA1');
  });

  it('seals as iv:tag:ciphertext, opens again, and never stores the secret in clear', () => {
    const secret = generateTotpSecret();
    const sealed = sealSecret(secret);
    expect(sealed.split(':')).toHaveLength(3);
    expect(sealed).not.toContain(secret);
    expect(openSecret(sealed)).toBe(secret);
    // A fresh IV every time: the same secret never seals to the same bytes.
    expect(sealSecret(secret)).not.toBe(sealed);
  });

  it('refuses a sealed value that was tampered with', () => {
    const sealed = sealSecret(generateTotpSecret());
    const [iv, tag, ciphertext] = sealed.split(':') as [string, string, string];
    const flipped = Buffer.from(ciphertext, 'base64');
    flipped[0] = flipped[0]! ^ 0xff;
    expect(() => openSecret([iv, tag, flipped.toString('base64')].join(':'))).toThrow();
    expect(() => openSecret('nonsense')).toThrow();
  });
});
