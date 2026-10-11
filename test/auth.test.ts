import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { ORIGIN, basic } from './helpers';

// This project runs the worker WITHOUT USERS and COOKIE bindings. The server
// must fail closed: no credentials can ever reach the WebDAV surface.
describe('worker without USERS/COOKIE bindings', () => {
	it('refuses the webdav root with a 500', async () => {
		const res = await SELF.fetch(ORIGIN + '/');
		expect(res.status).toBe(500);
		expect(await res.text()).toContain('not configured');
	});

	it('rejects even valid-looking credentials', async () => {
		const res = await SELF.fetch(ORIGIN + '/', {
			headers: { Authorization: basic('test', 'pass') },
		});
		expect(res.status).toBe(500);
	});
});
import { parseCredentials } from '../src/index';

describe('parseCredentials fails closed on a malformed USERS mapping', () => {
	it('accepts a well-formed comma-separated list', () => {
		expect(parseCredentials('test:pass,üser:pässword')).toHaveLength(2);
	});

	it.each([
		['comma inside a password (truncation)', 'bob:h,unter'],
		['colon-less entry (silent drop)', 'admin,alice:x'],
		['empty password', 'bob:'],
		['empty username', ':pass'],
		['mixed valid and invalid entries', ':pass,alice:x'],
		['duplicate usernames', 'a:x,a:y'],
	])('rejects a %s instead of weakening the credential', (_label, users) => {
		expect(parseCredentials(users)).toBeNull();
	});

	it('treats unset/blank USERS as invalid', () => {
		expect(parseCredentials(undefined)).toBeNull();
		expect(parseCredentials('')).toBeNull();
		expect(parseCredentials('   ')).toBeNull();
	});
});
