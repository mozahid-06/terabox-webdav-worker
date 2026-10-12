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
 *   - Same Basic auth gate as every other method (fail-closed upstream in
 *     the fetch handler — nothing here re-implements auth).
 *   - The page carries its own CSP: inline script/style for itself,
 *     `connect/img/media-src 'self'` for same-origin XHR and previews,
 *     `frame-ancestors 'none'`. File GETs keep their `sandbox;
 *     default-src 'none'` policy — uploaded HTML still cannot run script
 *     with the browser-cached credentials; the two policies never mix
 *     because a viewer response only ever comes from a *collection* GET.
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
  "img-src 'self'",
  "media-src 'self'",
  "connect-src 'self'",
  "form-action 'none'",
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
export function viewerResponse(basePath: string): Response {
  const escaped = basePath.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
  return new Response(VIEWER_HTML.replace('data-base=""', `data-base="${escaped}"`), {
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
.chev { color: var(--muted); flex: none; }
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
@media (hover: hover) and (pointer: fine) {
  tbody tr:hover .row-actions, tbody tr:focus-within .row-actions { opacity: 1; transition: opacity 120ms var(--ease-out); }
}
.row-actions a {
  display: grid; place-items: center;
  width: 28px; height: 28px;
  color: var(--muted);
  border-radius: 4px;
  text-decoration: none;
}
.row-actions a:hover { color: var(--accent); background: var(--bg); }

#empty, #error {
  margin: 48px auto;
  max-width: 46ch;
  text-align: center;
  color: var(--muted);
}
#error { color: var(--accent); }
#empty .btn, #empty button { margin-top: 14px; }

/* Preview drawer — slides in from the right; the row you clicked stays
   visible behind it, so you always see where the preview came from. */
.drawer {
  position: fixed;
  top: 0; right: 0; bottom: 0;
  width: min(440px, 100vw);
  background: var(--panel);
  border-left: 1px solid var(--line);
  box-shadow: -16px 0 40px rgba(0, 0, 0, 0.45);
  display: flex;
  flex-direction: column;
  transform: translateX(24px);
  opacity: 0;
  visibility: hidden;
  transition: transform 200ms var(--ease-out), opacity 200ms var(--ease-out), visibility 0s linear 200ms;
  z-index: 10;
}
.drawer.open {
  transform: none;
  opacity: 1;
  visibility: visible;
  transition: transform 200ms var(--ease-out), opacity 200ms var(--ease-out), visibility 0s;
}
.drawer-head {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 16px;
  border-bottom: 1px solid var(--line);
}
#drawer-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 600; }
#drawer-close { padding: 2px 10px; font-size: 16px; line-height: 1.4; }
.drawer-body { flex: 1; overflow: auto; padding: 16px; }
.drawer-body img, .drawer-body video { max-width: 100%; max-height: 100%; display: block; margin: 0 auto; background: var(--bg); }
.drawer-body pre {
  margin: 0;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
  white-space: pre-wrap;
  word-break: break-word;
  color: var(--text);
}
.drawer-body .meta { color: var(--muted); font-size: 13px; margin-bottom: 14px; }
.drawer-body .placeholder { color: var(--muted); text-align: center; padding: 40px 0; }

/* Upload status lines — feedback, not layout: they append and never move rows. */
.uploads {
  border-top: 1px solid var(--line);
  background: var(--panel);
  padding: 8px 20px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
  color: var(--muted);
  max-height: 96px;
  overflow: auto;
}
.uploads:empty { display: none; }
.uploads .ok { color: #7BC96F; }
.uploads .bad { color: var(--accent); }

@media (max-width: 640px) {
  th:nth-child(3), td:nth-child(3) { display: none; }
  .top { padding: 12px 14px; gap: 10px; }
  td, th { padding-left: 14px; padding-right: 14px; }
}
@media (prefers-reduced-motion: reduce) {
  /* Keep the show/hide (it carries state), drop the movement. */
  .drawer { transition: opacity 150ms linear, visibility 0s linear 150ms; transform: none; }
  .drawer.open { transition: opacity 150ms linear, visibility 0s; transform: none; }
}
</style>
</head>
<body data-viewer="1" data-base="">
<header class="top">
  <nav id="crumbs" class="mono" aria-label="Path"></nav>
  <button id="upload" class="primary">Upload files</button>
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
<aside id="drawer" class="drawer" role="dialog" aria-modal="true" aria-label="Preview" aria-hidden="true">
  <div class="drawer-head">
    <span id="drawer-name" class="mono"></span>
    <a id="drawer-dl" class="btn" download>Download</a>
    <button id="drawer-close" aria-label="Close preview">&times;</button>
  </div>
  <div id="drawer-body" class="drawer-body"></div>
</aside>
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

  var IMG = ['png','jpg','jpeg','gif','webp','svg','avif','bmp','ico'];
  var VID = ['mp4','webm','ogv','m4v'];
  var TXT = ['txt','md','markdown','json','js','mjs','cjs','ts','tsx','jsx','css','scss','less','html','htm','xml','yml','yaml','toml','ini','conf','cfg','sh','bash','zsh','py','rb','php','go','rs','java','c','h','cpp','hpp','cs','sql','log','csv','env','lock','properties','srt','vtt','tex','r','swift','kt','lua','pl','diff','patch'];

  var crumbs = document.getElementById('crumbs');
  var rows = document.getElementById('rows');
  var empty = document.getElementById('empty');
  var errorEl = document.getElementById('error');
  var picker = document.getElementById('picker');
  var uploads = document.getElementById('uploads');
  var drawer = document.getElementById('drawer');
  var drawerName = document.getElementById('drawer-name');
  var drawerDl = document.getElementById('drawer-dl');
  var drawerBody = document.getElementById('drawer-body');
  var drawerClose = document.getElementById('drawer-close');
  var returnFocus = null;
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

  function svg(paths) {
    var NS = 'http://www.w3.org/2000/svg';
    var s = document.createElementNS(NS, 'svg');
    s.setAttribute('viewBox', '0 0 16 16');
    s.setAttribute('width', '14');
    s.setAttribute('height', '14');
    s.setAttribute('fill', 'none');
    s.setAttribute('stroke', 'currentColor');
    s.setAttribute('stroke-width', '1.5');
    s.setAttribute('stroke-linecap', 'round');
    s.setAttribute('stroke-linejoin', 'round');
    s.setAttribute('aria-hidden', 'true');
    var p = document.createElementNS(NS, 'path');
    p.setAttribute('d', paths);
    s.appendChild(p);
    return s;
  }
  var ICON_DLO = 'M8 2v8m0 0 3-3m-3 3L5 5M3 12v1a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1v-1';
  var ICON_DIR = 'M6 3l1.5 1.5L6 6M2.5 4.5h4M2.5 8h11M2.5 11.5h11';

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

  function renderRows(list) {
    entries = list;
    rows.textContent = '';
    list.sort(function (a, b) {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
    });
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
      wrap.appendChild(svg(ICON_DIR));
      wrap.appendChild(link);
    } else {
      var ext = extOf(entry.name);
      if (ext) wrap.appendChild(el('span', 'badge', ext));
      wrap.appendChild(link);
      link.addEventListener('click', function (ev) {
        ev.preventDefault();
        openDrawer(entry, link);
      });
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
    tdAct.appendChild(acts);
    tr.appendChild(tdAct);
    return tr;
  }

  function openDrawer(entry, source) {
    returnFocus = source || null;
    drawerName.textContent = entry.name;
    drawerName.title = entry.name;
    drawerDl.href = entry.href;
    drawerBody.textContent = '';
    var kind = kindOf(entry.name);

    if (kind === 'img') {
      var img = document.createElement('img');
      img.src = entry.href;
      img.alt = entry.name;
      drawerBody.appendChild(img);
    } else if (kind === 'vid') {
      var video = document.createElement('video');
      video.src = entry.href;
      video.controls = true;
      video.playsInline = true;
      drawerBody.appendChild(video);
    } else if (kind === 'txt' && entry.size <= 1048576) {
      drawerBody.appendChild(el('div', 'meta', fmtSize(entry.size) + (entry.when ? ' · ' + fmtWhen(entry.when) : '')));
      fetch(entry.href).then(function (res) {
        if (!res.ok) throw new Error(String(res.status));
        // The listing's size is metadata, not a bound — read through a
        // reader with a hard byte cap so a lying 0-byte entry cannot buffer
        // a huge body into the tab.
        if (!res.body || !res.body.getReader) return res.text();
        var reader = res.body.getReader();
        var decoder = new TextDecoder();
        var out = '';
        var total = 0;
        var pump = function () {
          return reader.read().then(function (r) {
            if (r.done) return out;
            total += r.value.byteLength;
            out += decoder.decode(r.value, { stream: true });
            if (total >= 1048576) {
              reader.cancel();
              return out + '\\n… (stopped at 1 MB preview cap)';
            }
            return pump();
          });
        };
        return pump();
      }).then(function (text) {
        drawerBody.appendChild(el('pre', '', text.length > 200000 ? text.slice(0, 200000) + '\\n… (truncated)' : text));
      }).catch(function () {
        drawerBody.textContent = '';
        drawerBody.appendChild(el('div', 'placeholder', 'Could not load the file.'));
      });
    } else {
      drawerBody.appendChild(el('div', 'meta', (entry.isDir ? '' : fmtSize(entry.size) + (entry.when ? ' · ' + fmtWhen(entry.when) : ''))));
      drawerBody.appendChild(el('div', 'placeholder', kind === 'txt' ? 'Too large to preview — use Download.' : 'No preview for this type — use Download.'));
    }

    drawer.classList.add('open');
    drawer.setAttribute('aria-hidden', 'false');
    drawerClose.focus();
  }

  function closeDrawer() {
    drawer.classList.remove('open');
    drawer.setAttribute('aria-hidden', 'true');
    // Stop a playing preview when it leaves.
    drawerBody.textContent = '';
    if (returnFocus && document.contains(returnFocus)) returnFocus.focus();
    returnFocus = null;
  }
  drawerClose.addEventListener('click', closeDrawer);
  document.addEventListener('keydown', function (ev) {
    if (ev.key === 'Escape' && drawer.classList.contains('open')) closeDrawer();
  });
  // role=dialog aria-modal is set in the markup; keep Tab inside it while
  // open (focus starts on the close button — see openDrawer).
  drawer.addEventListener('keydown', function (ev) {
    if (ev.key !== 'Tab' || !drawer.classList.contains('open')) return;
    var focusables = drawer.querySelectorAll('a[href], button:not([disabled])');
    if (!focusables.length) return;
    var first = focusables[0];
    var last = focusables[focusables.length - 1];
    if (ev.shiftKey && document.activeElement === first) {
      ev.preventDefault();
      last.focus();
    } else if (!ev.shiftKey && document.activeElement === last) {
      ev.preventDefault();
      first.focus();
    }
  });

  function statusLine(name, cls, text) {
    var line = el('div', cls, name + ' — ' + text);
    uploads.appendChild(line);
    return line;
  }

  function putFile(file) {
    var line = statusLine(file.name, '', 'uploading…');
    var url = base + encodeURIComponent(file.name);
    // Create-only first: a bare PUT over an existing file is a silent
    // overwrite server-side (WebDAV PUT default). If-None-Match: * asks for
    // 412 instead, and only an explicit confirm replaces the existing file.
    var send = function (ifNoneMatch) {
      return fetch(url, {
        method: 'PUT',
        headers: ifNoneMatch ? { 'If-None-Match': '*' } : {},
        body: file,
      });
    };
    var replacing = false;
    return send(true).then(function (res) {
      if (res.status !== 412) return res;
      if (!window.confirm(file.name + ' already exists. Replace it?')) {
        line.className = 'bad';
        line.textContent = file.name + ' — cancelled (existing file kept)';
        return null;
      }
      replacing = true;
      line.textContent = file.name + ' — replacing…';
      return send(false);
    }).then(function (res) {
      if (!res) return;
      if (res.status === 413) throw new Error('too large (100 MB per-request edge limit)');
      if (!res.ok) throw new Error('failed with HTTP ' + res.status);
      line.className = 'ok';
      line.textContent = file.name + (replacing ? ' — replaced' : ' — uploaded');
      setTimeout(function () {
        if (line.parentNode) line.parentNode.removeChild(line);
      }, 4000);
    }).catch(function (err) {
      line.className = 'bad';
      line.textContent = file.name + ' — ' + (err && err.message ? err.message : 'failed');
    });
  }

  function uploadFiles(fileList) {
    var files = [];
    for (var i = 0; i < fileList.length; i++) files.push(fileList[i]);
    if (files.length === 0) return;
    clearError();
    Promise.all(files.map(putFile)).then(function () { load(); });
  }

  document.getElementById('upload').addEventListener('click', function () { picker.click(); });
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
