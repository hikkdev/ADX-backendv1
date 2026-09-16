import fs from 'fs';
import { createGunzip, createGzip } from 'zlib';
import { pipeline } from 'stream/promises';

/**
 * The gzip layer under the seal. A custom-format pg_dump is already
 * zlib-compressed member by member; gzip over the whole file buys a little
 * more on the TOC and costs nothing, and — more to the point — makes the
 * plaintext the cipher sees uniformly high-entropy.
 */
export async function gzipFile(src: string, dst: string): Promise<void> {
  await pipeline(fs.createReadStream(src), createGzip({ level: 6 }), fs.createWriteStream(dst));
}

export async function gunzipFile(src: string, dst: string): Promise<void> {
  await pipeline(fs.createReadStream(src), createGunzip(), fs.createWriteStream(dst));
}
