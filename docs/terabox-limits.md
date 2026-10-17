# TeraBox limitations (and how this worker deals with them)

A catalog of the real, verified constraints TeraBox imposes. Everything here was
observed live during the campaigns in `live-testing.md`, taken from competing
clients' source (bclone/alist), or both. "Measured" = we ran it against the real
service from Cloudflare.

## 1. Account & storage

| Limit | Value | Source |
|---|---|---|
| Free storage | 1 TB per account | TeraBox free tier (product-wide) |
| Max file size, free | 4 GiB per file | bclone `api.go` (`size > 4 GiB && !isPremium` → rejected) |
| Max file size, premium | 128 GiB per file | bclone `api.go` (same check, premium branch) |
| Directory depth | ≤ 16 levels | documented drive-side constraint (also encoded in bclone's tree walker) |
| Filename length | ≤ 255 bytes per segment | measured (long/unicode/`%`/`#`/`?`/quote names all work up to 255) |
| Deleted files | recycle bin, auto-purge after 10 days | product behavior, verified: `DELETE` → file reappears in bin, not gone |

- Over-quota uploads fail at `precreate` with `-10` (or its errno alias), which
  the worker surfaces as **HTTP 507 Insufficient Storage**.
- `DELETE` moves to the recycle bin (web-app parity); it does **not** free quota
  immediately, and the worker deliberately never calls `/api/recycle/clear`
  (that would purge trash the user created themselves in the TeraBox app).

## 2. Rate limiting & anti-abuse (the big one)

| Behavior | Detail | Status |
|---|---|---|
| Call pacing | bclone sleeps **400 ms minimum** between upstream API calls; faster bursts earn `429` / `400141` / silent throttling | worker paces every outbound call with `MIN_GAP_MS` (400 default, `wrangler.toml` var) — **account-wide**: the reservation is serialized through the DAV_STATE DO (`/api-slot`), with the per-isolate floor as backstop when the DO is unbound, unreachable or cooling down |
| jsToken | mintable from any root page (`/main?category=all`, `about`, `privacy`) with desktop `sec-ch-ua` headers; 128 hex chars | worker mints + caches (`JS_TOKEN_CACHE`, 5 min TTL), refreshes on `4000023` / `450016` |
| Missing token | `filemanager` without jsToken → `450016 need verify` (HTTP 200 body) | worker always attaches token |
| **IP-reputation gate (400141)** | **web dlink path (`/file/<hash>`) answers `400141 need verify` from datacenter IPs on every origin and flavour — plain `filemetas` dlink, `origin=dlna`, official `/api/download` token dlink, even host-rewritten browser URLs. A fresh jsToken does not clear it.** | **solved**: download uses the app-protocol **PCS route** `/rest/2.0/pcs/file?method=download` which 302s to CDN with no jsToken/sign (see §3) |
| Rate on API | ~1 req / 400 ms → a paced 3-step GET ≈ 2.7 s **cold** TTFB (measured); repeat opens hit the download-URL cache instead (~0.12 s) | ladder is lazy: extra phases only run if a phase fails; CDN hops are unpaced (not the API origin) |
| jsToken ↔ IP/session | refreshing it from a different IP invalidates the session context; keep it same-IP | worker mints from its own egress only |

## 3. Download paths

- **Two-hop shape**: signed dlink `/api/.../file/<hash>` → **302** → CDN
  capability URL. The CDN hop needs **no cookie at all**; the signed hop does.
- **Expiry**: `filemetas` dlinks ≈ **8 h**, official `/api/download` dlinks ≈ **1 h** (measured). The worker mints on demand but then **caches the final signed CDN capability URL** (per isolate, identity-validated, self-healing — §6): a cold GET pays the ladder (~2.7 s), every repeat open is one direct CDN fetch (~0.12 s).
- **Gate** (above): from datacenter IPs only the **PCS app-protocol route** survives:
  `GET /rest/2.0/pcs/file?method=download&app_id=250528&path=<path>` + session
  cookie → immediate `302` to CDN. Same route family as `locateupload`
  (live-proven reachable from Cloudflare).
- **Fallback ladder** (lazy, each phase only if the previous fails):
  1. PCS route on `<label>-d` / `<label>-data` / origin
  2. official `/api/download` token dlink (minted only if phase 1 fails)
  3. plain `filemetas` dlink
  4. last `400141` rethrown as **401** with `step: dlink@<host>`
- **Throughput (measured, 20 MB file, Cloudflare → TeraBox CDN)**:
  - single stream: **~1.5–2.0 MB/s ≈ 12–16 Mbps** sustained (md5 verified end-to-end)
  - 4 parallel `Range` GETs: all `206`, parts reassemble to the correct md5;
    aggregate ≈ same link cap (~1.4–1.8 MB/s) — bandwidth to the CDN appears
    capped per path, so extra transfers cut latency, not total time
  - TTFB: **≈2.7 s cold** (filemetas → PCS → CDN hop, hop unpaced) vs
    **≈0.12 s on repeat open** and **≈0.96 s after the 60 s meta expiry**
    (measured 2026-10-11, Range 0-0 probe) — the byte stream itself is not
    throttled
  - this is a **TeraBox free-tier CDN/account** speed, identical for every
    client; the worker adds zero per-byte delay (pacing is per *call*, not per byte)
  - **Worker Placement cannot raise it** (tested 2026-10-11): Smart never
    moved the worker (all traffic enters at HKG), and the Region hint
    `aws:ap-northeast-1` — `cf-placement: remote-NRT` confirmed — served
    the same 70 MB file at **1.83 MB/s vs 1.80 MB/s at HKG** (and a second
    file/cluster at 1.28 MB/s). Egress colo is irrelevant to the cap, so
    placement was reverted: it bought nothing but cross-region Durable
    Object latency.
- The user's own ISP path (TH → KL peering, ~29 KB/s measured) is bypassed
  entirely: bytes flow TeraBox CDN → Cloudflare → client.

## 4. Upload pipeline

- **Cluster table**: `locateupload` hands out per-session upload clusters
  (`dm1`/`dm2`/`kul-cdata…`); sometimes it answers only `-6`/no URL, so the
  worker falls back to base-host upload URLs (alist parity).
- **Signed params**: chunk upload needs `uploadsign` generated with the page's
  `bdstoken` + WEB UA/APP ID (web-app parity).
- **Chunks**: files split by
  `getChunkSize()`; each chunk POSTs to the chosen cluster, then `create`
  verifies `block_list` (per-chunk md5 + upload md5).
  The worker re-computes the control md5 itself and raises `-5` (→ 502) on
  mismatch; upstream `-32` is "space insufficient" (→ 507).
- **Chunk-size floor + ceiling (2026-10-17, live-measured both ways)**: a
  splitting upload's FIRST full part must be ≥ 4 MiB — TeraBox rejects
  smaller with `error_code 31299` ("Size of superfile2 first part should
  not be smaller than slice size"), tried at 2 MiB on both a >4 GiB
  premium-class file and a 5 MiB free-class file across all upload
  clusters. Single-part uploads are exempt (the one part is the short last
  part). So `getChunkSize` floors any truly-splitting session at 4 MiB
  even when `MAX_CHUNK_BYTES` would shrink it, and the default cap IS
  4 MiB — the smallest legal slice and the Campaign-6-proven setting.
  Above it, `MAX_CHUNK_BYTES` restores the tier's larger premium buckets
  (8-32 MiB) — the paid-plan recipe: fewer, larger part requests.
  Practical verdict for the Workers **free** plan: ≤ 4 GiB files upload
  fine at 4 MiB parts; > 4 GiB premium-class sessions hit the free-plan
  per-request CPU budget (`503 error code: 1102`) late in the session —
  smaller parts are protocol-impossible, so that class needs a paid
  deployment.
- **`rtype` semantics** (filemanager): `0` = wait for sync, `1` = adaptive
  (returns before completion — the worker passes `rtype=1` and polling
  reconciles), `2` = pure async.
- **Pacing applies here too**: chunk uploads run through the same 400 ms gate —
  a 20 MB PUT measured **18.2 s** (5 chunks × paced calls). Upload is slow by
  design to keep the account unbanned.

## 5. Sessions & cookies

- Cookie = `ndus` (the session) plus rotating device/locale fields
  (`browserid`, `lang`, … — observed jar recorded in
  `docs/ndus-cookie-lifetime.md`; none of the extras is proven necessary).
  It is a **secret** (never
  committed; dashboard Secret only). Sessions expire — when they do, every
  call fails with `2/check/login` errno and the cookie must be refreshed.
- **`stoken` is not required.** Live-verified 2026-10-11: a cookie with no
  `stoken` ran the full upload pipeline (`api/precreate` → locateupload →
  `pcs/superfile2` → `api/create`) to `errno 0` + `fs_id` on the `dm*` cluster.
  (The `-3`/`31045` "user not exists" errors people attribute to a missing
  `stoken` are really the **wrong cluster/origin** — `d.terabox.com`-flavoured
  hosts reject the session; same-origin `dm*` clusters accept it — see
  `docs/live-testing.md` "Root cause found".)
  `stoken` doesn't appear in TeraBox's observed cookie jar at all
  (`docs/ndus-cookie-lifetime.md`) — it's pan.baidu.com's field, which is
  also why the old "paste the full cookie incl. `stoken`" advice is
  boilerplate that doesn't reflect what this API path actually checks.
  Verify the upload path empirically instead of trusting field-name
  folklore.
- `JSTOKEN` is optional: only the cookie the WebDAV client sends is ever
  echoed back; the page-minted jsToken stays server-side.
- `bdstoken` is embedded in the account page HTML (used for `filemanager` +
  `uploadsign`); refreshed lazily when 4000023 fires.
- Region binding: accounts are tied to a deployment (`dm.terabox.com` cluster
  table); wrong origin → `31045` or `Url-Domain-Prefix` (`-6`) redirect.

## 6. What is *not* a TeraBox limit (worker-side design)

- **WebDAV locks & dead properties are Durable-Object-backed (2026-10-10
  upgrade).** All advisory state lives behind a `DavStore` interface
  (`src/davstate.ts`) with two implementations sharing one set of pure core
  functions, so semantics cannot drift:
  - **`RemoteDavStore` + `DavState` DO (default when `DAV_STATE` is bound)**:
    one serialized instance per account (`idFromName('terabox-dav-state')`),
    write-through SQLite storage. Every WebDAV isolate talks to the same
    object, so Cloudflare's isolate scheduling cannot make lock enforcement
    or dead-prop reads flaky — this removed the last conformance flake
    (measured: three consecutive `locks` runs at **40/40** after the DO,
    versus zero clean runs in five attempts before it; full suite
    **105/105**).
  - **`MemoryDavStore` (fallback when no binding)**: the original
    per-isolate maps, used automatically (tests, or if the binding is ever
    removed). Enforcement *relaxes* across isolate hops (empty store allows
    the write) and self-issued tokens carry their expiry, so clients are
    never bricked; worst case a client re-locks.
  - Locks are **real** in both: un-tokened writes to a locked resource
    answer `423`, UNLOCK validates its token (`409`), `lockdiscovery`
    reports the active lock, shared locks stack, refresh works through
    `Depth: Infinity` ancestors, and `If` headers are evaluated
    (`412`/`423`).
  - Dead props are keyed by expanded `{namespace}local` name, migrate on
    MOVE (+prefix for collections), copy on COPY, and are cleared on
    DELETE — all through the same store API.
- **Creation is RFC-strict**: MKCOL, PUT and MOVE/COPY all require an
  existing parent collection (`409` otherwise, RFC 4918 §9.3.1/§9.7.1/§9.9.3).
  The Google Drive worker auto-creates parents on PUT/MKCOL instead; this
  worker follows the RFC (litmus `basic` 16/16) — clients build the tree
  level by level, which every mainstream WebDAV client already does.
- **Download-URL cache (shipped 2026-10-11, was "TTFB / no URL cache")**:
  the final signed CDN capability URL from a successful ladder walk is kept
  per isolate (30 min TTL, FIFO 1000) and replayed directly on the next GET —
  no filemetas re-mint, no PCS round-trip, no pacing floor. Entries are
  validated against the served item's `fs_id` + size + mtime (the 60 s meta
  staleness contract is unchanged), dropped by the same write-invalidation
  hooks and DO generation bump as `metaCache`, and any upstream refusal
  self-heals by falling back to the ladder. Measured: repeat-open TTFB
  2.4-5.1 s → **0.12-0.24 s**.
- **No parallel-range bandwidth gain**: limited by the CDN path cap, not by the
  worker.

## Quick reference: errno → HTTP mapping

| errno / condition | HTTP |
|---|---|
| ok (`0`) | 2xx |
| `-10` out of space (precreate) | 507 |
| `-32` out of space (upload) | 507 |
| `need verify` / `400141` / `450016` on a download | 401 (`step: dlink@<host>`) |
| `2/check/login` | 401 |
| `31045` wrong region | 502 |
| recycle/purge refused | kept out of band (never called) |

See also: `live-testing.md` (campaign log with every probe behind these claims).
