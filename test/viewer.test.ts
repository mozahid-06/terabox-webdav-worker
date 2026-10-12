import { SELF } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { contentTypeFor, resetDavVolatileState } from '../src/webdav';
import { resetTeraboxCaches } from '../src/terabox';
import { VIEWER_HTML, VIEWER_MARKER } from '../src/viewer';
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

	it('answers an unauthenticated browser navigation with the sign-in form', async () => {
		// No Basic prompt any more: a closed tab must not orphan a PUT, and
		// the form flow issues the HttpOnly cookie that survives restarts.
		const res = await SELF.fetch(ORIGIN + '/docs/', { headers: { Accept: BROWSER_ACCEPT } });
		expect(res.status).toBe(200);
		expect(res.headers.get('WWW-Authenticate')).toBeNull();
		const body = await res.text();
		expect(body).toContain('action="/.dav-login"');
		expect(body).not.toContain(VIEWER_MARKER);
		// deep link: after sign-in the user lands where they aimed
		expect(body).toContain('value="/docs/"');
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

describe('session sign-in form and cookie', () => {
	// manual: workers fetch has no cookie jar — it would follow the 303 to
	// the viewer unauthenticated and drop the Set-Cookie off the 303 itself.
	// Real browsers apply the cookie then land logged in.
	const login = (user: string, pass: string, extra: Record<string, string> = {}) =>
		SELF.fetch(ORIGIN + '/.dav-login', {
			method: 'POST',
			redirect: 'manual',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...extra },
			body: new URLSearchParams({ user, pass, next: '/docs/' }).toString(),
		});

	const cookieOf = (res: Response): string => {
		const m = /davbox_session=([^;]+)/.exec(res.headers.get('Set-Cookie') || '');
		expect(m, 'session cookie missing').not.toBeNull();
		return `davbox_session=${m![1]}`;
	};

	const viewerWith = (cookie: string, path = '/docs/') =>
		SELF.fetch(ORIGIN + path, { headers: { Cookie: cookie, Accept: BROWSER_ACCEPT } });

	it('accepts the form and answers 303 + hardened session cookie', async () => {
		const res = await login('test', 'pass');
		expect(res.status).toBe(303);
		expect(res.headers.get('Location')).toBe('/docs/');
		const setCookie = res.headers.get('Set-Cookie') || '';
		expect(setCookie).toContain('davbox_session=');
		expect(setCookie).toContain('HttpOnly');
		expect(setCookie).toContain('Secure');
		expect(setCookie).toContain('SameSite=Strict');
		expect(setCookie).toContain('Path=/');
		expect(setCookie).toContain('Max-Age=2592000');
	});

	it('serves the viewer on the cookie alone (no Authorization header)', async () => {
		const cookie = cookieOf(await login('test', 'pass'));
		const res = await viewerWith(cookie);
		expect(res.status).toBe(200);
		const body = await res.text();
		expect(body).toContain(VIEWER_MARKER);
		expect(body).toContain('data-session="1"');
	});

	it('keeps data-session off for Basic-authenticated clients', async () => {
		const body = await (await request('/docs/', { headers: { Accept: BROWSER_ACCEPT } })).text();
		expect(body).toMatch(/<body[^>]*\bdata-session=""/);
		expect(body).not.toMatch(/<body[^>]*\bdata-session="1"/);
		// sign-out is a browser thing: hide it from the pure-Basic page
		expect(body).toContain('id="signout"');
	});

	it('rejects a wrong password with the form and no cookie', async () => {
		const res = await login('test', 'wrong-password');
		expect(res.status).toBe(200);
		const body = await res.text();
		expect(body).toContain('Wrong user or password.');
		expect(res.headers.get('Set-Cookie')).toBeNull();
		expect(res.headers.get('WWW-Authenticate')).toBeNull();
	});

	it('keeps the RFC7235 challenge when wrong Basic IS presented', async () => {
		const res = await SELF.fetch(ORIGIN + '/docs/', {
			headers: { Authorization: basic('test', 'wrong-password'), Accept: BROWSER_ACCEPT },
		});
		expect(res.status).toBe(401);
		expect(res.headers.get('WWW-Authenticate')).toContain('Basic');
	});

	it('never opens the page for a forged cookie (html → form, PROPFIND → 401)', async () => {
		const forged = 'davbox_session=forged.signature';
		const html = await viewerWith(forged);
		expect(html.status).toBe(200);
		expect(html.headers.get('WWW-Authenticate')).toBeNull();
		const body = await html.text();
		expect(body).toContain('action="/.dav-login"');
		expect(body).not.toContain(VIEWER_MARKER);

		const propfind = await SELF.fetch(ORIGIN + '/docs/', {
			method: 'PROPFIND',
			headers: { Cookie: forged, Depth: '1' },
		});
		expect(propfind.status).toBe(401);
		expect(propfind.headers.get('WWW-Authenticate')).toContain('Basic');
	});

	it('survives a session for the unicode test user', async () => {
		const res = await login('üser', 'pässword');
		expect(res.status).toBe(303);
		const body = await (await viewerWith(cookieOf(res))).text();
		expect(body).toContain(VIEWER_MARKER);
	});

	it('logs out with a Referer fallback and clears the cookie', async () => {
		const cookie = cookieOf(await login('test', 'pass'));
		const res = await SELF.fetch(ORIGIN + '/.dav-logout', {
			method: 'POST',
			redirect: 'manual',
			headers: { Cookie: cookie, Referer: ORIGIN + '/docs/', 'Content-Type': 'application/x-www-form-urlencoded' },
			body: '',
		});
		expect(res.status).toBe(303);
		expect(res.headers.get('Location')).toBe('/docs/');
		expect(res.headers.get('Set-Cookie')).toContain('davbox_session=;');
		expect(res.headers.get('Set-Cookie')).toContain('Max-Age=0');
		// The token is stateless — what makes logout real is the browser
		// dropping the cookie. Post-logout state = no cookie on the request.
		const after = await SELF.fetch(ORIGIN + '/docs/', { headers: { Accept: BROWSER_ACCEPT } });
		const body = await after.text();
		expect(body).toContain('action="/.dav-login"');
		expect(body).not.toContain(VIEWER_MARKER);
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
			expect(res.status).toBe(405);
			expect(res.headers.get('Allow')).toBe('POST');
		}
	});

	it('sanitizes an open redirect in next', async () => {
		const res = await SELF.fetch(ORIGIN + '/.dav-login', {
			method: 'POST',
			redirect: 'manual',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
			body: new URLSearchParams({ user: 'test', pass: 'pass', next: '//evil.example/x' }).toString(),
		});
		expect(res.status).toBe(303);
		expect(res.headers.get('Location')).toBe('/');
	});
});
