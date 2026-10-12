/**
 * Browser viewer for collection GETs — a WebDAV drive that reads in a tab.
 *
 * A browser navigating to a folder sends `Accept: text/html`; every WebDAV
 * client we serve (rclone, litmus, davfs, Mini-Redirector) sends the
 * wildcard Accept (or XML media types) and must keep the RFC 7231 §6.5.5
 * collection 405 with `Allow` (pinned in test/viewer.test.ts and litmus).
 * The two populations never overlap, so the Accept header is the whole
 * discriminator.
 *
 * Security posture:
 *   - Basic auth or the signed session cookie (both fail-closed upstream
 *     in the fetch handler — nothing here re-implements auth). Browsers
 *     sign in through /.dav-login; the HttpOnly cookie then rides every
 *     XHR/PUT automatically, so closing the tab never orphans a transfer.
 *   - The page carries its own CSP: inline script/style for itself,
 *     `connect-src 'self'` for same-origin XHR, `form-action 'self'` for
 *     the sign-out form, `frame-ancestors 'none'`. No img/media-src: the
 *     page has no previews (uploads and downloads only). File GETs keep
 *     their `sandbox; default-src 'none'` policy — uploaded HTML still
 *     cannot run script; the two policies never mix because a viewer
 *     response only ever comes from a *collection* GET.
 *   - The page builds every DOM node with textContent/createElement —
 *     listing data (display names, hrefs) is never concatenated into
 *     markup, so a hostile filename cannot inject script.
 *   - `Cache-Control: no-store` (the page version tracks the code) and
 *     `X-Content-Type-Options: nosniff` (added by the fetch handler).
 */

/** Test hook: the marker every viewer response carries. */
export const VIEWER_MARKER = 'data-viewer="1"';

const VIEWER_CSP = [
  "default-src 'none'",
  "style-src 'unsafe-inline'",
  "script-src 'unsafe-inline'",
  "connect-src 'self'",
  "form-action 'self'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
].join('; ');

/**
 * True when this request is a browser page navigation, not a WebDAV GET.
 *
 * The Accept header is negotiated, not substring-matched: `text/html;q=0`
 * is an explicit refusal (RFC 9110 §12.5.1) and must keep the collection
 * 405 — a `.includes()` here would happily serve the viewer to a client
 * that said it never wants HTML. The first `text/html` range governs (the
 * exact match's q wins over any later duplicate).
 */
export function wantsViewer(request: Request): boolean {
  if (request.method.toUpperCase() !== 'GET') return false;
  const accept = request.headers.get('Accept');
  if (!accept) return false;
  for (const part of accept.split(',')) {
    const fields = part.trim().split(';');
    if ((fields[0] || '').trim().toLowerCase() !== 'text/html') continue;
    let q = 1;
    for (const param of fields.slice(1)) {
      const eq = param.indexOf('=');
      if (eq === -1) continue;
      if (param.slice(0, eq).trim().toLowerCase() !== 'q') continue;
      const value = Number(param.slice(eq + 1).trim());
      q = Number.isNaN(value) ? 1 : value;
    }
    return q > 0;
  }
  return false;
}

/**
 * @param basePath The mount base (encoded, '' at the domain root) — the
 * page needs it to render a home crumb that always points at the WebDAV
 * root; it cannot derive that from location.pathname alone (the first
 * segment is the base only when a base exists).
 */
export function viewerResponse(basePath: string, viaSession = false): Response {
  const escaped = basePath.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
  const html = VIEWER_HTML.replace('data-base=""', `data-base="${escaped}"`).replace(
    'data-session=""',
    viaSession ? 'data-session="1"' : 'data-session=""',
  );
  return new Response(html, {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      // The 200/405 pair below differs only by Accept (both no-store — but
      // state the dimension anyway so a cache that ignores no-store still
      // cannot serve the wrong variant).
      'Vary': 'Accept',
      'Content-Security-Policy': VIEWER_CSP,
    },
  });
}

/**
 * Canonical slash form. The page resolves child hrefs relative to its own
 * URL, so `/docs` (no slash) must land on `/docs/` before it renders, or a
 * click on `a.txt` would resolve to `/a.txt` at the wrong level.
 */
export function viewerRedirect(request: Request): Response {
  const target = new URL(request.url);
  target.pathname += '/';
  return Response.redirect(target.toString(), 301);
}

// The page: one self-contained document, zero third-party requests (no
// webfonts under CSP — system sans for UI, system mono for path/size/date).
export const VIEWER_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Files</title>
<style>
:root {
  --bg: #12151C;
  --panel: #181C26;
  --row: #1D2230;
  --line: #242A38;
  --text: #DDE3EE;
  --muted: #8A93A8;
  --accent: #FF6A3D;
  --accent-ink: #1A0E08;
  --ease-out: cubic-bezier(0.23, 1, 0.32, 1);
}
* { box-sizing: border-box; }
html, body { height: 100%; }
body {
  margin: 0;
  background: var(--bg);
  color: var(--text);
  font: 14px/1.45 ui-sans-serif, system-ui, "Segoe UI", Roboto, sans-serif;
  display: flex;
  flex-direction: column;
}
.mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-variant-numeric: tabular-nums; }
/* Sign-out is a real form (no JS); it only shows for cookie sessions —
   a Basic-authenticated script user has nothing to sign out of. */
#signout { display: flex; margin: 0; }
body:not([data-session="1"]) #signout { display: none; }

/* Path line — the hero: the current location as a real path. */
.top {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 14px 20px;
  border-bottom: 1px solid var(--line);
  background: var(--panel);
}
#crumbs { flex: 1; min-width: 0; font-size: 15px; overflow-x: auto; white-space: nowrap; scrollbar-width: thin; }
#crumbs a { color: var(--muted); text-decoration: none; }
#crumbs a:hover { color: var(--text); text-decoration: underline; }
#crumbs .sep { color: var(--line); padding: 0 6px; }
#crumbs .here { color: var(--text); font-weight: 600; }
button, .btn {
  font: inherit;
  border: 1px solid var(--line);
  background: var(--row);
  color: var(--text);
  border-radius: 6px;
  padding: 7px 14px;
  cursor: pointer;
}
button.primary {
  background: var(--accent);
  border-color: var(--accent);
  color: var(--accent-ink);
  font-weight: 600;
}
button:hover, .btn:hover { border-color: var(--muted); }
button.primary:hover { filter: brightness(1.08); border-color: var(--accent); }
button:active { filter: brightness(0.94); }
:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }

main { flex: 1; overflow: auto; position: relative; }
body.dropping main::after {
  content: "Drop files to upload";
  position: absolute; inset: 0;
  display: grid; place-items: center;
  background: color-mix(in srgb, var(--bg) 82%, transparent);
  border: 2px dashed var(--accent);
  font-size: 16px;
  color: var(--text);
  z-index: 5;
  pointer-events: none;
}

table { width: 100%; border-collapse: collapse; }
th {
  text-align: left;
  font-weight: 500;
  font-size: 12px;
  color: var(--muted);
  padding: 10px 20px 8px;
  border-bottom: 1px solid var(--line);
  position: sticky; top: 0;
  background: var(--bg);
}
th.num, td.num { text-align: right; }
td {
  padding: 9px 20px;
  border-bottom: 1px solid var(--line);
  vertical-align: middle;
}
@media (hover: hover) and (pointer: fine) {
  tbody tr:hover { background: var(--row); transition: background-color 120ms var(--ease-out); }
}
tbody tr { cursor: default; }
.name { display: flex; align-items: center; gap: 10px; min-width: 0; }
.name a {
  color: var(--text);
  text-decoration: none;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.name a:hover { text-decoration: underline; }
.badge.k-img { color: #7BC96F; border-color: #2f5333; }
.badge.k-vid { color: #C7A9F5; border-color: #4b3d6b; }
.badge.k-aud { color: #F0B37E; border-color: #5b4634; }
.badge.k-txt { color: #8CB8F0; border-color: #33465e; }
.ic-dir { color: #D9A441; }
.ic-file { color: #93A7C6; }
.ic-up { color: var(--muted); }
tr.up .name a { color: var(--muted); font-weight: 600; }
.badge {
  flex: none;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 10px;
  color: var(--muted);
  border: 1px solid var(--line);
  border-radius: 4px;
  padding: 1px 5px;
  text-transform: uppercase;
}
td.when { color: var(--muted); font-size: 12px; white-space: nowrap; }
td.size { color: var(--muted); font-size: 12px; white-space: nowrap; }
.row-actions { display: flex; gap: 4px; justify-content: flex-end; opacity: 0; }
.row-actions { opacity: 1; }
@media (hover: hover) and (pointer: fine) {
  .row-actions { opacity: 0; }
  tbody tr:hover .row-actions, tbody tr:focus-within .row-actions { opacity: 1; transition: opacity 120ms var(--ease-out); }
}
.row-actions a, .row-actions button {
  display: grid; place-items: center;
  width: 28px; height: 28px;
  padding: 0;
  color: var(--muted);
  background: none;
  border: none;
  border-radius: 4px;
  text-decoration: none;
  cursor: pointer;
}
.row-actions a:hover, .row-actions button:hover { color: var(--accent); background: var(--bg); }

#empty, #error {
  margin: 48px auto;
  max-width: 46ch;
  text-align: center;
  color: var(--muted);
}
#error { color: var(--accent); }
#empty .btn, #empty button { margin-top: 14px; }

/* Toolbar progress chip — right where the eye already is. */
.upchip {
  display: inline-flex;
  align-items: center;
  gap: 9px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
  color: var(--text);
  background: var(--bg);
  border: 1px solid var(--line);
  border-radius: 999px;
  padding: 5px 12px;
  white-space: nowrap;
}
.upchip[hidden] { display: none; }
.upchip em {
  position: relative;
  display: block;
  width: 56px;
  height: 5px;
  background: var(--line);
  border-radius: 3px;
  overflow: hidden;
  flex: none;
}
.upchip em i {
  position: absolute;
  left: 0; top: 0; bottom: 0;
  width: 0;
  background: #7BC96F;
  transition: width 160ms var(--ease-out);
}
.upchip.done { border-color: #2f5333; color: #7BC96F; }

/* Upload status lines — fixed to the viewport bottom so they can never be
   missed while a transfer is running; they append and never move rows. */
.uploads {
  position: fixed;
  left: 0; right: 0; bottom: 0;
  z-index: 30;
  border-top: 1px solid var(--line);
  background: rgba(24, 28, 38, 0.94);
  box-shadow: 0 -10px 30px rgba(0, 0, 0, 0.4);
  padding: 10px 20px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 13px;
  color: var(--text);
  max-height: 120px;
  overflow: auto;
}
.uploads:empty { display: none; }
body.uploading main { padding-bottom: 68px; }
.uploads .ok { color: #7BC96F; }
.uploads .bad { color: var(--accent); }
/* Upload progress lines: the bar sits behind the status text. */
.pline {
  position: relative;
  overflow: hidden;
  border-radius: 3px;
  padding: 2px 6px;
  margin: 2px -6px;
}
.pline i {
  position: absolute;
  left: 0; top: 0; bottom: 0;
  width: 0;
  background: rgba(123, 201, 111, 0.35);
  transition: width 160ms var(--ease-out);
}
.pline.indet i { width: 30%; animation: pline-slide 900ms ease-in-out infinite alternate; }
.pline span { position: relative; }
.pline.ok { color: #7BC96F; }
.pline.bad { color: var(--accent); }
@keyframes pline-slide { from { transform: translateX(-100%); } to { transform: translateX(320%); } }

@media (max-width: 640px) {
  th:nth-child(3), td:nth-child(3) { display: none; }
  .top { padding: 12px 14px; gap: 10px; }
  td, th { padding-left: 14px; padding-right: 14px; }
}
@media (prefers-reduced-motion: reduce) {
  .pline.indet i { animation: none; }
}
</style>
</head>
<body data-viewer="1" data-base="" data-session="">
<header class="top">
  <nav id="crumbs" class="mono" aria-label="Path"></nav>
  <button id="upload" class="primary">Upload files</button>
  <span id="upchip" class="upchip" hidden><em><i></i></em><span class="pct"></span></span>
  <button id="mkdir">New folder</button>
  <button id="refresh" aria-label="Refresh listing">Refresh</button>
  <form id="signout" method="post" action="/.dav-logout">
    <input type="hidden" name="next" value="">
    <button type="submit">Sign out</button>
  </form>
  <input id="picker" type="file" multiple hidden>
</header>
<main>
  <table aria-label="Files">
    <thead>
      <tr>
        <th>Name</th>
        <th class="num">Size</th>
        <th>Modified</th>
        <th aria-label="Actions"></th>
      </tr>
    </thead>
    <tbody id="rows"></tbody>
  </table>
  <p id="empty" hidden></p>
  <p id="error" role="alert" hidden></p>
</main>
<div id="uploads" class="uploads" aria-live="polite"></div>
<script>
(function () {
  'use strict';
  // Collapse any leading double slash first: a double-slash path still
  // reaches the root collection, and a base of '//' would make every fetch
  // a protocol-relative (cross-origin) URL.
  var base = location.pathname.replace(/^\\/+/, '/');
  if (base.charAt(base.length - 1) !== '/') base += '/';

  var PROPFIND_BODY =
    '<?xml version="1.0" encoding="utf-8"?>' +
    '<D:propfind xmlns:D="DAV:"><D:prop>' +
    '<D:displayname/><D:resourcetype/><D:getcontentlength/><D:getlastmodified/>' +
    '</D:prop></D:propfind>';

  var IMG = ['png','jpg','jpeg','gif','webp','svg','avif','bmp','ico','heic'];
  var VID = ['mp4','webm','ogv','m4v','mkv','mov','avi','ts','mts','m2ts','flv','wmv','mpg','mpeg','3gp'];
  var AUD = ['mp3','m4a','aac','wav','flac','ogg','oga','opus','wma','aiff','aif'];
  var TXT = ['txt','md','markdown','json','js','mjs','cjs','ts','tsx','jsx','css','scss','less','html','htm','xml','yml','yaml','toml','ini','conf','cfg','sh','bash','zsh','py','rb','php','go','rs','java','c','h','cpp','hpp','cs','sql','log','csv','env','lock','properties','srt','vtt','tex','r','swift','kt','lua','pl','diff','patch'];

  var upchip = document.getElementById('upchip');
  var upchipPct = upchip.querySelector('.pct');
  var upchipBar = upchip.querySelector('em i');
  var ups = []; // in-flight uploads: { name, pct }
  var roundFails = 0;

  function upShow() {
    if (ups.length === 0) return;
    var sum = 0;
    for (var i = 0; i < ups.length; i++) sum += ups[i].pct;
    var pct = Math.round(sum / ups.length);
    upchipBar.style.width = pct + '%';
    if (ups.length > 1) {
      upchipPct.textContent = ups.length + ' files · ' + pct + '%';
    } else if (ups[0].pct >= 100) {
      upchipPct.textContent = ups[0].name + ' · finishing…';
    } else {
      upchipPct.textContent = ups[0].name + ' · ' + pct + '%';
    }
    upchip.classList.remove('done');
    upchip.hidden = false;
  }

  function upEnd(ok) {
    if (!ok) roundFails++;
    if (ups.length > 0) { upShow(); return; }
    if (ok && roundFails === 0) {
      upchipBar.style.width = '100%';
      upchipPct.textContent = '✓ uploaded';
      upchip.classList.add('done');
      upchip.hidden = false;
      setTimeout(function () {
        if (ups.length === 0) {
          upchip.hidden = true;
          upchip.classList.remove('done');
        }
      }, 2200);
    } else {
      upchip.hidden = true;
    }
  }

  // The strip is fixed to the viewport bottom; pad the page only while it
  // has content so it can never cover the last row.
  var upObs = document.getElementById('uploads');
  if (window.MutationObserver) {
    new MutationObserver(function () {
      document.body.classList.toggle('uploading', upObs.childNodes.length > 0);
    }).observe(upObs, { childList: true });
  }

  var crumbs = document.getElementById('crumbs');
  var rows = document.getElementById('rows');
  var empty = document.getElementById('empty');
  var errorEl = document.getElementById('error');
  var picker = document.getElementById('picker');
  var uploads = document.getElementById('uploads');
  var entries = [];

  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function showError(msg) {
    errorEl.textContent = msg;
    errorEl.hidden = false;
  }
  function clearError() {
    errorEl.hidden = true;
    errorEl.textContent = '';
  }

  function decodeSeg(seg) {
    try { return decodeURIComponent(seg); } catch (e) { return seg; }
  }

  function renderCrumbs() {
    crumbs.textContent = '';
    var home = document.body.getAttribute('data-base') || '/';
    if (home.charAt(home.length - 1) !== '/') home += '/';
    var homeParts = home.split('/').filter(Boolean);
    var parts = base.split('/').filter(Boolean);
    var under = parts.slice(homeParts.length); // segments below the mount root
    var homeLabel = homeParts.length ? homeParts[homeParts.length - 1] : '/';
    if (under.length === 0) {
      crumbs.appendChild(el('span', 'here', homeLabel));
      return;
    }
    var homeA = document.createElement('a');
    homeA.href = home;
    homeA.textContent = homeLabel;
    crumbs.appendChild(homeA);
    var acc = home;
    for (var i = 0; i < under.length; i++) {
      acc += under[i] + '/';
      crumbs.appendChild(el('span', 'sep', '/'));
      if (i === under.length - 1) {
        crumbs.appendChild(el('span', 'here', decodeSeg(under[i])));
      } else {
        var a = document.createElement('a');
        a.href = acc;
        a.textContent = decodeSeg(under[i]);
        crumbs.appendChild(a);
      }
    }
  }

  function extOf(name) {
    // dot >= 0: a dotfile's extension is the part after its leading dot
    // ('.env' -> 'env') — dotfiles were unpreviewable when the dot had to
    // come after a prefix; no dot at all -> ''.
    var dot = name.lastIndexOf('.');
    return dot === -1 ? '' : name.slice(dot + 1).toLowerCase();
  }

  var BARE = ['dockerfile', 'makefile', 'rakefile', 'gemfile', 'procfile', 'license', 'readme'];

  function kindOf(name) {
    var ext = extOf(name);
    if (IMG.indexOf(ext) >= 0) return 'img';
    if (VID.indexOf(ext) >= 0) return 'vid';
    if (AUD.indexOf(ext) >= 0) return 'aud';
    if (TXT.indexOf(ext) >= 0) return 'txt';
    if (ext === '' && BARE.indexOf(name.toLowerCase()) >= 0) return 'txt';
    return 'other';
  }

  function fmtSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    var units = ['KB', 'MB', 'GB', 'TB'];
    var v = bytes;
    for (var i = 0; i < units.length; i++) {
      v /= 1024;
      if (v < 1024 || i === units.length - 1) {
        return (Math.round(v * 10) / 10) + ' ' + units[i];
      }
    }
    return bytes + ' B';
  }

  function fmtWhen(str) {
    var d = new Date(str);
    if (isNaN(d.getTime())) return '';
    var pad = function (n) { return (n < 10 ? '0' : '') + n; };
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
      ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }

  function icon(paths, cls, fill) {
    var NS = 'http://www.w3.org/2000/svg';
    var s = document.createElementNS(NS, 'svg');
    s.setAttribute('viewBox', '0 0 16 16');
    s.setAttribute('width', '14');
    s.setAttribute('height', '14');
    if (fill) {
      s.setAttribute('fill', 'currentColor');
      s.setAttribute('stroke', 'none');
    } else {
      s.setAttribute('fill', 'none');
      s.setAttribute('stroke', 'currentColor');
      s.setAttribute('stroke-width', '1.5');
      s.setAttribute('stroke-linecap', 'round');
      s.setAttribute('stroke-linejoin', 'round');
    }
    if (cls) s.setAttribute('class', cls);
    s.setAttribute('aria-hidden', 'true');
    var p = document.createElementNS(NS, 'path');
    p.setAttribute('d', paths);
    s.appendChild(p);
    return s;
  }
  function svg(paths, cls) { return icon(paths, cls, false); }
  function svgF(paths, cls) { return icon(paths, cls, true); }
  var ICON_DLO = 'M8 2.5V10m0 0 3-3m-3 3-3-3M3 12v1.2c0 .44.36.8.8.8h8.4c.44 0 .8-.36.8-.8V12';
  var ICON_DIR = 'M1.75 4.5c0-.97.78-1.75 1.75-1.75h2.6c.47 0 .92.19 1.26.53l.8.8h4.34c.97 0 1.75.78 1.75 1.75v5.42c0 .97-.78 1.75-1.75 1.75H3.5a1.75 1.75 0 0 1-1.75-1.75z';
  var ICON_FL = 'M4.5 2.25h4.4l3.1 3.1v8.4h-7.5zM8.9 2.25v3.1h3.1';
  var ICON_UP = 'M8 13V3.5M8 3.5 4.75 6.75M8 3.5l3.25 3.25';
  var ICON_EDT = 'm11 2.6 2.4 2.4-7.4 7.4-3.2.8.8-3.2zM9.9 3.7l2.4 2.4';
  var ICON_DEL = 'M2.75 4.5h10.5M6.25 4.5v-.9a.9.9 0 0 1 .9-.9h1.7a.9.9 0 0 1 .9.9v.9M4.4 4.5l.55 8.2A1.15 1.15 0 0 0 6.09 13.75h3.82a1.15 1.15 0 0 0 1.14-1.05l.55-8.2M6.6 7v4.4M9.4 7v4.4';

  function childHrefs(doc) {
    var out = [];
    var responses = doc.getElementsByTagName('D:response');
    for (var i = 0; i < responses.length; i++) {
      var hrefEl = responses[i].getElementsByTagName('D:href')[0];
      if (!hrefEl) continue;
      var href = (hrefEl.textContent || '').trim();
      // hrefs this page can use are absolute paths on this origin; anything
      // else (crafted upstream) is dropped rather than assigned to a link.
      if (href.charAt(0) !== '/') continue;
      var decoded;
      try { decoded = decodeURIComponent(href); } catch (e) { continue; }
      // The collection itself: compare BOTH forms — hrefs from the worker
      // are percent-encoded like location.pathname, but a mixed raw/decoded
      // comparison used to miss on every spaced/UTF-8 path and list the
      // folder as its own child.
      var selfDecoded;
      try { selfDecoded = decodeURIComponent(location.pathname); } catch (e2) { selfDecoded = location.pathname; }
      if (href === location.pathname || decoded === selfDecoded) continue;
      var props = {};
      var display = responses[i].getElementsByTagName('D:displayname');
      var lengths = responses[i].getElementsByTagName('D:getcontentlength');
      var mods = responses[i].getElementsByTagName('D:getlastmodified');
      var types = responses[i].getElementsByTagName('D:resourcetype');
      if (display[0]) props.name = display[0].textContent || '';
      if (lengths[0]) props.size = parseInt(lengths[0].textContent || '0', 10) || 0;
      if (mods[0]) props.when = mods[0].textContent || '';
      props.isDir = types[0] ? types[0].getElementsByTagName('D:collection').length > 0 : false;
      if (!props.name) {
        var tail = decoded.replace(/\\/$/, '').split('/').pop() || decoded;
        props.name = tail;
      }
      out.push({ href: href, decoded: decoded, name: props.name, size: props.size, when: props.when, isDir: props.isDir });
    }
    return out;
  }

  function mountHome() {
    var home = document.body.getAttribute('data-base') || '/';
    if (home.charAt(home.length - 1) !== '/') home += '/';
    return home;
  }

  function upRow() {
    // Classic FTP-style parent entry — one row above the listing.
    var tr = document.createElement('tr');
    tr.className = 'up';
    var tdName = document.createElement('td');
    var wrap = el('div', 'name');
    var link = document.createElement('a');
    link.href = base.slice(0, base.lastIndexOf('/', base.length - 2) + 1);
    link.textContent = '..';
    link.title = 'Go to parent folder';
    link.setAttribute('aria-label', 'Parent folder');
    wrap.appendChild(svg(ICON_UP, 'ic-up'));
    wrap.appendChild(link);
    tdName.appendChild(wrap);
    tr.appendChild(tdName);
    tr.appendChild(el('td', 'num size mono', '—'));
    tr.appendChild(el('td', 'when mono', ''));
    tr.appendChild(el('td', '', ''));
    return tr;
  }

  function renderRows(list) {
    entries = list;
    rows.textContent = '';
    list.sort(function (a, b) {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
    });
    if (base !== mountHome()) rows.appendChild(upRow());
    for (var i = 0; i < list.length; i++) {
      rows.appendChild(rowFor(list[i]));
    }
    if (list.length === 0) {
      empty.textContent = 'Nothing here yet. Drop files here or use Upload files.';
      empty.hidden = false;
    } else {
      empty.hidden = true;
    }
  }

  function rowFor(entry) {
    var tr = document.createElement('tr');

    var tdName = document.createElement('td');
    var wrap = el('div', 'name');
    var link = document.createElement('a');
    link.className = entry.isDir ? '' : 'mono';
    link.href = entry.href + (entry.isDir && entry.href.charAt(entry.href.length - 1) !== '/' ? '/' : '');
    link.textContent = entry.name;
    link.title = entry.name;
    if (entry.isDir) {
      wrap.appendChild(svgF(ICON_DIR, 'ic-dir'));
      wrap.appendChild(link);
    } else {
      wrap.appendChild(svg(ICON_FL, 'ic-file'));
      wrap.appendChild(link);
      var ext = extOf(entry.name);
      if (ext) wrap.appendChild(el('span', 'badge k-' + kindOf(entry.name), ext));
    }
    tdName.appendChild(wrap);
    tr.appendChild(tdName);

    var tdSize = el('td', 'num size mono', entry.isDir ? '—' : fmtSize(entry.size));
    tr.appendChild(tdSize);
    tr.appendChild(el('td', 'when mono', fmtWhen(entry.when)));

    var tdAct = document.createElement('td');
    var acts = el('div', 'row-actions');
    var dl = document.createElement('a');
    dl.href = entry.href;
    dl.setAttribute('download', '');
    dl.title = 'Download ' + entry.name;
    dl.setAttribute('aria-label', 'Download ' + entry.name);
    dl.appendChild(svg(ICON_DLO));
    dl.addEventListener('click', function (ev) { ev.stopPropagation(); });
    acts.appendChild(dl);

    var ren = document.createElement('button');
    ren.type = 'button';
    ren.title = 'Rename ' + entry.name;
    ren.setAttribute('aria-label', 'Rename ' + entry.name);
    ren.appendChild(svg(ICON_EDT));
    ren.addEventListener('click', function (ev) { ev.stopPropagation(); renameEntry(entry); });
    acts.appendChild(ren);

    var del = document.createElement('button');
    del.type = 'button';
    del.title = 'Delete ' + entry.name;
    del.setAttribute('aria-label', 'Delete ' + entry.name);
    del.appendChild(svg(ICON_DEL));
    del.addEventListener('click', function (ev) { ev.stopPropagation(); deleteEntry(entry); });
    acts.appendChild(del);

    tdAct.appendChild(acts);
    tr.appendChild(tdAct);
    return tr;
  }

  function statusLine(name, cls, text) {
    var line = el('div', cls, name + ' — ' + text);
    uploads.appendChild(line);
    return line;
  }

  function progLine(name, text) {
    var line = el('div', 'pline indet');
    var bar = el('i');
    var span = el('span', '', name + ' — ' + text);
    line.appendChild(bar);
    line.appendChild(span);
    uploads.appendChild(line);
    return {
      pct: function (p) {
        line.classList.remove('indet');
        bar.style.width = p + '%';
        // Client finished sending; the worker is still pushing the bytes to
        // storage — say so, or 100% looks frozen.
        span.textContent = name + ' — ' + (p >= 100 ? '100% · finishing…' : p + '%');
      },
      restart: function (text) {
        line.className = 'pline indet';
        bar.style.width = '';
        span.textContent = name + ' — ' + text;
      },
      finish: function (cls, text) {
        line.className = 'pline ' + cls;
        bar.style.width = '100%';
        span.textContent = name + ' — ' + text;
        if (cls === 'ok') {
          setTimeout(function () {
            if (line.parentNode) line.parentNode.removeChild(line);
          }, 4000);
        }
      },
    };
  }

  // XHR, not fetch: fetch gives no upload progress events, and the bar IS
  // the indicator people wait on for big files.
  function putXhr(url, opts) {
    return new Promise(function (resolve) {
      var xhr = new XMLHttpRequest();
      xhr.open('PUT', url);
      if (opts.ifNoneMatch) xhr.setRequestHeader('If-None-Match', '*');
      xhr.upload.onprogress = function (e) {
        if (opts.onProgress && e.lengthComputable && e.total) {
          opts.onProgress(Math.min(100, Math.round((e.loaded / e.total) * 100)));
        }
      };
      xhr.onload = function () { resolve({ status: xhr.status }); };
      xhr.onerror = function () { resolve({ status: 0 }); };
      xhr.onabort = function () { resolve({ status: 0 }); };
      xhr.send(opts.body);
    });
  }

  function putFile(file) {
    var prog = progLine(file.name, 'uploading…');
    var track = { name: file.name, pct: 0 };
    ups.push(track);
    upShow();
    var endTrack = function (ok) {
      var i = ups.indexOf(track);
      if (i >= 0) ups.splice(i, 1);
      upEnd(ok);
    };
    var url = base + encodeURIComponent(file.name);
    // Create-only first: a bare PUT over an existing file is a silent
    // overwrite server-side (WebDAV PUT default). If-None-Match: * asks for
    // 412 instead, and only an explicit confirm replaces the existing file.
    var send = function (ifNoneMatch) {
      return putXhr(url, {
        ifNoneMatch: ifNoneMatch,
        body: file,
        onProgress: function (p) { prog.pct(p); track.pct = p; upShow(); },
      });
    };
    var replacing = false;
    return send(true).then(function (res) {
      if (res.status !== 412) return res;
      if (!window.confirm(file.name + ' already exists. Replace it?')) {
        prog.finish('bad', 'cancelled (existing file kept)');
        endTrack(false);
        return null;
      }
      replacing = true;
      prog.restart('replacing…');
      return send(false);
    }).then(function (res) {
      if (!res) return;
      if (res.status === 0) throw new Error('network error');
      if (res.status === 413) throw new Error('too large (100 MB per-request edge limit)');
      if (res.status < 200 || res.status >= 300) throw new Error('failed with HTTP ' + res.status);
      prog.finish('ok', replacing ? 'replaced' : 'uploaded');
      endTrack(true);
    }).catch(function (err) {
      prog.finish('bad', err && err.message ? err.message : 'failed');
      endTrack(false);
    });
  }

  function renameEntry(entry) {
    var next = window.prompt('Rename to:', entry.name);
    if (next === null) return;
    next = next.trim();
    if (!next || next === entry.name) return;
    if (next.indexOf('/') >= 0) {
      statusLine(entry.name, 'bad', 'not renamed — names cannot contain "/"');
      return;
    }
    var line = statusLine(entry.name, '', 'renaming…');
    var dest = new URL(base + encodeURIComponent(next), location.origin).toString();
    fetch(entry.href, {
      method: 'MOVE',
      headers: { Destination: dest, Overwrite: 'F' },
    }).then(function (res) {
      if (res.status === 412) throw new Error('a file with that name already exists');
      if (res.status === 409) throw new Error('folder missing or conflict');
      if (!res.ok) throw new Error('failed with HTTP ' + res.status);
      line.className = 'ok';
      line.textContent = entry.name + ' — renamed to ' + next;
      load();
    }).catch(function (err) {
      line.className = 'bad';
      line.textContent = entry.name + ' — ' + (err && err.message ? err.message : 'rename failed');
    });
  }

  function deleteEntry(entry) {
    if (!window.confirm('Delete ' + entry.name + (entry.isDir ? ' and everything inside it' : '') + '?')) return;
    var line = statusLine(entry.name, '', 'deleting…');
    fetch(entry.href, { method: 'DELETE' }).then(function (res) {
      if (res.status === 409) throw new Error('locked or not empty — check LOCKs');
      if (!res.ok && res.status !== 204) throw new Error('failed with HTTP ' + res.status);
      line.className = 'ok';
      line.textContent = entry.name + ' — deleted';
      load();
    }).catch(function (err) {
      line.className = 'bad';
      line.textContent = entry.name + ' — ' + (err && err.message ? err.message : 'delete failed');
    });
  }

  function mkdir() {
    var name = window.prompt('Folder name:');
    if (name === null) return;
    name = name.trim();
    if (!name) return;
    if (name.indexOf('/') >= 0) {
      statusLine(name, 'bad', 'not created — names cannot contain "/"');
      return;
    }
    var line = statusLine(name, '', 'creating…');
    fetch(base + encodeURIComponent(name), { method: 'MKCOL' }).then(function (res) {
      if (res.status === 405) throw new Error('that name is taken (405)');
      if (res.status === 409) throw new Error('parent folder missing (409)');
      if (!res.ok && res.status !== 201) throw new Error('failed with HTTP ' + res.status);
      line.className = 'ok';
      line.textContent = name + ' — folder created';
      load();
    }).catch(function (err) {
      line.className = 'bad';
      line.textContent = name + ' — ' + (err && err.message ? err.message : 'create failed');
    });
  }

  function uploadFiles(fileList) {
    var files = [];
    for (var i = 0; i < fileList.length; i++) files.push(fileList[i]);
    if (files.length === 0) return;
    clearError();
    roundFails = 0;
    Promise.all(files.map(putFile)).then(function () { load(); });
  }

  document.getElementById('upload').addEventListener('click', function () { picker.click(); });
  document.getElementById('mkdir').addEventListener('click', mkdir);
  document.getElementById('refresh').addEventListener('click', function () { load(); });
  picker.addEventListener('change', function () {
    uploadFiles(picker.files);
    picker.value = '';
  });

  document.addEventListener('dragover', function (ev) {
    // Always suppress the default: dropping selected text or a URL without
    // preventDefault navigates the page and destroys the viewer state.
    ev.preventDefault();
    if (ev.dataTransfer && Array.prototype.indexOf.call(ev.dataTransfer.types || [], 'Files') >= 0) {
      document.body.classList.add('dropping');
    }
  });
  document.addEventListener('dragleave', function (ev) {
    if (ev.relatedTarget === null) document.body.classList.remove('dropping');
  });
  document.addEventListener('drop', function (ev) {
    ev.preventDefault();
    document.body.classList.remove('dropping');
    if (ev.dataTransfer && ev.dataTransfer.files && ev.dataTransfer.files.length) {
      uploadFiles(ev.dataTransfer.files);
    }
  });

  function load() {
    clearError();
    renderCrumbs();
    fetch(base, {
      method: 'PROPFIND',
      headers: { Depth: '1', 'Content-Type': 'text/xml; charset=utf-8' },
      body: PROPFIND_BODY,
    }).then(function (res) {
      if (res.status === 401) throw new Error('session expired — reload the page');
      if (res.status === 500) throw new Error('server error — check the worker logs');
      if (!res.ok) throw new Error('listing failed (HTTP ' + res.status + ')');
      return res.text();
    }).then(function (xml) {
      var doc = new DOMParser().parseFromString(xml, 'application/xml');
      if (doc.getElementsByTagName('parsererror').length) throw new Error('listing was not valid XML');
      renderRows(childHrefs(doc));
    }).catch(function (err) {
      showError(err && err.message ? err.message : 'listing failed');
    });
  }

  try { document.title = decodeURIComponent(base); } catch (e) { document.title = base; }
  load();
})();
</script>
</body>
</html>
`;
