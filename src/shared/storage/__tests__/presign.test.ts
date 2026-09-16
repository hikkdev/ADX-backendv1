import { describe, expect, it } from 'vitest';
import { presignGet, sigv4Encode } from '../presign';

/**
 * The presigner against the worked example in the AWS SigV4 documentation
 * ("Authenticating Requests: Using Query Parameters"): the example bucket,
 * the example key pair, 24 May 2013, one day. A signer that reproduces that
 * signature byte for byte is a signer R2 will accept.
 */
describe('presignGet', () => {
  it('reproduces the documented example signature', () => {
    const url = presignGet({
      host: 'examplebucket.s3.amazonaws.com',
      path: '/test.txt',
      region: 'us-east-1',
      accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
      secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
      expiresInSeconds: 86400,
      now: new Date('2013-05-24T00:00:00Z'),
    });
    expect(url).toBe(
      'https://examplebucket.s3.amazonaws.com/test.txt' +
        '?X-Amz-Algorithm=AWS4-HMAC-SHA256' +
        '&X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20130524%2Fus-east-1%2Fs3%2Faws4_request' +
        '&X-Amz-Date=20130524T000000Z&X-Amz-Expires=86400&X-Amz-SignedHeaders=host' +
        '&X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404',
    );
  });

  it('encodes each path segment but never the slashes between them', () => {
    const url = presignGet({
      host: 'acct.r2.cloudflarestorage.com',
      path: "/bucket/private/kyc/a b'(1).png",
      region: 'auto',
      accessKeyId: 'k',
      secretAccessKey: 's',
      expiresInSeconds: 300,
      now: new Date('2026-09-12T10:00:00Z'),
    });
    expect(url.startsWith("https://acct.r2.cloudflarestorage.com/bucket/private/kyc/a%20b%27%281%29.png?")).toBe(true);
    expect(url).toContain('X-Amz-Expires=300');
  });

  it('encodes the characters encodeURIComponent leaves alone', () => {
    expect(sigv4Encode("a!b'c(d)e*f")).toBe('a%21b%27c%28d%29e%2Af');
  });
});
