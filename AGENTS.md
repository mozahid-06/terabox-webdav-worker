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

## Environment

- Node is not on the default PATH: `export PATH="$HOME/.local/node/bin:$PATH"`
- Live worker: `https://terabox.taxin-404.workers.dev/`, base `/dav/`.
- Tests: `npx vitest run` (projects: dav, mount, mount-utf8, auth, davstate).
  The `davstate` project binds the `DAV_STATE` Durable Object; `mount*`
  projects set `PATH` bindings.
