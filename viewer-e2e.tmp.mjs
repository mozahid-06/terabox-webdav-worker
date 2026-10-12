import { JSDOM, VirtualConsole } from 'jsdom';

const ORIGIN = 'https://davbox.crazy-gooner-mf.workers.dev';
const AUTH = 'Basic ' + Buffer.from('test:911').toString('base64');

// 1. Fetch the live viewer page like a browser navigation.
const pageRes = await fetch(ORIGIN + '/dav/', { headers: { Accept: 'text/html', Authorization: AUTH } });
console.log('page status:', pageRes.status, pageRes.headers.get('content-type'));
const html = await pageRes.text();

// 2. Run it in a DOM; capture EVERY console error + uncaught exception.
const errors = [];
const vc = new VirtualConsole();
vc.on('jsdomError', (e) => errors.push('jsdomError: ' + (e.stack || e.message)));
vc.on('error', (...a) => errors.push('console.error: ' + a.join(' ')));
vc.on('warn', (...a) => errors.push('console.warn: ' + a.join(' ')));

const shimFetch = async (input, init = {}) => {
  const url = typeof input === 'string' ? new URL(input, ORIGIN) : new URL(input.url || input);
  const headers = { ...(init.headers || {}), Authorization: AUTH };
  const res = await fetch(url, { method: init.method || 'GET', headers, body: init.body, redirect: init.redirect });
  const buf = new Uint8Array(await res.arrayBuffer());
  const h = new Headers();
  res.headers.forEach((v, k) => h.set(k, v));
  return new Response(buf, { status: res.status, headers: h });
};

const dom = new JSDOM(html, {
  url: ORIGIN + '/dav/',
  runScripts: 'dangerously',
  virtualConsole: vc,
  pretendToBeVisual: true,
  beforeParse(window) {
    // Must exist BEFORE the inline script parses (browsers always have it).
    window.fetch = shimFetch;
    window.confirm = () => true;
  },
});
const { window } = dom;

// 4. Give the page time to list, then report.
await new Promise((r) => setTimeout(r, 4000));
const doc = window.document;
console.log('title:', JSON.stringify(doc.title));
console.log('crumbs:', JSON.stringify(doc.getElementById('crumbs').textContent));
console.log('rows:', doc.getElementById('rows').children.length);
console.log('first row:', JSON.stringify(doc.getElementById('rows').children[0]?.textContent || ''));
console.log('error hidden?', doc.getElementById('error').hidden, '| text:', JSON.stringify(doc.getElementById('error').textContent));
console.log('empty hidden?', doc.getElementById('empty').hidden, '| text:', JSON.stringify(doc.getElementById('empty').textContent));
console.log('ERRORS(' + errors.length + '):');
for (const e of errors) console.log('  ' + e.split('\n').slice(0, 6).join('\n  '));
process.exit(0);
