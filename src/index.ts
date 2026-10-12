import { TeraboxClient, TeraboxError, errIsNum } from './terabox';
import { errorResponse, handleWebDav } from './webdav';
import { createDavStore, DavState } from './davstate';
import { wantsViewer } from './viewer';
import {
  crossSitePost,
  createSessionToken,
  loginPageResponse,
  sanitizeNext,
  sessionClearCookie,
  sessionCookieValue,
  sessionSetCookie,
  sessionUsername,
} from './login';
import type { Env } from './types';

// The Durable Object holding advisory WebDAV state (locks + dead props).
// Must be re-exported from the main bundle for the runtime to resolve the
// `DAV_STATE` binding's class_name.
export { DavState };

export interface Credential {
  username: string;
  password: string;
}

/** Constant-time string equality (see node:crypto timingSafeEqual behaviour). */
export function constantTimeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * Parse the USERS mapping. Fail-closed contract: returns null when the
 * configuration is unusable — a colon-less entry, an empty password, or a
 * duplicate username must never silently drop an account or truncate a
 * password into a weaker working credential (comma is a separator:
 * `bob:h,unter` must NOT become the credential bob:h). Leading/trailing
 * whitespace is stripped from each entry; credentials must not begin or end
 * with whitespace, and commas/newlines cannot appear inside a credential.
 */
export function parseCredentials(users: string | undefined): Credential[] | null {
  if (!users) return null;
  const entries = users
    .split(/[\r\n,]+/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (entries.length === 0) return null;
  const creds: Credential[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    const idx = entry.indexOf(':');
    if (idx < 1) return null;
    const password = entry.slice(idx + 1);
    if (!password) return null;
    const username = entry.slice(0, idx);
    if (seen.has(username)) return null;
    seen.add(username);
    creds.push({ username, password });
  }
  return creds;
}

function validBasicAuth(request: Request, env: Env): boolean {
  const header = request.headers.get('Authorization') || '';
  // RFC 7235 §2.1: the auth-scheme is case-insensitive ("basic", "BASIC").
  if (header.slice(0, 6).toLowerCase() !== 'basic ') return false;
  const creds = parseCredentials(env.USERS);
  if (!creds || creds.length === 0) return false;

  // RFC 7617: the challenge advertises charset="UTF-8", so the client
  // base64s the UTF-8 bytes of the credentials. `atob` alone yields one
  // char per byte (latin1), which never equals a multi-byte password —
  // decode the bytes as UTF-8 so a non-ASCII password can authenticate.
  // For ASCII (the common case) both paths produce the identical string.
  let decoded: string;
  try {
    const bytes = Uint8Array.from(atob(header.slice(6)), (char) => char.charCodeAt(0));
    decoded = new TextDecoder('utf-8').decode(bytes);
  } catch {
    return false;
  }
  const sep = decoded.indexOf(':');
  if (sep === -1) return false;
  return credsMatch(creds, decoded.slice(0, sep), decoded.slice(sep + 1));
}

/**
 * Branchless full-list comparison: every entry gets BOTH compares on every
 * attempt and the loop never exits early, so total work depends only on the
 * configured credential count — never on whether a presented username
 * exists (the `.some(a && b)` composition short-circuited the password
 * compare for unknown usernames: a credential-existence oracle). Residual:
 * constantTimeEquals still early-returns on length mismatch (node's
 * timingSafeEqual does too); length is not treated as a secret here.
 * Shared by the Basic gate and the login form.
 */
function credsMatch(creds: Credential[], username: string, password: string): boolean {
  let matched = 0;
  for (const c of creds) {
    const userOk = Number(constantTimeEquals(c.username, username));
    const passOk = Number(constantTimeEquals(c.password, password));
    matched |= userOk & passOk;
  }
  return matched === 1;
}

/**
 * Errnos meaning "the credentials/session/token presented are not
 * acceptable". Used in BOTH places that decide 401 — statusFor and the
 * fetch handler's TeraboxError branch — so the table and the Basic
 * challenge can never drift apart: a 401 without WWW-Authenticate makes
 * rclone/litmus/davfs never resend credentials, turning a mid-session
 * expiry into a permanent failure.
 *   -6 / -1 / 6: login/verification failure (expired ndus, wrong origin)
 *   -19: upstream wants a verification code
 *   450016 / 400141 / 4000023: invalid session / gate / jsToken
 */
const AUTH_ERRNOS = new Set([-6, -1, 6, -19, 450016, 400141, 4000023]);

function errnoIn(error: unknown, set: Set<number>): boolean {
  return error instanceof TeraboxError && set.has(error.errno);
}

function statusFor(error: unknown): number {
  if (errnoIn(error, AUTH_ERRNOS)) return 401;
  if (errIsNum(error, -9)) return 404;
  if (errIsNum(error, -8)) return 409;
  // 4 "new file name error" / 2 "required parameters missing": caller-side
  // faults — no retry can succeed, and a 500 would blame this server.
  if (errIsNum(error, 4) || errIsNum(error, 2)) return 400;
  // 5 "illegal target directory": the target's state conflicts with the
  // operation — the client recovers by re-reading the namespace (409).
  if (errIsNum(error, 5)) return 409;
  // 7 / 11 "no access permission": ACL, not credentials — a 401 would loop
  // the client through re-authentication that cannot help.
  if (errIsNum(error, 7) || errIsNum(error, 11)) return 403;
  // 15 "operation failed": unclassifiable upstream-side fault → gateway.
  if (errIsNum(error, 15)) return 502;
  // -10 / -32: "Your space is insufficient"; 58: "File is too large for
  // your plan" — every storage-capacity refusal is 507 per RFC 4918
  // §9.3.1/§9.7.1, so davfs/rclone can distinguish "disk full" from a
  // server fault (docs/terabox-limits.md promised this mapping).
  if (errIsNum(error, -10) || errIsNum(error, -32) || errIsNum(error, 58)) return 507;
  // -7: Terabox rejects the file name — a client error, not a server fault.
  if (errIsNum(error, -7)) return 403;
  // -11 "parent folder missing" (a namespace conflict, RFC 4918 §9.7.1/§9.9.3)
  // and 12 "some files already exist" (conflicting destination): both are
  // resolved by the client re-reading the namespace, so 409 — not a 500.
  if (errIsNum(error, -11) || errIsNum(error, 12)) return 409;
  // -22: the entry sits in a shared folder the caller may not change.
  if (errIsNum(error, -22)) return 403;
  // 31045 "user not exists": the request reached a wrong-region upload
  // cluster — an upstream routing problem, not ours.
  if (errIsNum(error, 31045)) return 502;
  // -5: an upstream HTTP hop failed — that's a gateway problem, not ours.
  if (errIsNum(error, -5)) return 502;
  // Any failure that already stamped an upstream HTTP status is somebody
  // else's answer we could not translate — a gateway error, never a 500
  // that blames this worker.
  if (error instanceof TeraboxError && error.httpStatus !== undefined) return 502;
  return 500;
}

const worker: ExportedHandler<Env> = {
  async fetch(request, env) {
    const url = new URL(request.url);

    const log = (level: string, message: string, extra?: unknown) => {
      const tag = env.LOG_PREFIX ? `[${env.LOG_PREFIX}] ` : '';
      if (extra !== undefined) {
        // eslint-disable-next-line no-console
        console[level === 'error' ? 'error' : 'log'](`${tag}${message}`, extra);
      } else {
        // eslint-disable-next-line no-console
        console[level === 'error' ? 'error' : 'log'](`${tag}${message}`);
      }
    };

    // Fail closed: an unconfigured or malformed USERS mapping never exposes data.
    const configuredCreds = parseCredentials(env.USERS);
    if (!configuredCreds || configuredCreds.length === 0) {
      log('error', 'WebDAV server disabled: USERS is unset, empty, or malformed');
      return withSecurityHeaders(errorResponse('WebDAV server not configured', 500));
    }
    if (!env.COOKIE) {
      log('error', 'WebDAV server disabled: COOKIE is unset');
      return withSecurityHeaders(errorResponse('WebDAV server not configured', 500));
    }
    // The session endpoints ARE the auth path — they run before the gate.
    if (url.pathname === '/.dav-login' || url.pathname === '/.dav-logout') {
      return withSecurityHeaders(await handleSessionEndpoint(request, url.pathname, env, configuredCreds));
    }

    // Basic first (WebDAV clients and scripts send it on every request),
    // then the browser session cookie. Fail closed for every method,
    // CORS preflight included: a preflight branch that answered 204
    // without credentials was both an auth bypass on an otherwise
    // airtight surface and a config-state oracle — and it emitted no
    // Access-Control-Allow-* headers anyway, so it never enabled
    // cross-origin use in the first place.
    const basicOk = validBasicAuth(request, env);
    let sessionUser: string | null = null;
    if (!basicOk) {
      const token = sessionCookieValue(request);
      if (token) sessionUser = await sessionUsername(token, env.USERS as string, configuredCreds);
    }
    if (!basicOk && sessionUser === null) {
      // A browser page navigation with no credentials at all gets the
      // sign-in form: Basic prompts aren't reliably cached (close the tab,
      // the prompt returns — and a PUT without credentials fails as a bare
      // network error). Anything that *presented* Basic keeps the RFC 7235
      // challenge; so does every non-browser method.
      const presentedBasic =
        (request.headers.get('Authorization') || '').slice(0, 6).toLowerCase() === 'basic ';
      if (!presentedBasic && wantsViewer(request)) {
        return withSecurityHeaders(loginPageResponse(url.pathname));
      }
      return withSecurityHeaders(errorResponse('Unauthorized', 401, undefined, WWW_AUTHENTICATE));
    }

    const client = new TeraboxClient(env.COOKIE, env.TERABOX_DOMAIN, {
      jsToken: env.JSTOKEN,
      minGapMs: env.MIN_GAP_MS !== undefined ? Number(env.MIN_GAP_MS) : undefined,
    });

    const started = Date.now();
    // No unconditional per-request log line: with observability enabled each
    // console call is a billable event (one per request adds up to the
    // 200k/day Free limit before any real debugging starts). The `slow`
    // line below and every error path still log with method + path, which
    // is what post-mortems actually need.
    try {
      const response = await handleWebDav(
        request,
        client,
        { basePath: env.PATH, rootId: env.ROOT_ID, sessionAuthed: sessionUser !== null },
        createDavStore(env),
      );
      const elapsed = Date.now() - started;
      if (elapsed > 500) log('info', `slow ${request.method} ${url.pathname} (${elapsed}ms)`);
      return withSecurityHeaders(response);
    } catch (error) {
      if (error instanceof TeraboxError) {
        log('error', `terabox errno ${error.errno}: ${error.message}`, { path: url.pathname, step: error.step });
        // Additive diagnostics: which backend stage failed, with which errno,
        // plus the cookie *names* in play (never values) to catch auth gaps.
        const detail = {
          errno: error.errno,
          ...(error.step ? { step: error.step } : {}),
          ...(error.upstream ? { upstream: error.upstream } : {}),
          cookieKeys: String(env.COOKIE)
            .split(';')
            .map((part) => part.split('=')[0]?.trim())
            .filter(Boolean),
        };
        if (errnoIn(error, AUTH_ERRNOS)) {
          // Same challenge as the initial 401: without it neon/litmus and
          // Windows Mini-Redirector never resend credentials, so a mid-session
          // expiry becomes a permanent failure instead of a re-auth.
          return withSecurityHeaders(
            errorResponse('Terabox session expired or invalid', 401, detail, WWW_AUTHENTICATE),
          );
        }
        return withSecurityHeaders(errorResponse(error.message, statusFor(error), detail));
      }
      log('error', 'unhandled error', { path: url.pathname, message: error instanceof Error ? error.message : String(error) });
      return withSecurityHeaders(errorResponse('Internal Server Error', 500));
    }
  },
};

/**
 * Defense-in-depth on every response leaving the fetch handler:
 * `nosniff` stops a browser from reinterpreting a response as some other
 * type if a content-type is ever wrong or missing. (File GETs add their own
 * sandbox CSP in handleGet — the wrapper cannot tell content from API.)
 * Runtime-constructed responses allow header mutation; an immutable
 * passthrough (if any ever appears) ships without the header rather than
 * throwing.
 */
function withSecurityHeaders(response: Response): Response {
  try {
    response.headers.set('X-Content-Type-Options', 'nosniff');
  } catch {
    // immutable headers — leave as-is
  }
  return response;
}

/** POST body for the login/logout forms; >8 KB is not a form. */
async function readFormBody(request: Request): Promise<string | null> {
  const reader = request.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const result = await reader.read();
    if (result.done) break;
    total += result.value.byteLength;
    if (total > 8192) {
      try {
        await reader.cancel();
      } catch {
        // already gone — the 413 still stands
      }
      return null;
    }
    chunks.push(result.value);
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}

/**
 * `POST /.dav-login` validates the form and answers 303 + session cookie;
 * `POST /.dav-logout` clears it (idempotent — an absent cookie still
 * gets a clean redirect). Both are POST-only and cross-site-post
 * resistant; neither ever touches Terabox.
 */
async function handleSessionEndpoint(
  request: Request,
  pathname: string,
  env: Env,
  creds: Credential[],
): Promise<Response> {
  if (request.method !== 'POST') {
    return errorResponse('Method Not Allowed', 405, undefined, { Allow: 'POST' });
  }
  if (crossSitePost(request)) {
    return errorResponse('Cross-site request rejected', 403);
  }
  const body = await readFormBody(request);
  if (body === null) return errorResponse('Payload Too Large', 413);
  const params = new URLSearchParams(body);
  let next = sanitizeNext(params.get('next'));

  if (pathname === '/.dav-logout') {
    // The sign-out form ships an empty next on purpose (the page URL is
    // dynamic): fall back to the same-origin Referer so the redirect
    // lands back on the collection the user was viewing.
    if (!next) {
      const referer = request.headers.get('Referer');
      if (referer) {
        try {
          const ref = new URL(referer);
          if (ref.origin === new URL(request.url).origin) next = ref.pathname + ref.search;
        } catch {
          // malformed referer — use the root below
        }
      }
    }
    next = next || '/';
    return new Response(null, {
      status: 303,
      headers: { Location: next, 'Set-Cookie': sessionClearCookie(), 'Cache-Control': 'no-store' },
    });
  }

  next = next || '/';
  const username = params.get('user') ?? '';
  const password = params.get('pass') ?? '';
  if (credsMatch(creds, username, password)) {
    const token = await createSessionToken(username, env.USERS as string);
    return new Response(null, {
      status: 303,
      headers: { Location: next, 'Set-Cookie': sessionSetCookie(token), 'Cache-Control': 'no-store' },
    });
  }
  // Same branchless compare as Basic, plus a floor on guessing speed.
  await new Promise((resolve) => setTimeout(resolve, 400));
  return loginPageResponse(next, 'Wrong user or password.', username);
}

// RFC 7235 §3.1: a 401 must carry the challenge on EVERY code path.
const WWW_AUTHENTICATE = {
  'WWW-Authenticate': 'Basic realm="terabox WebDAV", charset="UTF-8"',
};

export default worker;