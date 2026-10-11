import { DurableObject } from 'cloudflare:workers';
import type { Env } from './types';

/**
 * Advisory WebDAV state (lock records + dead properties).
 *
 * The state lives behind the {@link DavStore} interface with two
 * implementations:
 *
 *  - {@link MemoryDavStore} — per-isolate maps, the zero-dependency default.
 *    Enforcement *relaxes* across isolate hops (an empty store allows the
 *    write) and self-issued tokens carry their expiry, so clients are never
 *    bricked; this is the pre-Durable-Object behaviour.
 *  - {@link RemoteDavStore} — a single Durable Object (`DavState`) that holds
 *    the state for the whole account. Every WebDAV isolate talks to the same
 *    object, so locks/dead props are consistent no matter how Cloudflare
 *    schedules requests; litmus's sequential suite becomes deterministic.
 *
 * Both implementations delegate to the same pure core functions below, so
 * the semantics cannot drift.
 */

export interface LockRecord {
  token: string;
  scope: 'exclusive' | 'shared';
  /** RFC 4918 depth: "0" or "Infinity". */
  depth: string;
  /** Inner XML of the request's <owner> element. */
  owner: string;
  expiresAt: number;
  /**
   * Encoded href of the resource the lock was TAKEN on (§14.12 lockroot).
   * A refresh answered through a descendant, or a lockdiscovery PROPFIND on
   * a child, must still advertise the lock's own root — not the URI the
   * request happened to arrive at. Absent on records minted before this
   * field existed: callers fall back to the request URI.
   */
  rootHref?: string;
}

export interface PathState {
  locks: LockRecord[];
  props: Record<string, string>;
}

export interface LockRequest {
  shared: boolean;
  depth: string;
  owner: string;
  presented: string[];
  seconds: number;
  /** Encoded href of `path`, captured for the record's lockroot. */
  rootHref?: string;
}

export interface LockOutcome {
  ok: boolean;
  refreshed: boolean;
  /** Present only when `ok` (or when a conflicting record had to be quoted). */
  record?: LockRecord;
  /**
   * The request carried an If header whose tokens name a live lock that does
   * NOT cover the Request-URI: the condition is false → 412 (RFC 4918
   * §9.10.6). Distinct from `ok: false` alone, which means 423 "locked".
   */
  precondition?: boolean;
}

export type UnlockOutcome = 'removed' | 'lapsed' | 'nomatch';

export interface TokenCheck {
  /** Presented tokens that apply (live record match, or our own unexpired). */
  applies: string[];
  /** Tokens of the live records applying to the path (enforcement needs them). */
  recordTokens: string[];
  /** Number of live records applying to the path (self + Infinity ancestors). */
  applying: number;
}

export interface PropPatchOp {
  op: 'set' | 'remove';
  key: string;
  markup: string;
}

export interface RelocateItem {
  src: string;
  dest?: string;
  mode: 'move' | 'copy' | 'forget';
  recursive: boolean;
  /** Move lock records too (true for MOVE; locks are never copied). */
  withLocks?: boolean;
}

export interface DavStore {
  checkTokens(path: string, tokens: string[]): Promise<TokenCheck>;
  lockAcquire(path: string, req: LockRequest): Promise<LockOutcome>;
  unlock(path: string, token: string): Promise<UnlockOutcome>;
  describe(paths: string[]): Promise<Record<string, PathState>>;
  propPatch(path: string, ops: PropPatchOp[]): Promise<Record<string, string>>;
  relocate(items: RelocateItem[]): Promise<void>;
  /**
   * Shared metadata-cache generation. Every worker write bumps it; isolates
   * compare it before trusting their local read-side cache, which is what
   * makes "writes through this worker invalidate immediately" true across
   * isolates (the cache itself lives per isolate). `bump` increments and
   * returns the new value; otherwise the current value is returned.
   */
  metaGeneration(bump: boolean): Promise<number>;
}

/* ------------------------------------------------------------------ */
/* Resumable upload sessions (for bodies larger than the Workers cap)  */
/* ------------------------------------------------------------------ */

/**
 * One resumable upload: Terabox's native multipart (precreate → superfile2
 * chunks → create) driven across many small HTTP requests so a single body
 * never exceeds Cloudflare's ~100 MB account-plan edge limit. Session state
 * lives in the Durable Object so any isolate can serve the next chunk.
 */
export interface UploadSession {
  path: string;
  size: number;
  mtimeMs: number;
  uploadId: string;
  uploadSign: string;
  chunkSize: number;
  chunkCount: number;
  /** Per-chunk md5 from superfile2; null until that chunk lands. */
  chunkMd5s: Array<string | null>;
  hosts: string[];
  overwriteMode: number;
  createdAt: number;
  /** Host that accepted the last chunk; tried first on the next one. */
  activeHost?: string;
  /**
   * Set once finalize succeeded: the HTTP status to replay (201/204).
   * A retried finalize after a lost response then answers identically
   * instead of 404 (the session was not yet swept), so a client retry
   * cannot misreport a completed upload as a failure.
   */
  finalized?: number;
  /** When finalize succeeded — finalized sessions only linger for the retry
   *  grace window below, not the full session TTL. */
  finalizedAt?: number;
  /**
   * Non-undefined while a finalize is in flight: the atomic claim taken by
   * the request that owns the create. A second concurrent finalize POST
   * (a client retry racing a slow create) sees it, waits, and replays the
   * owner's verdict instead of racing a second create — which the upstream
   * would answer with -8 (path conflict) for a file that DID land.
   */
  finalizing?: number;
}

/**
 * Upload sessions that never finalize would otherwise leak in the Durable
 * Object forever. 24 h is far longer than any real multipart upload (even a
 * 4 GiB free-tier file streams in well under an hour) but bounded enough to
 * keep storage from growing without limit.
 */
export const UPLOAD_SESSION_TTL_MS = 24 * 60 * 60 * 1000;
/** How long a successfully finalized session is kept so a retried finalize
 *  replays its status instead of 404. Long past any HTTP retry window,
 *  short enough that finished uploads do not accumulate. */
export const UPLOAD_FINALIZED_GRACE_MS = 10 * 60 * 1000;
/** A finalize claim held longer than this may be taken over: an isolate that
 *  died mid-finalize must not wedge the session for its whole TTL. Comfortably
 *  past the create call's worst-case retry ladder, so a live owner is never
 *  preempted. */
export const FINALIZE_CLAIM_TTL_MS = 2 * 60 * 1000;

function isExpired(session: UploadSession): boolean {
  // A completed session only has to outlive a lost-response retry; keeping it
  // for the full TTL would let `persist()` serialize an ever-growing list of
  // finished uploads (one per file, 256 md5s each) on every chunk PUT.
  if (session.finalized) {
    return Date.now() - (session.finalizedAt ?? session.createdAt) > UPLOAD_FINALIZED_GRACE_MS;
  }
  return Date.now() - session.createdAt > UPLOAD_SESSION_TTL_MS;
}

/**
 * Result of the atomic finalize claim. `owned` — this request now runs the
 * create; `replay` — a finished finalize answers with its recorded status;
 * `busy` — another request holds the claim; `unknown` — session gone.
 */
export type FinalizeClaim =
  | { kind: 'owned' }
  | { kind: 'busy' }
  | { kind: 'unknown' }
  | { kind: 'replay'; status: number };

export interface UploadStore {
  init(session: UploadSession): Promise<void>;
  get(uploadId: string): Promise<UploadSession | undefined>;
  recordChunk(uploadId: string, index: number, md5: string, activeHost?: string): Promise<void>;
  /** Record that finalize succeeded so a retried finalize replays its status. */
  markFinalized(uploadId: string, status: number): Promise<void>;
  /** Atomically claim exclusive rights to run finalize for this session. */
  claimFinalize(uploadId: string): Promise<FinalizeClaim>;
  /** Give the claim back after a failed finalize so a retry can claim anew. */
  releaseFinalize(uploadId: string): Promise<void>;
  delete(uploadId: string): Promise<void>;
}

/* ------------------------------------------------------------------ */
/* Token helpers (shared by the WebDAV layer, both stores, and the DO) */
/* ------------------------------------------------------------------ */

/**
 * Self-issued tokens carry their expiry: a warm client's token keeps working
 * for the rest of its life even when the record behind it was lost to an
 * isolate rotation, so writes are never spuriously blocked.
 */
export function isOurUnexpiredToken(token: string): boolean {
  const m = /^opaquelocktoken:[0-9a-fA-F-]{36}:(\d{13,})$/.exec(token);
  return m !== null && Number(m[1]) > Date.now();
}

export function makeLockToken(seconds: number): string {
  return `opaquelocktoken:${crypto.randomUUID()}:${Date.now() + seconds * 1000}`;
}

/** Extract every `<...>` token from an If / Lock-Token style header value. */
export function collectTokens(header: string | null): string[] {
  if (!header) return [];
  const tokens: string[] = [];
  for (const m of header.matchAll(/<([^<>\s]+)>/g)) {
    if (m[1] !== undefined) tokens.push(m[1]);
  }
  return tokens;
}

/* ------------------------------------------------------------------ */
/* Pure core: the single source of truth for both store implementations */
/* ------------------------------------------------------------------ */

function purgeAt(locks: Map<string, LockRecord[]>, path: string): LockRecord[] {
  const records = locks.get(path);
  if (!records) return [];
  const now = Date.now();
  const live = records.filter((r) => r.expiresAt > now);
  if (live.length > 0) locks.set(path, live);
  else locks.delete(path);
  return live;
}

/** Locks on the path itself, plus Infinity-depth locks on its ancestors. */
/**
 * Does the lock stored at `key` govern `path`? Exact hit, or an
 * Infinity-depth ancestor (RFC 4918 §9.11 scope). Shared by enforcement,
 * refresh, precondition and UNLOCK so all four answer identically.
 */
function lockCovers(key: string, record: LockRecord, path: string): boolean {
  if (key === path) return true;
  if (record.depth !== 'Infinity') return false;
  if (key === '/') return path.startsWith('/');
  return path.startsWith(key + '/');
}

function applyingLocksOf(locks: Map<string, LockRecord[]>, path: string): LockRecord[] {
  const now = Date.now();
  const out: LockRecord[] = [];
  for (const [lockedPath, records] of locks) {
    for (const rec of records) {
      if (rec.expiresAt <= now) continue;
      if (lockCovers(lockedPath, rec, path)) out.push(rec);
    }
  }
  return out;
}

function coreCheckTokens(
  locks: Map<string, LockRecord[]>,
  path: string,
  tokens: string[],
): TokenCheck {
  purgeAt(locks, path);
  const applying = applyingLocksOf(locks, path);
  const recordTokens = applying.map((r) => r.token);
  const applies: string[] = [];
  for (const token of new Set(tokens)) {
    if (recordTokens.includes(token) || isOurUnexpiredToken(token)) applies.push(token);
  }
  return { applies, recordTokens, applying: applying.length };
}

function coreLockAcquire(
  locks: Map<string, LockRecord[]>,
  path: string,
  req: LockRequest,
): LockOutcome {
  const now = Date.now();
  // A presented token that names a LIVE lock not covering this URI means
  // the If condition fails (RFC 4918 §9.10.6) → 412. Checked BEFORE the
  // refresh below, so a request carrying a valid refresh token *plus* an
  // unrelated live token cannot slip through; tokens that DO cover this
  // path (including from an Infinity ancestor) never trip it, which keeps
  // indirect refresh working.
  const ownedElsewhere = req.presented.some((token) =>
    [...locks.entries()].some(
      ([key, records]) =>
        records.some((r) => r.token === token && r.expiresAt > now && !lockCovers(key, r, path)),
    ),
  );
  if (ownedElsewhere) return { ok: false, refreshed: false, precondition: true };
  // Refresh: a presented token matches a lock on this resource or on an
  // Infinity-depth ancestor (litmus indirect_refresh) — extend in place.
  const refreshable = applyingLocksOf(locks, path).find((r) => req.presented.includes(r.token));
  if (refreshable) {
    refreshable.expiresAt = now + req.seconds * 1000;
    return { ok: true, refreshed: true, record: refreshable };
  }
  const existing = purgeAt(locks, path);
  if (existing.length > 0) {
    // Already locked and not the owner: an exclusive lock admits nothing
    // else, and a shared lock admits only further shared requests
    // (RFC 4918 §9.10.6).
    if (!req.shared || existing.some((r) => r.scope === 'exclusive')) {
      return {
        ok: false,
        refreshed: false,
        record: existing.find((r) => r.scope === 'exclusive') ?? existing[0]!,
      };
    }
  }
  // Re-acquire the client's own still-valid token when its record was lost
  // (isolate rotation); any other presented token is ignored and a fresh
  // one minted.
  const token = req.presented.find(isOurUnexpiredToken) ?? makeLockToken(req.seconds);
  const record: LockRecord = {
    token,
    scope: req.shared ? 'shared' : 'exclusive',
    depth: req.depth,
    owner: req.owner,
    expiresAt: now + req.seconds * 1000,
    rootHref: req.rootHref,
  };
  const records = locks.get(path) ?? [];
  records.push(record);
  locks.set(path, records);
  return { ok: true, refreshed: false, record };
}

function coreUnlock(
  locks: Map<string, LockRecord[]>,
  path: string,
  token: string,
): UnlockOutcome {
  const now = Date.now();
  let liveTokenElsewhere = false;
  // A lock covers this URI when it is stored here, or when an ancestor holds
  // an Infinity-depth lock over it. RFC 4918 §9.11: UNLOCK removes the lock
  // from the resource AND everything in its scope — so unlocking a child with
  // the collection's token must free the collection's lock, not answer 204
  // and leave the 423 in force until the timeout.
  for (const [key, records] of locks) {
    const live = records.filter((r) => r.expiresAt > now);
    if (live.length !== records.length) {
      if (live.length > 0) locks.set(key, live);
      else locks.delete(key);
    }
    const index = live.findIndex((r) => r.token === token);
    if (index === -1) continue;
    const record = live[index]!;
    // The token is real but belongs to a lock that does not cover this URI:
    // that is a genuine mismatch (409), not a lapsed record.
    if (!lockCovers(key, record, path)) {
      liveTokenElsewhere = true;
      continue;
    }
    live.splice(index, 1);
    if (live.length > 0) locks.set(key, live);
    else locks.delete(key);
    return 'removed';
  }
  if (liveTokenElsewhere) return 'nomatch';
  // A self-issued token whose record is gone means the lock has already
  // lapsed: succeeding is the graceful answer. Foreign/forged tokens 409.
  return isOurUnexpiredToken(token) ? 'lapsed' : 'nomatch';
}

function coreDescribe(
  locks: Map<string, LockRecord[]>,
  props: Map<string, Record<string, string>>,
  paths: string[],
): Record<string, PathState> {
  const out: Record<string, PathState> = {};
  for (const path of new Set(paths)) {
    purgeAt(locks, path);
    // §13.10: lockdiscovery lists every lock that APPLIES to the resource,
    // including one held by an Infinity-depth ancestor — a child must not
    // report `<D:lockdiscovery/>` while it is in fact write-locked.
    out[path] = {
      locks: applyingLocksOf(locks, path),
      props: props.get(path) ?? {},
    };
  }
  return out;
}

function corePatch(
  props: Map<string, Record<string, string>>,
  path: string,
  ops: PropPatchOp[],
): Record<string, string> {
  const store = { ...(props.get(path) ?? {}) };
  for (const op of ops) {
    if (op.op === 'set') store[op.key] = op.markup;
    else delete store[op.key];
  }
  if (Object.keys(store).length > 0) props.set(path, store);
  else props.delete(path);
  return store;
}

function forgetCore<T>(store: Map<string, T>, path: string, recursive: boolean): void {
  store.delete(path);
  if (!recursive) return;
  for (const key of [...store.keys()]) {
    if (key.startsWith(path + '/')) store.delete(key);
  }
}

function rekeyCore<T>(
  store: Map<string, T>,
  src: string,
  dest: string,
  mode: 'move' | 'copy',
  recursive: boolean,
): void {
  const relocated: Array<[string, T]> = [];
  if (store.has(src)) relocated.push([dest, store.get(src)!]);
  if (recursive) {
    for (const [key, value] of store) {
      if (key.startsWith(src + '/')) relocated.push([dest + key.slice(src.length), value]);
    }
  }
  if (mode === 'move') forgetCore(store, src, recursive);
  for (const [key, value] of relocated) store.set(key, value);
}

function coreRelocate(
  locks: Map<string, LockRecord[]>,
  props: Map<string, Record<string, string>>,
  item: RelocateItem,
): void {
  if (item.mode === 'forget') {
    forgetCore(props, item.src, item.recursive);
    forgetCore(locks, item.src, item.recursive);
    return;
  }
  rekeyCore(props, item.src, item.dest!, item.mode, item.recursive);
  if (item.mode === 'move' && item.withLocks) {
    rekeyCore(locks, item.src, item.dest!, 'move', item.recursive);
  }
}

/* ------------------------------------------------------------------ */
/* In-memory implementation (default, per isolate)                     */
/* ------------------------------------------------------------------ */

export class MemoryDavStore implements DavStore, UploadStore {
  private locks = new Map<string, LockRecord[]>();
  private props = new Map<string, Record<string, string>>();
  private uploads = new Map<string, UploadSession>();
  private metaGen = 0;

  /** Test hook: clear per-isolate advisory state between test cases. */
  reset(): void {
    this.locks.clear();
    this.props.clear();
    this.uploads.clear();
  }

  async checkTokens(path: string, tokens: string[]): Promise<TokenCheck> {
    return coreCheckTokens(this.locks, path, tokens);
  }

  async lockAcquire(path: string, req: LockRequest): Promise<LockOutcome> {
    return coreLockAcquire(this.locks, path, req);
  }

  async unlock(path: string, token: string): Promise<UnlockOutcome> {
    return coreUnlock(this.locks, path, token);
  }

  async describe(paths: string[]): Promise<Record<string, PathState>> {
    return coreDescribe(this.locks, this.props, paths);
  }

  async propPatch(path: string, ops: PropPatchOp[]): Promise<Record<string, string>> {
    return corePatch(this.props, path, ops);
  }

  async relocate(items: RelocateItem[]): Promise<void> {
    for (const item of items) coreRelocate(this.locks, this.props, item);
  }

  async init(session: UploadSession): Promise<void> {
    // Same lazy sweep the Durable Object runs: without it, a deployment with
    // no DAV_STATE binding accumulates abandoned sessions until recycle.
    for (const [id, existing] of this.uploads) {
      if (isExpired(existing)) this.uploads.delete(id);
    }
    this.uploads.set(session.uploadId, session);
  }

  async get(uploadId: string): Promise<UploadSession | undefined> {
    const session = this.uploads.get(uploadId);
    if (!session) return undefined;
    if (isExpired(session)) {
      this.uploads.delete(uploadId);
      return undefined;
    }
    return session;
  }

  async recordChunk(uploadId: string, index: number, md5: string, activeHost?: string): Promise<void> {
    const session = this.uploads.get(uploadId);
    if (session) {
      session.chunkMd5s[index] = md5;
      if (activeHost) session.activeHost = activeHost;
    }
  }

  async metaGeneration(bump: boolean): Promise<number> {
    if (bump) this.metaGen += 1;
    return this.metaGen;
  }

  async markFinalized(uploadId: string, status: number): Promise<void> {
    const session = this.uploads.get(uploadId);
    if (session) {
      session.finalized = status;
      session.finalizedAt = Date.now();
      session.finalizing = undefined;
    }
  }

  async claimFinalize(uploadId: string): Promise<FinalizeClaim> {
    const session = this.uploads.get(uploadId);
    if (!session) return { kind: 'unknown' };
    if (session.finalized !== undefined) return { kind: 'replay', status: session.finalized };
    const now = Date.now();
    // Check and set with no await in between: the single-isolate runtime
    // makes that an atomic claim, mirroring the DO route below.
    if (session.finalizing !== undefined && now - session.finalizing < FINALIZE_CLAIM_TTL_MS) {
      return { kind: 'busy' };
    }
    session.finalizing = now;
    return { kind: 'owned' };
  }

  async releaseFinalize(uploadId: string): Promise<void> {
    const session = this.uploads.get(uploadId);
    if (session && session.finalized === undefined) session.finalizing = undefined;
  }

  async delete(uploadId: string): Promise<void> {
    this.uploads.delete(uploadId);
  }
}

const sharedMemoryStore = new MemoryDavStore();

/** Test hook: clear per-isolate advisory state between test cases. */
export function resetDavVolatileState(): void {
  sharedMemoryStore.reset();
}

/** Pick the store: Durable Object when bound, per-isolate memory otherwise. */
export function createDavStore(env: Env): DavStore & UploadStore {
  return env.DAV_STATE ? new RemoteDavStore(env.DAV_STATE) : sharedMemoryStore;
}

/* ------------------------------------------------------------------ */
/* Durable Object client                                               */
/* ------------------------------------------------------------------ */

const DO_NAME = 'terabox-dav-state';

export class RemoteDavStore implements DavStore, UploadStore {
  constructor(private readonly ns: DurableObjectNamespace) {}

  private stub(): DurableObjectStub {
    return this.ns.get(this.ns.idFromName(DO_NAME));
  }

  private async call<T>(route: string, body: unknown): Promise<T> {
    const res = await this.stub().fetch(`https://dav-state${route}`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`dav-state ${route}: HTTP ${res.status}`);
    return (await res.json()) as T;
  }

  checkTokens(path: string, tokens: string[]): Promise<TokenCheck> {
    return this.call<TokenCheck>('/tokens', { path, tokens });
  }

  lockAcquire(path: string, req: LockRequest): Promise<LockOutcome> {
    return this.call<LockOutcome>('/lock', { path, req });
  }

  unlock(path: string, token: string): Promise<UnlockOutcome> {
    return this.call<UnlockOutcome>('/unlock', { path, token });
  }

  describe(paths: string[]): Promise<Record<string, PathState>> {
    return this.call<Record<string, PathState>>('/describe', { paths });
  }

  propPatch(path: string, ops: PropPatchOp[]): Promise<Record<string, string>> {
    return this.call<Record<string, string>>('/patch', { path, ops });
  }

  async relocate(items: RelocateItem[]): Promise<void> {
    await this.call('/relocate', { items });
  }

  async init(session: UploadSession): Promise<void> {
    await this.call('/upload-init', { session });
  }

  get(uploadId: string): Promise<UploadSession | undefined> {
    return this.call<UploadSession | undefined>('/upload-get', { uploadId });
  }

  async recordChunk(uploadId: string, index: number, md5: string, activeHost?: string): Promise<void> {
    await this.call('/upload-chunk', { uploadId, index, md5, activeHost });
  }

  metaGeneration(bump: boolean): Promise<number> {
    return this.call<number>('/meta-gen', { bump });
  }

  async markFinalized(uploadId: string, status: number): Promise<void> {
    await this.call('/upload-finalized', { uploadId, status });
  }

  claimFinalize(uploadId: string): Promise<FinalizeClaim> {
    return this.call<FinalizeClaim>('/upload-claim', { uploadId });
  }

  async releaseFinalize(uploadId: string): Promise<void> {
    await this.call('/upload-claim-release', { uploadId });
  }

  async delete(uploadId: string): Promise<void> {
    await this.call('/upload-delete', { uploadId });
  }
}

/* ------------------------------------------------------------------ */
/* The Durable Object itself                                           */
/* ------------------------------------------------------------------ */

interface StoredShape {
  locks?: Array<[string, LockRecord[]]>;
  props?: Array<[string, Record<string, string>]>;
  uploads?: Array<[string, UploadSession]>;
  metaGen?: number;
}

/**
 * One Durable Object instance per account (by name) holding all advisory
 * WebDAV state. Requests to it are serialized by the platform, which is
 * exactly what lock semantics need — and every worker isolate in the
 * deployment talks to this same instance, so isolate scheduling becomes
 * irrelevant. Storage is write-through on every mutation (SQLite-backed
 * class; the state is a few KB at litmus scale).
 */
export class DavState extends DurableObject {
  private locks = new Map<string, LockRecord[]>();
  private props = new Map<string, Record<string, string>>();
  private uploads = new Map<string, UploadSession>();
  /** Bumped by every metadata-changing write; isolates diff it against the
   *  value their local read cache was filled under. */
  private metaGen = 0;
  private readonly ready: Promise<void>;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ready = this.load();
  }

  private async load(): Promise<void> {
    const [locks, props, uploads, metaGen] = await Promise.all([
      this.ctx.storage.get<StoredShape['locks']>('locks'),
      this.ctx.storage.get<StoredShape['props']>('props'),
      this.ctx.storage.get<StoredShape['uploads']>('uploads'),
      this.ctx.storage.get<StoredShape['metaGen']>('metaGen'),
    ]);
    this.locks = new Map(locks ?? []);
    this.props = new Map(props ?? []);
    this.uploads = new Map(uploads ?? []);
    this.metaGen = metaGen ?? 0;
  }

  private async persist(): Promise<void> {
    await this.ctx.storage.put({
      locks: [...this.locks],
      props: [...this.props],
      uploads: [...this.uploads],
      metaGen: this.metaGen,
    });
  }

  override async fetch(request: Request): Promise<Response> {
    await this.ready;
    if (request.method !== 'POST') {
      return new Response('POST only', { status: 405 });
    }
    const url = new URL(request.url);
    const body = (await request.json()) as Record<string, unknown>;
    switch (url.pathname) {
      case '/tokens': {
        const out = coreCheckTokens(this.locks, body['path'] as string, body['tokens'] as string[]);
        return Response.json(out);
      }
      case '/lock': {
        const out = coreLockAcquire(this.locks, body['path'] as string, body['req'] as LockRequest);
        if (out.ok) await this.persist();
        return Response.json(out);
      }
      case '/unlock': {
        const out = coreUnlock(this.locks, body['path'] as string, body['token'] as string);
        if (out === 'removed') await this.persist();
        return Response.json(out);
      }
      case '/describe': {
        const out = coreDescribe(this.locks, this.props, body['paths'] as string[]);
        return Response.json(out);
      }
      case '/patch': {
        const out = corePatch(this.props, body['path'] as string, body['ops'] as PropPatchOp[]);
        await this.persist();
        return Response.json(out);
      }
      case '/relocate': {
        for (const item of body['items'] as RelocateItem[]) {
          coreRelocate(this.locks, this.props, item);
        }
        await this.persist();
        return Response.json({});
      }
      case '/meta-gen': {
        if (body['bump']) {
          this.metaGen += 1;
          // Only the counter changed. persist() would serialize every lock,
          // dead prop and upload session (each with its full chunk-md5 list)
          // to storage on EVERY metadata write — O(sessions) per PUT.
          await this.ctx.storage.put('metaGen', this.metaGen);
        }
        return Response.json(this.metaGen);
      }
      case '/upload-init': {
        const session = body['session'] as UploadSession;
        // Lazy sweep: drop any expired sessions whenever a new one lands, so
        // the map stays bounded even if clients abandon uploads.
        for (const [id, existing] of this.uploads) {
          if (isExpired(existing)) this.uploads.delete(id);
        }
        this.uploads.set(session.uploadId, session);
        await this.persist();
        return Response.json({});
      }
      case '/upload-get': {
        const uploadId = body['uploadId'] as string;
        const session = this.uploads.get(uploadId);
        if (session && isExpired(session)) {
          this.uploads.delete(uploadId);
          await this.persist();
          return Response.json(null);
        }
        return Response.json(session ?? null);
      }
      case '/upload-chunk': {
        const session = this.uploads.get(body['uploadId'] as string);
        if (session) {
          session.chunkMd5s[body['index'] as number] = body['md5'] as string;
          const activeHost = body['activeHost'] as string | undefined;
          if (activeHost) session.activeHost = activeHost;
          await this.persist();
        }
        return Response.json({});
      }
      case '/upload-finalized': {
        const session = this.uploads.get(body['uploadId'] as string);
        if (session) {
          session.finalized = body['status'] as number;
          session.finalizedAt = Date.now();
          session.finalizing = undefined;
          await this.persist();
        }
        return Response.json({});
      }
      case '/upload-claim': {
        const session = this.uploads.get(body['uploadId'] as string);
        if (!session) return Response.json({ kind: 'unknown' });
        if (session.finalized !== undefined) return Response.json({ kind: 'replay', status: session.finalized });
        const now = Date.now();
        if (session.finalizing !== undefined && now - session.finalizing < FINALIZE_CLAIM_TTL_MS) {
          return Response.json({ kind: 'busy' });
        }
        // Fresh claim, or taking over a stale one (owner died mid-finalize).
        // Mutate before persist: the check and the set happen with no await
        // in between, so a second request can never interleave here.
        session.finalizing = now;
        await this.persist();
        return Response.json({ kind: 'owned' });
      }
      case '/upload-claim-release': {
        const session = this.uploads.get(body['uploadId'] as string);
        if (session && session.finalized === undefined) {
          session.finalizing = undefined;
          await this.persist();
        }
        return Response.json({});
      }
      case '/upload-delete': {
        this.uploads.delete(body['uploadId'] as string);
        await this.persist();
        return Response.json({});
      }
      default:
        return new Response('unknown route', { status: 404 });
    }
  }
}
