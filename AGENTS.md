# AGENTS.md — terabox-webdav-worker

## Standing rules

- **After every `git push` and every `npx wrangler deploy`: run the live smoke
  and do not consider the change done until it passes:**

  ```sh
  ./scripts/live-smoke.sh
  ```

  It must print `LIVE SMOKE: … passed, 0 failed`. A push that is not followed
  by a passing live smoke is an incomplete push.

- **Gate before every deploy:**

  ```sh
  npm run review   # tsc --noEmit + vitest + wrangler dry-run
  ```

- **Commit style:** `type: lowercase-summary` (e.g. `fix: review round N — …`).
  Commit only when explicitly asked; never push without the request.

- **Review rounds:** second-opinion subagent reviews are research-only.
  Every finding must be tagged REAL / STALE / HYPOTHETICAL, and every fixed
  finding gets a revert-verified pin (backup src+test, surgical revert, pin
  must fail, restore).

- **Free-tier quota discipline (learned the hard way, 2026-10-11):**
  - `500 {"error":"Internal Server Error"}` on EVERY path with wrangler tail
    showing `Exceeded allowed rows written in Durable Objects free tier`
    means the daily quota died — it resets at **00:00 UTC**, not on retry.
    One probe confirms it; never loop probes or re-runs against a dead
    worker. While it is dead: work locally (`npm run review`, docs, review
    rounds) and push; run the deferred live smoke once after the reset.
  - **litmus is quota-heavy** (locks/props/upload DO writes): a full 138-test
    run has exhausted the rows-written quota within a minute. Run it at most
    **once per quota window**, only after smoke is green. Use
    `./scripts/live-litmus.sh` (correct `/dav/litmus/` base, pre-flight probe
    that aborts instead of hammering a dead worker).
  - The live smoke stays the standing post-push rule, but when the quota is
    dead the smoke is *deferred, not skipped*: record it, verify at reset.

## Environment

- Node is not on the default PATH: `export PATH="$HOME/.local/node/bin:$PATH"`
- Live worker: `https://davbox.crazy-gooner-mf.workers.dev/`, base `/dav/`.
- Tests: `npx vitest run` (projects: dav, mount, mount-utf8, auth, davstate).
  The `davstate` project binds the `DAV_STATE` Durable Object; `mount*`
  projects set `PATH` bindings.
