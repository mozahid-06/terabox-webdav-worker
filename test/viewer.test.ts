import { SELF } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { contentTypeFor, resetDavVolatileState } from '../src/webdav';
import { resetTeraboxCaches } from '../src/terabox';
import { VIEWER_HTML, VIEWER_MARKER } from '../src/viewer';
import { AUTH, MockTerabox, ORIGIN, installMock } from './helpers';

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
		// The viewer page must not inherit the file GET's sandbox (it would
		// break its own script), so the two responses carry different policies.
		expect(csp).not.toContain('sandbox');
	});

	it('still 401s an unauthenticated viewer request', async () => {
		const res = await SELF.fetch(ORIGIN + '/docs/', { headers: { Accept: BROWSER_ACCEPT } });
		expect(res.status).toBe(401);
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

describe('preview MIME types match what the viewer previews', () => {
	it('serves image/video types the page will render (nosniff refuses octet-stream)', async () => {
		tb.seed('/docs/icon.svg', { content: '<svg xmlns="http://www.w3.org/2000/svg"/>' });
		tb.seed('/docs/clip.ogv', { content: 'ogg-video-bytes' });
		tb.seed('/docs/movie.mkv', { content: 'mkv-bytes' });
		tb.seed('/docs/track.aac', { content: 'aac-bytes' });
		expect((await request('/docs/icon.svg')).headers.get('Content-Type')).toBe('image/svg+xml');
		expect((await request('/docs/clip.ogv')).headers.get('Content-Type')).toBe('video/ogg');
		expect((await request('/docs/movie.mkv')).headers.get('Content-Type')).toBe('video/x-matroska');
		expect((await request('/docs/track.aac')).headers.get('Content-Type')).toBe('audio/aac');
	});

	it('every client preview extension resolves to a matching server media type', () => {
		// VID/IMG/AUD in the page must stay a subset of the server MIME map —
		// a previewable-but-octet-stream file breaks under nosniff.
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

describe('the embedded page script parses', () => {
	it('compiles the viewer page JS (a syntax error would ship untested)', () => {
		// The page lives inside a template literal: tsc never parses it as
		// JavaScript, so the gate would stay green on a broken script.
		const match = /<script>([\s\S]*)<\/script>\s*<\/body>/.exec(VIEWER_HTML);
		expect(match).not.toBeNull();
		expect(() => new Function(match![1]!)).not.toThrow();
	});
});
