import { SELF } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { contentTypeFor, resetDavVolatileState } from '../src/webdav';
import { resetTeraboxCaches } from '../src/terabox';
import { VIEWER_HTML, VIEWER_MARKER } from '../src/viewer';
import { createOpenToken, verifyOpenToken } from '../src/login';
import { AUTH, MockTerabox, ORIGIN, basic, installMock } from './helpers';

let tb: MockTerabox;

const request = (path: string, init: RequestInit = {}): Promise<Response> =>
	SELF.fetch(ORIGIN + path, {
		...init,
		headers: { ...AUTH, ...(init.headers as Record<string, string> | undefined) },
	});

/** What a real browser sends when navigating. */
const BROWSER_ACCEPT = 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8';

beforeEach(() => {
	resetDavVolatileState();
	resetTeraboxCaches();
	tb = new MockTerabox();
	tb.seed('/docs', { isdir: 1 });
	tb.seed('/docs/readme.md', { content: '# hi\n' });
	tb.seed('/a.txt', { content: 'file bytes\n' });
	installMock(tb);
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe('viewer on collection GET (browser) vs 405 (WebDAV clients)', () => {
	it('serves the viewer page for a browser GET of a collection', async () => {
		const res = await request('/docs/', { headers: { Accept: BROWSER_ACCEPT } });
		expect(res.status).toBe(200);
		expect(res.headers.get('Content-Type')).toBe('text/html; charset=utf-8');
		expect(res.headers.get('Cache-Control')).toBe('no-store');
		const body = await res.text();
		expect(body).toContain(VIEWER_MARKER);
		expect(res.headers.get('Vary')).toBe('Accept');
	});

	it('keeps the 405 + Allow contract for WebDAV clients (no text/html Accept)', async () => {
		for (const accept of [undefined, '*/*', 'application/xml,text/xml;q=0.9']) {
			const res = await request('/docs/', { headers: accept ? { Accept: accept } : {} });
			expect(res.status).toBe(405);
			expect(res.headers.get('Allow')).toContain('PROPFIND');
			expect(res.headers.get('Allow')).toContain('GET');
		}
	});

	it('redirects a slash-less collection GET to the canonical slash form', async () => {
		// The page resolves links relative to its URL: without the trailing
		// slash a child href would escape to the parent directory. (manual —
		// the fetch client otherwise follows the 301 and hides it.)
		const res = await request('/docs', { headers: { Accept: BROWSER_ACCEPT }, redirect: 'manual' });
		expect(res.status).toBe(301);
		expect(res.headers.get('Location')).toBe(ORIGIN + '/docs/');
	});

	it('keeps HEAD on a collection at 405 (viewer is GET-only)', async () => {
		const res = await request('/docs/', { method: 'HEAD', headers: { Accept: BROWSER_ACCEPT } });
		expect(res.status).toBe(405);
	});

	it('serves file bytes unchanged when a browser GETs a file', async () => {
		const res = await request('/a.txt', { headers: { Accept: BROWSER_ACCEPT } });
		expect(res.status).toBe(200);
		expect(res.headers.get('Content-Type')).toBe('text/plain');
		expect(await res.text()).toBe('file bytes\n');
	});

	it('sends the viewer under its own CSP (script/style from this origin only)', async () => {
		const res = await request('/docs/', { headers: { Accept: BROWSER_ACCEPT } });
		const csp = res.headers.get('Content-Security-Policy') || '';
		expect(csp).toContain("script-src 'unsafe-inline'");
		expect(csp).toContain("connect-src 'self'");
		expect(csp).toContain("frame-ancestors 'none'");
		// The page has no previews anymore — no img/media surface at all —
		// and the only outbound form is sign-out back to this origin.
		expect(csp).toContain("form-action 'self'");
		expect(csp).not.toContain('img-src');
		expect(csp).not.toContain('media-src');
		// The viewer page must not inherit the file GET's sandbox (it would
		// break its own script), so the two responses carry different policies.
		expect(csp).not.toContain('sandbox');
	});

	it('answers an unauthenticated browser navigation with the public shell', async () => {
		// Per-tab sessions: the shell is static and ships no data — the page
		// signs in through its own card and every real request (listing,
		// actions, downloads) still 401s without credentials.
		const res = await SELF.fetch(ORIGIN + '/docs/', { headers: { Accept: BROWSER_ACCEPT } });
		expect(res.status).toBe(200);
		expect(res.headers.get('WWW-Authenticate')).toBeNull();
		const body = await res.text();
		expect(body).toContain(VIEWER_MARKER);
		expect(body).toContain('id="authov"');
		expect(body).not.toContain('action="/.dav-login"');
	});

	it('still 401s an unauthenticated WebDAV method with the RFC7235 challenge', async () => {
		const res = await SELF.fetch(ORIGIN + '/docs/', {
			method: 'PROPFIND',
			headers: { Depth: '1' },
		});
		expect(res.status).toBe(401);
		expect(res.headers.get('WWW-Authenticate')).toContain('Basic');
	});

	it('still 404s a slash-less browser GET of a missing path', async () => {
		const res = await request('/gone/', { headers: { Accept: BROWSER_ACCEPT } });
		expect(res.status).toBe(404);
	});
});

describe('accept negotiation (round-18 pins)', () => {
	it('refuses the viewer when text/html has q=0 and keeps the 405', async () => {
		// `.includes('text/html')` (the naive check this replaced) served the
		// viewer to a client explicitly refusing HTML.
		const res = await request('/docs/', { headers: { Accept: 'text/html;q=0, */*' } });
		expect(res.status).toBe(405);
		expect(res.headers.get('Allow')).toContain('PROPFIND');
	});

	it('serves the viewer for q>0 and for partial text/html quality', async () => {
		for (const accept of ['text/html;q=0.9, */*', 'text/html']) {
			const res = await request('/docs/', { headers: { Accept: accept } });
			expect(res.status).toBe(200);
			expect(res.headers.get('Cache-Control')).toBe('no-store');
			expect(res.headers.get('Vary')).toBe('Accept');
		}
	});

	it('405s a client that only accepts xhtml+xml', async () => {
		const res = await request('/docs/', { headers: { Accept: 'application/xhtml+xml' } });
		expect(res.status).toBe(405);
	});

	it('keeps both variants no-store', async () => {
		const viewer = await request('/docs/', { headers: { Accept: BROWSER_ACCEPT } });
		expect(viewer.headers.get('Cache-Control')).toBe('no-store');
		const notFound = await request('/docs/', { headers: { Accept: '*/*' } });
		expect(notFound.headers.get('Cache-Control')).toBe('no-store');
	});
});

describe('file GETs stay sandboxed for browsers (the security split)', () => {
	it('serves a file under the sandbox CSP + nosniff even with a browser Accept', async () => {
		// The viewer's permissive CSP is collection-only; file content (which
		// an attacker can upload) must keep the sandbox on every navigation.
		const res = await request('/a.txt', { headers: { Accept: BROWSER_ACCEPT } });
		expect(res.status).toBe(200);
		expect(res.headers.get('Content-Security-Policy')).toBe("sandbox; default-src 'none'");
		expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
	});
});

describe('download MIME types stay precise (nosniff refuses octet-stream)', () => {
	it('serves image/video/audio types with their real content type', async () => {
		tb.seed('/docs/icon.svg', { content: '<svg xmlns="http://www.w3.org/2000/svg"/>' });
		tb.seed('/docs/clip.ogv', { content: 'ogg-video-bytes' });
		tb.seed('/docs/movie.mkv', { content: 'mkv-bytes' });
		tb.seed('/docs/track.aac', { content: 'aac-bytes' });
		expect((await request('/docs/icon.svg')).headers.get('Content-Type')).toBe('image/svg+xml');
		expect((await request('/docs/clip.ogv')).headers.get('Content-Type')).toBe('video/ogg');
		expect((await request('/docs/movie.mkv')).headers.get('Content-Type')).toBe('video/x-matroska');
		expect((await request('/docs/track.aac')).headers.get('Content-Type')).toBe('audio/aac');
	});

	it('every client-typed extension resolves to a matching server media type', () => {
		// VID/IMG/AUD/TXT in the page must stay a subset of the server MIME
		// map — a wrong content type mislabels the download.
		const grab = (name: string): string[] => {
			const m = new RegExp(`var ${name} = \\[([^\\]]+)\\]`).exec(VIEWER_HTML);
			expect(m).not.toBeNull();
			return m![1]!.split(',').map((e) => e.trim().replace(/^'|'$/g, ''));
		};
		for (const ext of grab('VID')) expect(contentTypeFor(`/x.${ext}`)).toMatch(/^video\//);
		for (const ext of grab('AUD')) expect(contentTypeFor(`/x.${ext}`)).toMatch(/^audio\//);
		for (const ext of grab('IMG')) expect(contentTypeFor(`/x.${ext}`)).toMatch(/^image\//);
		for (const ext of grab('TXT').slice(0, 6)) expect(contentTypeFor(`/x.${ext}`)).toMatch(/^(text\/|application\/)/);
	});
});

describe('large uploads route through the resumable control plane', () => {
	it('branches to chunked upload past the ~100 MB edge body cap', () => {
		// A single PUT of a >100 MB file can only ever 413 at the Cloudflare
		// edge — the page must switch to begin/chunk/finalize above 64 MiB.
		expect(VIEWER_HTML).toContain('RESUMABLE_LIMIT = 64 * 1024 * 1024');
		expect(VIEWER_HTML).toMatch(/if \(file\.size > RESUMABLE_LIMIT\) return putResumable\(/);
		expect(VIEWER_HTML).toContain("base + '.resumable'");
		// begin's JSON path is mount-relative (davPath space): the mount
		// prefix must be stripped or toTera stats a bogus upstream parent
		expect(VIEWER_HTML).toContain("base.slice(mountHome().length)");
		// create-only handshake identical to PUT: If-None-Match on begin,
		// confirm, then a second begin without it
		expect(VIEWER_HTML).toMatch(/begin\(true\)[\s\S]{0,600}begin\(false\)/);
		// chunk PUTs report byte progress; finalize completes; failures
		// cancel the session instead of orphaning chunks
		expect(VIEWER_HTML).toContain("'.resumable/' + id + '/' + index");
		expect(VIEWER_HTML).toContain('/finalize');
		expect(VIEWER_HTML).toContain(".resumable/' + id, { method: 'DELETE'");
	});
});

describe('the embedded page script parses', () => {
	it('compiles the viewer page JS (a syntax error would ship untested)', () => {
		// The page lives inside a template literal: tsc never parses it as
		// JavaScript, so the gate would stay green on a broken script.
		const match = /<script>([\s\S]*)<\/script>\s*<\/body>/.exec(VIEWER_HTML);
		expect(match).not.toBeNull();
		expect(() => new Function(match![1]!)).not.toThrow();
	});
});

describe('file GETs download as attachments', () => {
	it('sends Content-Disposition for every file GET', async () => {
		const res = await request('/a.txt', { headers: { Accept: BROWSER_ACCEPT } });
		expect(res.status).toBe(200);
		expect(res.headers.get('Content-Disposition')).toBe(
			`attachment; filename="a.txt"; filename*=UTF-8''a.txt`,
		);
	});

	it('RFC5987-encodes unicode filenames with an ASCII fallback', async () => {
		tb.seed('/docs/résumé notes.txt', { content: 'unicode' });
		const res = await request('/docs/r%C3%A9sum%C3%A9%20notes.txt');
		expect(res.status).toBe(200);
		expect(res.headers.get('Content-Disposition')).toBe(
			`attachment; filename="r_sum_ notes.txt"; filename*=UTF-8''r%C3%A9sum%C3%A9%20notes.txt`,
		);
	});
});

describe('per-tab viewer session (no persisted cookie)', () => {
	// The credential never becomes a cookie: the page keeps it in
	// sessionStorage (which dies with the tab), and /.dav-login is only a
	// validation endpoint the page's own sign-in card posts to. Closing the
	// tab therefore ends the session — nothing is saved anywhere.
	const login = (user: string, pass: string, extra: Record<string, string> = {}) =>
		SELF.fetch(ORIGIN + '/.dav-login', {
			method: 'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...extra },
			body: new URLSearchParams({ user, pass }).toString(),
		});

	it('answers valid credentials with ok JSON and never a cookie', async () => {
		const res = await login('test', 'pass');
		expect(res.status).toBe(200);
		expect(res.headers.get('Content-Type')).toContain('application/json');
		expect(res.headers.get('Cache-Control')).toBe('no-store');
		expect(await res.json()).toEqual({ ok: true });
		expect(res.headers.get('Set-Cookie')).toBeNull();
	});

	it('rejects a wrong password with 401 JSON and no Basic prompt', async () => {
		const res = await login('test', 'wrong-password');
		expect(res.status).toBe(401);
		const body = (await res.json()) as { error: string };
		expect(body.error).toContain('Wrong user or password');
		expect(res.headers.get('Set-Cookie')).toBeNull();
		// 401 + WWW-Authenticate on a background fetch pops a native Basic
		// dialog over the page's own sign-in card — keep the challenge off.
		expect(res.headers.get('WWW-Authenticate')).toBeNull();
	});

	it('accepts the unicode credential pair', async () => {
		expect((await login('üser', 'pässword')).status).toBe(200);
	});

	it('keeps the RFC7235 challenge when wrong Basic IS presented', async () => {
		const res = await SELF.fetch(ORIGIN + '/docs/', {
			headers: { Authorization: basic('test', 'wrong-password'), Accept: BROWSER_ACCEPT },
		});
		expect(res.status).toBe(401);
		expect(res.headers.get('WWW-Authenticate')).toContain('Basic');
	});

	it('treats a legacy session cookie as inert (shell for HTML, 401 for PROPFIND)', async () => {
		const html = await SELF.fetch(ORIGIN + '/docs/', {
			headers: { Cookie: 'davbox_session=forged.signature', Accept: BROWSER_ACCEPT },
		});
		expect(html.status).toBe(200);
		expect(await html.text()).toContain(VIEWER_MARKER);

		const propfind = await SELF.fetch(ORIGIN + '/docs/', {
			method: 'PROPFIND',
			headers: { Cookie: 'davbox_session=forged.signature', Depth: '1' },
		});
		expect(propfind.status).toBe(401);
		expect(propfind.headers.get('WWW-Authenticate')).toContain('Basic');
	});

	it('keeps the shell off the reserved dot-paths', async () => {
		// /.dav-login and /.dav-logout are pre-gate endpoints (GETs answer
		// 405 below); /.dav-sign sits inside the gate, so an
		// unauthenticated GET at it is probing → the RFC 7235 challenge.
		const res = await SELF.fetch(ORIGIN + '/.dav-sign', { headers: { Accept: BROWSER_ACCEPT } });
		expect(res.status).toBe(401);
		expect(res.headers.get('WWW-Authenticate')).toContain('Basic');
	});

	it('logs out: clears a legacy cookie and redirects home', async () => {
		const res = await SELF.fetch(ORIGIN + '/.dav-logout', {
			method: 'POST',
			redirect: 'manual',
			headers: { Cookie: 'davbox_session=old.token', Referer: ORIGIN + '/docs/', 'Content-Type': 'application/x-www-form-urlencoded' },
			body: '',
		});
		expect(res.status).toBe(303);
		expect(res.headers.get('Location')).toBe('/docs/');
		expect(res.headers.get('Set-Cookie')).toContain('davbox_session=;');
		expect(res.headers.get('Set-Cookie')).toContain('Max-Age=0');
	});

	it('is idempotent: logout without a session still redirects cleanly', async () => {
		const res = await SELF.fetch(ORIGIN + '/.dav-logout', {
			method: 'POST',
			redirect: 'manual',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
			body: 'next=%2Fdocs%2F',
		});
		expect(res.status).toBe(303);
		expect(res.headers.get('Location')).toBe('/docs/');
	});

	it('refuses a cross-site login post', async () => {
		const res = await login('test', 'pass', { 'Sec-Fetch-Site': 'cross-site' });
		expect(res.status).toBe(403);
		expect(res.headers.get('Set-Cookie')).toBeNull();
	});

	it('keeps the endpoints POST-only', async () => {
		for (const path of ['/.dav-login', '/.dav-logout']) {
			const res = await SELF.fetch(ORIGIN + path);
			expect(res.status, path).toBe(405);
			expect(res.headers.get('Allow')).toBe('POST');
		}
		// /.dav-sign is inside the gate: unauthenticated → 401 (pinned
		// above), authenticated-only clients may probe it → 405 here.
		const res = await SELF.fetch(ORIGIN + '/.dav-sign', { headers: { ...AUTH } });
		expect(res.status).toBe(405);
		expect(res.headers.get('Allow')).toBe('POST');
	});
});

describe('open tokens (signed 60 s download links)', () => {
	// A file open/download is a real navigation — it cannot carry
	// sessionStorage credentials. The page mints a short-lived signed URL
	// and navigates to that: stateless HMAC, bound to the exact decoded
	// path, GET/HEAD only, one minute to live.
	const USERS = 'test:pass,üser:pässword';
	const sign = (path: string) =>
		SELF.fetch(ORIGIN + '/.dav-sign', {
			method: 'POST',
			headers: { ...AUTH, 'Content-Type': 'application/json' },
			body: JSON.stringify({ path }),
		});

	it('mints and verifies a token bound to the exact decoded path', async () => {
		const t = await createOpenToken(USERS, '/docs/readme.md', 1000);
		expect(await verifyOpenToken(USERS, '/docs/readme.md', t, 1059)).toBe(true);
		expect(await verifyOpenToken(USERS, '/docs/other.md', t, 1000)).toBe(false);
		expect(await verifyOpenToken(USERS, '/docs/readme.md', t, 1060)).toBe(false);
	});

	it('rejects forged and malformed tokens', async () => {
		const t = await createOpenToken(USERS, '/docs/readme.md', 1000);
		expect(await verifyOpenToken('other:key', '/docs/readme.md', t, 1000)).toBe(false);
		expect(await verifyOpenToken(USERS, '/docs/readme.md', 'nope', 1000)).toBe(false);
		expect(await verifyOpenToken(USERS, '/docs/readme.md', 'a.b.c', 1000)).toBe(false);
		expect(await verifyOpenToken(USERS, '/docs/readme.md', '', 1000)).toBe(false);
	});

	it('signs for an authenticated client and the URL opens with no other credentials', async () => {
		const res = await sign('/docs/readme.md');
		expect(res.status).toBe(200);
		const { url, ttl } = (await res.json()) as { url: string; ttl: number };
		expect(ttl).toBe(60);
		expect(url).toMatch(/^\/docs\/readme\.md\?ot=/);
		const dl = await SELF.fetch(ORIGIN + url);
		expect(dl.status).toBe(200);
		expect(await dl.text()).toBe('# hi\n');
	});

	it('401s a forged token with the RFC 7235 challenge', async () => {
		const res = await SELF.fetch(ORIGIN + '/docs/readme.md?ot=forged.sig');
		expect(res.status).toBe(401);
		expect(res.headers.get('WWW-Authenticate')).toContain('Basic');
	});

	it('refuses state-changing methods even with a valid token', async () => {
		const { url } = (await (await sign('/docs/readme.md')).json()) as { url: string };
		const put = await SELF.fetch(ORIGIN + url, { method: 'PUT', body: 'overwrite' });
		expect(put.status).toBe(401);
		const del = await SELF.fetch(ORIGIN + url, { method: 'DELETE' });
		expect(del.status).toBe(401);
	});

	it('refuses signing without credentials', async () => {
		const res = await SELF.fetch(ORIGIN + '/.dav-sign', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ path: '/docs/readme.md' }),
		});
		expect(res.status).toBe(401);
		expect(res.headers.get('WWW-Authenticate')).toContain('Basic');
	});

	it('rejects traversal, escapes and junk in sign paths', async () => {
		for (const p of ['../etc', 'http://evil/x', '/docs/../secret', '', 'docs/x', '/docs//x', '/docs/x?y', '/docs/x#z']) {
			const res = await sign(p);
			expect(res.status, JSON.stringify(p)).toBe(400);
		}
	});
});
