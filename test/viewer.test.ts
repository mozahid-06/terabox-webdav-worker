import { SELF } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDavVolatileState } from '../src/webdav';
import { resetTeraboxCaches } from '../src/terabox';
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
		expect(body).toContain('data-viewer="1"');
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
