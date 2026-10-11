import { SELF } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDavVolatileState } from '../src/webdav';
import { resetTeraboxCaches } from '../src/terabox';
import { AUTH, MockTerabox, ORIGIN, installMock } from './helpers';

// This vitest project deploys the worker with a non-ASCII PATH="/döc"
// (see vitest.config.mts). url.pathname is always percent-encoded
// ("/d%C3%B6c/…"), so routing must encode mount.base by the same URL
// algorithm or every request on the mount answers 404 (round-9 F8).

let tb: MockTerabox;

const request = (path: string, init: RequestInit = {}): Promise<Response> =>
	SELF.fetch(ORIGIN + path, {
		...init,
		redirect: 'manual',
		headers: { ...AUTH, ...(init.headers as Record<string, string> | undefined) },
	});

beforeEach(() => {
	resetDavVolatileState();
	resetTeraboxCaches();
	tb = new MockTerabox();
	tb.seed('/inside.txt', { content: 'inside utf8' });
	tb.seed('/outside.txt', { content: 'outside the base' });
	installMock(tb);
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('non-ASCII base path (PATH=/döc)', () => {
	it('redirects the bare base path to its encoded slash form', async () => {
		const res = await request('/döc');
		expect(res.status).toBe(301);
		expect(res.headers.get('Location')).toBe(ORIGIN + '/d%C3%B6c/');
	});

	it('still 404s everything outside the base', async () => {
		expect((await request('/outside.txt')).status).toBe(404);
		expect((await request('/')).status).toBe(404);
	});

	it('serves PROPFIND below the encoded base', async () => {
		const res = await request('/döc/', { method: 'PROPFIND', headers: { Depth: '1' } });
		expect(res.status).toBe(207);
		expect(await res.text()).toContain('inside.txt');
	});

	it('round-trips GET and PUT below the encoded base', async () => {
		const get = await request('/döc/inside.txt');
		expect(get.status).toBe(200);
		expect(await get.text()).toBe('inside utf8');
		const put = await request('/döc/created.txt', { method: 'PUT', body: 'fresh' });
		expect(put.status).toBe(201);
		const again = await request('/döc/created.txt');
		expect(again.status).toBe(200);
		expect(await again.text()).toBe('fresh');
	});
});
