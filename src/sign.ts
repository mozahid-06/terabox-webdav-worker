/**
 * Pure helpers ported from bclone's Terabox backend
 * (github.com/BenjiThatFoxGuy/bclone backend/terabox).
 */

/** RC4-style keystream XOR signature used by /api/download. */
export function sign(s1: string, s2: string): string {
  if (!s1) return '';
  const a = new Array<number>(256);
  const p = new Array<number>(256);
  const o: number[] = [];
  const v = s1.length;

  for (let q = 0; q < 256; q++) {
    a[q] = s1.charCodeAt(q % v);
    p[q] = q;
  }

  let u = 0;
  for (let q = 0; q < 256; q++) {
    u = (u + p[q]! + a[q]!) % 256;
    const tmp = p[q]!;
    p[q] = p[u]!;
    p[u] = tmp;
  }

  let i = 0;
  u = 0;
  for (let q = 0; q < s2.length; q++) {
    i = (i + 1) % 256;
    u = (u + p[i]!) % 256;
    const tmp = p[i]!;
    p[i] = p[u]!;
    p[u] = tmp;
    const k = p[(p[i]! + p[u]!) % 256]!;
    o.push(s2.charCodeAt(q) ^ k);
  }

  return btoa(String.fromCharCode(...o));
}

/** Normalise a cookie option into a usable Cookie header value. */
export function valuedCookie(cookie: string): string {
  let value = String(cookie || '').trim();
  if (value.length > 2 && value.startsWith('"') && value.endsWith('"')) {
    value = value.slice(1, -1);
  }
  const parts = value.split(';');
  if (parts.length === 1) {
    const bare = parts[0]!;
    if (!bare.includes('=')) return `ndus=${bare}; lang=en`;
    // A bare ndus value is base64: pasting it with its trailing '=' padding
    // must still wrap. Discriminator: base64 padding sits at the END, so a
    // single nameless token that *ends* in '=' is a padded value — a real
    // name=value pair (`lang=en`) has text after the '='.
    if (bare.endsWith('=') && !bare.startsWith('ndus=') && !/\s/.test(bare)) {
      return `ndus=${bare}; lang=en`;
    }
  }
  return value;
}

/** Extract the jsToken from the html bundle served at the Terabox root. */
export function jsTokenFromHtml(html: string): string {
  return getStrBetween(
    html,
    '`function%20fn%28a%29%7Bwindow.jsToken%20%3D%20a%7D%3Bfn%28%22',
    '%22%29`',
  );
}

export function getStrBetween(raw: string, start: string, end: string): string {
  const startIdx = raw.indexOf(start);
  if (startIdx === -1) return '';
  const begin = startIdx + start.length;
  const endIdx = raw.indexOf(end, begin);
  if (endIdx === -1) return '';
  return raw.slice(begin, endIdx);
}

/** Terabox wraps the final file md5; unwrap it for comparison against ours. */
export function decodeMD5(md5: string): string {
  if (md5.length !== 32) return md5;

  const restoredHexChar = ((md5.charCodeAt(9) - 'g'.charCodeAt(0)) >>> 0).toString(16);
  const o = md5.slice(0, 9) + restoredHexChar + md5.slice(10);

  const n: string[] = [];
  for (let i = 0; i < o.length; i++) {
    const orig = parseInt(o[i]!, 16);
    const xor = (orig ^ (i & 15)).toString(16);
    n.push(xor);
  }

  return n.slice(8, 16).join('') + n.slice(0, 8).join('') + n.slice(24, 32).join('') + n.slice(16, 24).join('');
}

const MiB = 1024 * 1024;
const GiB = 1024 * MiB;

/** Live-proven 2026-10-17 (davbox.tes1ing, bytes 89-100): chunk PUTs at the
 * 8 MiB premium bucket (the tier's own size for >4 GiB files) sporadically
 * exceed the Workers free-plan per-request CPU budget and answer Cloudflare
 * `503 error code: 1102` ("Worker exceeded resource limits"), and even 4 MiB
 * chunks walked into a persistent 1102 wall late in a 1000+-chunk session.
 * 2 MiB is the default targeted at completing the same sessions at roughly
 * half the per-request cost; deployments with a higher per-request budget
 * (Workers paid) may raise MAX_CHUNK_BYTES back up to the 32 MiB ceiling to
 * restore the tier's larger premium buckets. */
export const DEFAULT_MAX_CHUNK_BYTES = 2 * MiB;

/** Chunk size for slotted uploads (4 MiB free; buckets scale with tier but
 * are clamped to the deployment's CPU budget). */
export function getChunkSize(fileSize: number, isVIP: boolean, capBytes?: number): number {
  const limitSizes = [4, 8, 16, 32, 64, 128];
  // Hard 32 MiB ceiling even for VIP: the Free plan rejects request bodies
  // over ~100 MB at the edge (413 before this Worker runs), and a 64 MiB
  // chunk would hold chunk + multipart envelope in memory at once (~128 MB —
  // the whole isolate limit). VIP buys more requests, not unsafe ones.
  const request = typeof capBytes === 'number' && capBytes > 0 ? capBytes : DEFAULT_MAX_CHUNK_BYTES;
  // A cap under 1 MiB would produce zero-length chunks; clamp to the floor.
  const cap = Math.max(1, Math.min(Math.floor(request / MiB), 32));
  const tiered = isVIP
    ? (limitSizes.find((size) => fileSize <= size * GiB) ?? limitSizes[limitSizes.length - 1]!)
    : limitSizes[0]!;
  return Math.min(tiered, cap) * MiB;
}

export const MAX_FREE_FILE_BYTES = 4 * GiB;
export const MAX_PREMIUM_FILE_BYTES = 128 * GiB;

/** Join path segments the way the backend does (cleaning "..", "."). */
export function joinPath(...segments: string[]): string {
  const parts: string[] = [];
  for (const segment of segments) {
    for (const part of String(segment || '').split('/')) {
      if (part === '' || part === '.') continue;
      if (part === '..') {
        parts.pop();
      } else {
        parts.push(part);
      }
    }
  }
  return '/' + parts.join('/');
}

/** Split "/a/b/c" into { dir: "/a/b", base: "c" }. */
export function splitPath(path: string): { dir: string; base: string } {
  const clean = joinPath(path);
  const idx = clean.lastIndexOf('/');
  if (idx <= 0) return { dir: '/', base: clean.slice(1) };
  return { dir: clean.slice(0, idx), base: clean.slice(idx + 1) };
}

/** Primitive placeholder block-list used by the backend before upload. */
export function placeholderBlockList(size: number, chunkSize: number): string {
  const one = '"5910a591dd8fc18c32a8f3df4fdc1761"';
  const two = '"a5fc157d78e6ad1c7e114b056c92821e"';
  return `[${size > chunkSize ? `${one}, ${two}` : one}]`;
}