import { createHash, createHmac } from 'crypto';

/**
 * A presigned S3 GET, by hand — Lot D (Q61).
 *
 * R2 speaks the S3 API, and a private object is read through a URL that
 * carries its own five-minute signature rather than through the bucket's
 * public host. The SDK's presigner package is not a dependency of this
 * project and the query-string flavour of SigV4 is forty lines, so it is
 * written here against the worked example in the AWS documentation
 * (`presign.test.ts` pins that vector) instead of pulling in a package for it.
 */

export type PresignInput = {
  host: string;
  /** The object path as it will appear on the wire, leading slash included, un-encoded. */
  path: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  expiresInSeconds: number;
  now?: Date;
  /** Extra query parameters the response should honour — a content disposition, say. */
  query?: Record<string, string>;
};

const sha256 = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');
const hmac = (key: Buffer | string, value: string) => createHmac('sha256', key).update(value, 'utf8').digest();

/** RFC 3986 — `encodeURIComponent` leaves `!'()*` alone and SigV4 does not. */
export function sigv4Encode(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

function encodePath(path: string): string {
  return path
    .split('/')
    .map((segment) => sigv4Encode(segment))
    .join('/');
}

function amzDate(now: Date): { date: string; stamp: string } {
  const iso = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  return { stamp: iso, date: iso.slice(0, 8) };
}

export function presignGet(input: PresignInput): string {
  const { date, stamp } = amzDate(input.now ?? new Date());
  const scope = `${date}/${input.region}/s3/aws4_request`;
  const params: Record<string, string> = {
    ...(input.query ?? {}),
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-Credential': `${input.accessKeyId}/${scope}`,
    'X-Amz-Date': stamp,
    'X-Amz-Expires': String(input.expiresInSeconds),
    'X-Amz-SignedHeaders': 'host',
  };
  const canonicalQuery = Object.keys(params)
    .sort()
    .map((key) => `${sigv4Encode(key)}=${sigv4Encode(params[key]!)}`)
    .join('&');
  const canonicalPath = encodePath(input.path);
  const canonicalRequest = ['GET', canonicalPath, canonicalQuery, `host:${input.host}\n`, 'host', 'UNSIGNED-PAYLOAD'].join('\n');
  const stringToSign = ['AWS4-HMAC-SHA256', stamp, scope, sha256(canonicalRequest)].join('\n');

  const kDate = hmac(`AWS4${input.secretAccessKey}`, date);
  const kRegion = hmac(kDate, input.region);
  const kService = hmac(kRegion, 's3');
  const kSigning = hmac(kService, 'aws4_request');
  const signature = createHmac('sha256', kSigning).update(stringToSign, 'utf8').digest('hex');

  return `https://${input.host}${canonicalPath}?${canonicalQuery}&X-Amz-Signature=${signature}`;
}
