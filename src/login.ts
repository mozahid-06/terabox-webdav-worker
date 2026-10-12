/**
 * Browser session sign-in for the viewer.
 *
 * Browsers do not reliably cache Basic credentials (close the tab, the
 * prompt comes back — and a PUT made without them fails as a bare network
 * error), so a signed HttpOnly cookie carries the browser session instead.
 * WebDAV clients are untouched: they keep sending Basic on every request
 * and are checked first.
 *
 * The cookie is a stateless HMAC over `b64url(user)|exp` keyed by the raw
 * USERS string: rotating USERS invalidates every session for free, and no
 * new configuration exists to forget. It never carries the password.
 *
 * Security posture:
 *   - HttpOnly (no page script can read it), Secure, SameSite=Strict
 *     (cross-site posts don't carry it), Path=/ (covers every mount).
 *   - 30-day expiry, checked on every request; a token signed for a
 *     plausible window only (grace beyond TTL is rejected).
 *   - Login/logout posts reject cross-site fetches: workers.dev siblings
 *     are same-*site* but hostile, so only Sec-Fetch-Site same-origin/
 *     none (or no header at all — non-browser clients) pass.
 *   - The login page ships `default-src 'none'` + form-action 'self',
 *     no-store, and escapes both the redirect target and any error text.
 */
import type { Credential } from './index';

export const SESSION_COOKIE_NAME = 'davbox_session';
export const SESSION_MAX_AGE = 30 * 24 * 3600;

const textEncoder = new TextEncoder();

function b64urlFromBytes(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function bytesFromB64url(s: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+$/.test(s)) return null;
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  try {
    const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + pad);
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

let keyCache: { raw: string; key: CryptoKey } | null = null;
async function sessionKey(usersRaw: string): Promise<CryptoKey> {
  if (keyCache && keyCache.raw === usersRaw) return keyCache.key;
  const key = await crypto.subtle.importKey(
    'raw',
    textEncoder.encode(usersRaw),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
  keyCache = { raw: usersRaw, key };
  return key;
}

/** Mint a session token for `username`, valid `SESSION_MAX_AGE` seconds from `nowSec`. */
export async function createSessionToken(
  username: string,
  usersRaw: string,
  nowSec: number = Math.floor(Date.now() / 1000),
): Promise<string> {
  const exp = nowSec + SESSION_MAX_AGE;
  const user = b64urlFromBytes(textEncoder.encode(username));
  const key = await sessionKey(usersRaw);
  const sig = new Uint8Array(
    await crypto.subtle.sign('HMAC', key, textEncoder.encode(`${user}|${exp}`)),
  );
  return `${user}.${exp}.${b64urlFromBytes(sig)}`;
}

/**
 * Verify a token: signature, expiry window, then that the user still
 * exists in the configured USERS list (deleting an account kills its
 * sessions; rotating USERS kills all of them via the key).
 */
export async function sessionUsername(
  token: string,
  usersRaw: string,
  creds: Credential[],
  nowSec: number = Math.floor(Date.now() / 1000),
): Promise<string | null> {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [userB, expRaw, sigB] = parts;
  if (!/^\d+$/.test(expRaw!)) return null;
  const exp = Number(expRaw);
  if (!Number.isSafeInteger(exp)) return null;
  if (exp <= nowSec || exp > nowSec + SESSION_MAX_AGE + 86400) return null;
  const userBytes = bytesFromB64url(userB!);
  const sig = bytesFromB64url(sigB!);
  if (!userBytes || !sig) return null;
  const key = await sessionKey(usersRaw);
  const ok = await crypto.subtle.verify(
    'HMAC',
    key,
    sig,
    textEncoder.encode(`${userB}|${exp}`),
  );
  if (!ok) return null;
  let username: string;
  try {
    username = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(userBytes);
  } catch {
    return null;
  }
  if (!creds.some((c) => c.username === username)) return null;
  return username;
}

/** Read the session value from the Cookie header (any cookie list form). */
export function sessionCookieValue(request: Request): string | null {
  const header = request.headers.get('Cookie');
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== SESSION_COOKIE_NAME) continue;
    const value = part.slice(eq + 1).trim();
    return value || null;
  }
  return null;
}

export function sessionSetCookie(token: string): string {
  return `${SESSION_COOKIE_NAME}=${token}; Path=/; Max-Age=${SESSION_MAX_AGE}; HttpOnly; Secure; SameSite=Strict`;
}

export function sessionClearCookie(): string {
  return `${SESSION_COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict`;
}

/**
 * Redirect targets are same-origin paths only. `//host` and backslash
 * variants are scheme-relative in some UAs — rejected outright.
 */
export function sanitizeNext(raw: string | null | undefined): string | null {
  if (!raw) return null;
  if (!raw.startsWith('/') || raw.startsWith('//') || raw.includes('\\')) return null;
  return raw;
}

/**
 * True for a cross-site state-changing post. Absent header = non-browser
 * client (curl, tests) with no ambient authority to abuse — allowed.
 * Note `same-site` is deliberately rejected: evil.workers.dev is
 * same-site with this worker.
 */
export function crossSitePost(request: Request): boolean {
  const site = request.headers.get('Sec-Fetch-Site');
  return site !== null && site !== 'same-origin' && site !== 'none';
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const LOGIN_CSP = [
  "default-src 'none'",
  "style-src 'unsafe-inline'",
  "form-action 'self'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
].join('; ');

/**
 * The sign-in card. Pure HTML form — works with JavaScript disabled; the
 * POST answers with a 303 back to `next` on success.
 */
export function loginPageResponse(next: string, error?: string): Response {
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sign in</title>
<style>
:root {
  --void: #0C1617;
  --petrol: #122123;
  --line: #1E3638;
  --paper: #E6F0EE;
  --fog: #8CA5A2;
  --brass: #E3A857;
  --brass-ink: #171104;
  --coral: #E8705A;
}
* { box-sizing: border-box; }
body {
  margin: 0;
  min-height: 100vh;
  display: grid;
  place-items: center;
  background: var(--void);
  color: var(--paper);
  font: 13px/1.5 ui-sans-serif, system-ui, "Segoe UI", Roboto, sans-serif;
}
.card {
  width: min(360px, calc(100vw - 40px));
  background: var(--petrol);
  border: 1px solid var(--line);
  border-top: 3px solid var(--brass);
  border-radius: 12px;
  padding: 30px 28px 28px;
}
h1 {
  margin: 0 0 3px;
  font-size: 21px;
  font-weight: 600;
  letter-spacing: -0.015em;
}
h1 .dot { color: var(--brass); }
.sub { margin: 0 0 22px; color: var(--fog); font-size: 13px; }
.err {
  margin: 0 0 16px;
  padding: 10px 12px;
  border: 1px solid color-mix(in srgb, var(--coral) 45%, var(--line));
  border-radius: 8px;
  background: color-mix(in srgb, var(--coral) 10%, var(--void));
  color: #F2A08D;
  font-size: 13px;
}
label { display: block; margin-bottom: 15px; font-size: 12.5px; color: var(--fog); }
input {
  display: block;
  width: 100%;
  margin-top: 6px;
  padding: 9px 11px;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--void);
  color: var(--paper);
  font: 14px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  transition: border-color 120ms ease;
}
input:hover { border-color: #35555A; }
input:focus { outline: 2px solid var(--brass); outline-offset: 1px; border-color: var(--brass); }
button {
  width: 100%;
  margin-top: 4px;
  padding: 10px 12px;
  border: 1px solid var(--brass);
  border-radius: 8px;
  background: var(--brass);
  color: var(--brass-ink);
  font: 600 14px ui-sans-serif, system-ui, sans-serif;
  cursor: pointer;
  transition: filter 120ms ease;
}
button:hover { filter: brightness(1.07); }
button:active { filter: brightness(0.93); }
button:focus-visible { outline: 2px solid var(--brass); outline-offset: 2px; }
</style>
</head>
<body>
<main class="card">
  <h1>davbox<span class="dot">.</span></h1>
  <p class="sub">Sign in to browse and back up files.</p>
  ${error ? `<p class="err" role="alert">${escapeHtml(error)}</p>` : ''}
  <form method="post" action="/.dav-login" autocomplete="on">
    <input type="hidden" name="next" value="${escapeHtml(next)}">
    <label>User <input name="user" autocomplete="username" required autofocus></label>
    <label>Password <input name="pass" type="password" autocomplete="current-password" required></label>
    <button type="submit">Sign in</button>
  </form>
</main>
</body>
</html>
`;
  return new Response(html, {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Security-Policy': LOGIN_CSP,
    },
  });
}
