# TeraBox WebDAV Worker

Expose a [TeraBox](https://www.terabox.com) account (the international
Baidu Netdisk) as a [WebDAV](https://en.wikipedia.org/wiki/WebDAV) server —
running entirely inside a [Cloudflare Worker](https://workers.cloudflare.com/),
with no VPS, no monthly cost, and nothing to keep running.

It is a from-scratch TypeScript port of the TeraBox backend of
[bclone](https://github.com/BenjiThatFoxGuy/bclone) (itself a fork of
rclone), implemented against the private web API using the account session
cookie.

What you can do once deployed:

- Mount the TeraBox as a network drive with **rclone, davfs2, or any other
  WebDAV client** (Windows Explorer, macOS Finder, `curl`).
- List, read, write, move, copy, lock and delete files through standard
  WebDAV (`PROPFIND`, `GET`, `PUT`, `MOVE`, `COPY`, `LOCK`, …).
- Stay inside TeraBox's free tier with built-in rate pacing, and rely on a
  **Durable Object** for correct lock enforcement across isolates.

## Table of contents

- [Quick start](#quick-start)
- [Features](#features)
- [How it works](#how-it-works)
- [Configuration](#configuration)
  - [Getting your TeraBox COOKIE](#getting-your-terabox-cookie)
  - [Optional JSTOKEN](#optional-jstoken)
- [Deploying](#deploying)
  - [Deploy from the command line](#deploy-from-the-command-line)
  - [Auto-deploy from GitHub](#auto-deploy-from-github)
- [Using a WebDAV client](#using-a-webdav-client)
  - [rclone](#rclone)
  - [davfs2 (Linux)](#davfs2-linux)
- [Troubleshooting (FAQ)](#troubleshooting-faq)
- [Limitations](#limitations)
- [Development](#development)
- [Documentation index](#documentation-index)

## Quick start

```sh
# 1. Log in to terabox.com and copy your session cookie from the Network
#    tab (see "Getting your TeraBox COOKIE" below for exact steps)

# 2. Deploy the worker with your credentials as Secrets (repo carries none):
git clone git@github.com:taxin-404/terabox-webdav-worker.git
cd terabox-webdav-worker
npm install --legacy-peer-deps

npx wrangler login
npx wrangler secret put USERS   # e.g. "alice:s3cret,bob:hunter2"
npx wrangler secret put COOKIE  # your TeraBox cookie
npx wrangler deploy             # gives you https://<worker>.<subdomain>.workers.dev

# 3. Mount it with rclone:
rclone config create terabox webdav \
  url https://<worker>.<subdomain>.workers.dev/dav/ \
  vendor other \
  user alice \
  pass <your-webdav-password>
rclone lsd terabox:
```

## Features

| Area | Behavior |
| --- | --- |
| WebDAV surface | `OPTIONS`, `PROPFIND`, `PROPPATCH`, `MKCOL`, `GET`, `HEAD`, `PUT`, `DELETE`, `MOVE`, `COPY`, `LOCK`, `UNLOCK` per RFC 4918 |
| Auth | HTTP Basic over `USERS`; **fails closed** (`500 WebDAV server not configured`) when `USERS`/`COOKIE` are unset; a TeraBox session that dies mid-flight maps to `401` so clients re-authenticate |
| Locks & properties | Real `LOCK`/`UNLOCK` with 423 enforcement and dead properties, backed by a `DavState` Durable Object (one serialized instance for the whole account) |
| Downloads | Terabox CDN links with `Range` support; `HEAD` answers from metadata only |
| Uploads | Chunked Terabox upload (up to 4 GiB per file free, 128 GiB premium) |
| Rate safety | Every outbound call paced by `MIN_GAP_MS`; `Retry-After` honored (capped 5 s); jsToken re-minted at most once per 5 minutes |
| State | No persistent server state of your own: everything lives in the TeraBox account |

## How it works

| File | Responsibility |
| --- | --- |
| [`src/index.ts`](src/index.ts) | Entry point: Basic auth, env wiring, error → HTTP status mapping (see [Troubleshooting](#troubleshooting-faq)) |
| [`src/terabox.ts`](src/terabox.ts) | `TeraboxClient`: the private web API — listing, metadata, mkdir, downloads, filemanager ops (copy/move/rename/delete in adaptive async mode; upstream has no poll endpoint), chunked uploads |
| [`src/sign.ts`](src/sign.ts) | Signature/path helpers: `valuedCookie`, jsToken scraping, chunk sizing, RC4-style download signature |
| [`src/md5.ts`](src/md5.ts) | Dependency-free MD5 (Workers WebCrypto omits MD5; TeraBox chunk checksums need it) |
| [`src/webdav.ts`](src/webdav.ts) | RFC 4918 surface mapped over `TeraboxClient` |
| [`src/davxml.ts`](src/davxml.ts) | XML validation for `PROPFIND`/`PROPPATCH` bodies (malformed input → 400, never silently ignored) |
| [`src/davstate.ts`](src/davstate.ts) | Advisory state (lock records + dead properties) behind the `DavStore` interface: `DavState` Durable Object with per-isolate memory fallback |
| [`src/types.ts`](src/types.ts) | `Env` interface — every runtime setting in one place |

The jsToken is scraped from any root page of the origin at runtime and cached
(5 min TTL) — the worker always mints against its own egress IP, keeping the
token and session on the same network path.

## Configuration

All configuration is **per-instance and made by you in the Cloudflare
dashboard** — the repo carries no credentials and `wrangler.toml` ships no
`[vars]`. Only genuine credentials use the Secret type; everything else is
an ordinary Variable.

| Key | Type | Example | Purpose |
| --- | --- | --- | --- |
| `USERS` | **Secret** | `alice:s3cret,bob:hunter2` | WebDAV login. Comma or newline separated `user:pass` pairs. |
| `COOKIE` | **Secret** | `ndus=...; lang=en` | Your TeraBox session cookie. Only `ndus` is required (bare value accepted). |
| `JSTOKEN` | Secret, optional | `a1b2c3...` | Pre-minted `window.jsToken`. **Leave unset** — the worker mints its own (see below). |
| `TERABOX_DOMAIN` | Variable, optional | `https://dm.terabox.com` | Origin mirror (default `https://www.terabox.com`). **Regional accounts must set their own** — the wrong origin rejects the cookie with `errno -6`; upload clusters come from this origin's `locateupload`. |
| `MIN_GAP_MS` | Variable, optional | `400` | Pacing between TeraBox calls (default `400`, bclone parity). |
| `PATH` | Variable, optional | `/dav/` | Base path WebDAV lives under. Requests outside it 404; the bare base 301s to `/dav/`; all hrefs include it. |
| `ROOT_ID` | Variable, optional | `/backup` | TeraBox folder mounted as the WebDAV root (TeraBox keys folders by path): clients see only that subtree. |
| `LOG_PREFIX` | Variable, optional | `[prod]` | Tag prepended to worker log lines. |

Deploys preserve your dashboard-made values (`keep_vars = true`), so your
configuration survives every push.

### Getting your TeraBox COOKIE

1. Log in to **[terabox.com](https://www.terabox.com)** (or your regional
   mirror) in a desktop browser.
2. Open DevTools → **Network** and reload the page (`Ctrl`+`Shift`+`R`).
3. Click the first request in the list (the `document` entry, usually on
   top) and open its **Headers** tab.
4. Under **Request Headers**, right-click the `Cookie:` line and choose
   **Copy value**. That gives you exactly the one-line string the Secret
   needs:

   ```
   ndus=...; browserid=...; lang=...; ...
   ```

   > **Don't use the Console.** `document.cookie` omits `httpOnly` cookies —
   > and `ndus` is `httpOnly` — so you'd copy a string without the one cookie
   > that matters. The Network `Cookie:` header includes everything.
5. Paste that string into the `COOKIE` Secret: Worker → **Settings →
   Variables and secrets → Add variable** → Key `COOKIE`, tick **Secret**,
   paste the value, save (the "Add variable and deploy" button deploys it).

What matters:

- **Only `ndus` is required.** If you paste a bare `ndus` value, the worker
  normalizes it to `ndus=...; lang=en`.
- The other jar fields (`browserid`, `lang`, …) are optional device/locale
  hints and not proven necessary.
- **`stoken` is NOT required — and is not a TeraBox field at all.** It belongs
  to pan.baidu.com, it never appears in TeraBox's cookie jar, and a full
  upload running without it succeeded in live testing
  (`docs/terabox-limits.md` §5). The old "paste the full cookie including
  `stoken`" advice is folklore.
- The `ndus` cookie has a **fixed ~1-year lifetime** (it is not a sliding
  session). Other fields (`browserid`, `ndut_fmt`, `ndut_fmv`) rotate on
  website visits; the worker does not depend on them. See
  `docs/ndus-cookie-lifetime.md`.

### Optional JSTOKEN

- The jsToken is an anti-bot token TeraBox derives from page HTML.
- The worker **scrapes and caches it automatically** (5 min TTL, re-minted on
  `4000023`/`400141`/`450016`), minted from its own egress IP.
- A token minted in your browser console (`window.jsToken`) is bound to your
  browser's IP and session context — from the worker's datacenter IP it can
  be rejected. **Recommended: leave `JSTOKEN` unset.** It exists only for
  people who already pipeline one (Alist/CLI style) and know why.

## Deploying

### Deploy from the command line

```sh
npm install --legacy-peer-deps
npx wrangler login
npx wrangler secret put USERS
npx wrangler secret put COOKIE
# optional: npx wrangler secret put JSTOKEN
npx wrangler deploy
```

No manual Durable Object setup: the `DavState` class is declared in
`wrangler.toml` `[exports]` and provisioned automatically on first deploy.

### Auto-deploy from GitHub

The dashboard's Git integration builds the repo and deploys it on every push
to the production branch. The steps below are **live-verified (2026-10-11)**
against this exact repo — the resulting Worker built and deployed with the
defaults, Durable Object included.

1. Dashboard → **Workers & Pages → Create application**.
2. On **Select a method**, click **Continue with GitHub** (GitLab is also
   offered, as is *Clone a public repository via Git URL*). Authorize the
   GitHub app if this is your first time — your repositories then load.
3. In the **Select a repository** dialog, pick
   `taxin-404/terabox-webdav-worker` and click **Next**.
4. The **Set up your application** form appears. The defaults are already
   correct for this repo:

   | Field | Value |
   | --- | --- |
   | Project name | `terabox-webdav-worker` — defaults to the repo name; it becomes the Worker name and the `…<name>.<your-subdomain>.workers.dev` URL |
   | Build command | `npm run build` (default: `tsc --noEmit` + `wrangler deploy --dry-run`) |
   | Deploy command | `npx wrangler deploy` (default) |
   | Preview command | `npx wrangler preview` (default, optional) |
   | Enable Preview builds | on (optional) |
   | Advanced settings → Path | `/` — this is the root directory, leave it |

   Notes on what you will *not* find here: there is **no Production branch
   field** — it follows the repo's default branch (`main`), editable later
   under Settings → Builds. Cloudflare **installs dependencies itself** (it
   runs `npm ci` before the build), so do **not** put `npm install`/`npm ci`
   inside the Build command. The *Variable name / Value* pair under Advanced
   settings are **build-time** variables — you don't need them for this
   worker.
5. Click **Deploy**. Cloudflare clones the repo and runs it through
   `npm clean-install` → build → deploy. The `DavState` Durable Object class
   is provisioned automatically (live log shows
   `DAV_STATE → terabox-webdav-worker_DavState` in Bindings afterwards).
   You land on the new Worker's overview page.
6. Add the runtime configuration: open the Worker → **Settings → Variables
   and secrets → Add variable**. The dialog has a single **Secret** checkbox
   — tick it for `USERS`, `COOKIE` (and only if you must, `JSTOKEN`); add
   the optional Variables without it (`TERABOX_DOMAIN`, `MIN_GAP_MS`,
   `PATH`, `ROOT_ID`, `LOG_PREFIX`). The button says "Add variable
   **and deploy**": saving triggers a fresh deployment with those values.
7. From now on, every `git push origin main` runs the build and deploys
   automatically — including this Worker's future README/code changes.

Dashboard config survives every push: `wrangler.toml` ships
`keep_vars = true` and no `[vars]`, and secret values are never rewritten by
a deployment. Dashboard deploys ignore `.dev.vars` and `wrangler secret put`.

## Using a WebDAV client

### rclone

```sh
rclone config create terabox webdav \
  url https://<worker>.<subdomain>.workers.dev/dav/ \
  vendor other \
  user alice \
  pass <your-webdav-password>
```

If you did not set the `PATH` variable, drop the `/dav/` suffix. Uploads are
buffered in memory and sent as TeraBox chunks.

### davfs2 (Linux)

Mount it like any WebDAV server. Non-root mounts require an `/etc/fstab`
entry (davfs2's own rule):

```
https://<worker>.<subdomain>.workers.dev/dav/ /mnt/terabox davfs noauto,user,uid=1000,gid=1000 0 0
```

Then `mount /mnt/terabox` (no sudo). Credentials go in `~/.davfs2/secrets`
(or `/etc/davfs2/secrets` for system-wide mounts), one line per URL with
three whitespace-separated fields — `URL user password`. davfs2's parser
does **not** split `user:password` on a colon: that form parses as
username-only and triggers an interactive password prompt:

```
https://<worker>.<subdomain>.workers.dev/dav/ alice hunter2
```

Recommended `~/.davfs2/davfs2.conf`:

```
cache_size 2048   # MiB — CRITICAL, see warning below
delay_upload 0    # write back on close, not 10 s later
gui_optimize 1    # one PROPFIND per directory instead of per-file stats
use_locks 0       # skip advisory LOCK round-trips
buf_size 64       # larger kernel read/write buffer (16 default)
```

> **`cache_size` is not optional if you open large files.** davfs2's
> built-in default is **50 MiB**. While a file bigger than that is open, the
> cache tidy enforces the limit by deleting *every* cached file — including
> the large file's own cache entry — so the next open restarts the download
> from zero, forever. Set `cache_size` above your largest file. Full
> root-cause analysis: `docs/davfs2-etag-hang-investigation.md`.

Two behaviors worth knowing:

- davfs2 **downloads an entire file on `open()`** (it never sends `Range`),
  and it is single-threaded — a multi-gigabyte video ties up the mount
  while it downloads (~1.5 MB/s; a 1.1 GB file took ≈ 12 minutes in the
  investigation, `docs/davfs2-etag-hang-investigation.md`). Use rclone for
  those files.
- `lost+found/` in the mount is davfs2's own directory for failed uploads —
  it exists only in the client's view, never on the server.

## Troubleshooting (FAQ)

**`500 {"error":"WebDAV server not configured"}`?**

`USERS` or `COOKIE` is missing — the Worker fails closed until both are set.
Add them as Secrets under **Settings → Variables and secrets** (tick the
**Secret** checkbox) and save; the triggered deploy applies them immediately.

**`401 Unauthorized` / `WWW-Authenticate` loops?**

Either the WebDAV credentials are wrong, or the TeraBox session died.
TeraBox-side failures are mapped to HTTP 401 so clients re-authenticate:
`errno -6/-1/6` (expired `ndus`, wrong origin), `-19` (verification code
wanted), `450016/400141/4000023` (invalid session, IP gate, jsToken).
Fresh cookie → [Getting your TeraBox COOKIE](#getting-your-terabox-cookie).

**Why do I get `errno -6` even with a fresh cookie?**

Almost always the wrong origin for your account region — set
`TERABOX_DOMAIN` to your mirror (this account: `https://dm.terabox.com`) and
redeploy.

**Do I need a `stoken` in my COOKIE?**

No. TeraBox never issues `stoken` (it's a pan.baidu.com field). Uploads
verify live without it. See `docs/terabox-limits.md` §5.

**Do I need to set `JSTOKEN`?**

No — leave it unset. The worker mints and caches the jsToken itself against
its own IP. A browser-minted token may fail from a datacenter IP. See
[Optional JSTOKEN](#optional-jstoken).

**`507 Insufficient storage`?**

Your TeraBox plan's cap: files > 4 GiB on free accounts (`errno 58`);
account space exhausted (`errno -10/-32`). `docs/terabox-limits.md` §1.

**`404` for a file that exists?**

`errno -9` (not found) maps to HTTP 404. Also check `ROOT_ID`: if you mount
only a subtree, everything outside it is invisible (and 404s).

**How do I refresh my COOKIE when it expires?**

The `ndus` cookie lives ~1 year total (fixed lifetime), then you re-copy the
string from your browser as before. `wrangler secret put COOKIE` (or
dashboard → edit Secret) — the next request picks it up; no redeploy
required for secrets.

**What breaks if `DavState`/`DAV_STATE` is removed?**

Locks and dead properties fall back to per-isolate memory state: correct
per-request, but not shared across isolates. The Worker keeps serving.

## Limitations

- **Non-zero `Depth` `PROPFIND` returns children** (same policy as the drive
  WebDAV workers); infinite-depth listings are not crawled.
- **Downloads go through a TeraBox CDN link with `Range` support**; `HEAD`
  only examines metadata.
- **`USERS`/`COOKIE` are required** — unset, the Worker answers
  `500 {"error":"WebDAV server not configured"}` for everyone. There is no
  anonymous read mode.
- **TeraBox is the source of truth**: quotas, file-size caps, rate gates and
  regional origin rules all come from the account. The full reference (errno
  table, gates, upload pipeline) is `docs/terabox-limits.md`.

## Development

```sh
npm install --legacy-peer-deps   # wrangler pins + sharp override
npm run typecheck                # tsc --noEmit
npm test                         # Vitest: 277 cases over a mocked TeraBox API
npm run review                   # typecheck + tests + dry-run deploy (no upload)
npm run dev                      # local wrangler dev server (http://localhost:8787)
npm run deploy                   # wrangler deploy (push to production)
```

The test-suite mocks the TeraBox API behind a stubbed global `fetch`, so the
whole stack (auth, routing, WebDAV, uploads) is exercised without a real
account. To try a live account you still need a real cookie — a copy-pasted
browser jar is fine (only `ndus` is required); see
[Getting your TeraBox COOKIE](#getting-your-terabox-cookie).

Live end-to-end verification notes live in `docs/live-testing.md`.

## Documentation index

| Doc | Covers |
| --- | --- |
| [`docs/terabox-limits.md`](docs/terabox-limits.md) | TeraBox API limits: errno table, rate gates, IP-reputation, sessions & cookies, upload pipeline |
| [`docs/terabox-openapi.md`](docs/terabox-openapi.md) | Full extraction of the official TeraBox Open Platform API docs |
| [`docs/ndus-cookie-lifetime.md`](docs/ndus-cookie-lifetime.md) | Cookie anatomy + lifetime evidence (`ndus` fixed ~1y, rotating extras) |
| [`docs/davfs2-etag-hang-investigation.md`](docs/davfs2-etag-hang-investigation.md) | Root cause of the davfs2 `cache_size` re-download loop |
| [`docs/live-testing.md`](docs/live-testing.md) | How the worker was verified live against a real account |