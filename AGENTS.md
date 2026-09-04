# 9Router — Agent Instructions

Quick-reference for agents working in this repo. **Read `CLAUDE.md` for full context**, then consult the per-directory AGENTS.md files before editing their areas.

## Setup

```bash
cp .env.example .env            # override JWT_SECRET, INITIAL_PASSWORD, etc.
bun install
PORT=20128 bun run dev          # dev server (next dev, port 20127)
```

**Package handling (this repo):**
- **JS is managed with bun** (`bun install`, lockfile `bun.lock`). Gitbook docs and the test suite each keep their own `bun.lock`. Docker/CI intentionally still use npm — don't touch those.
- **The server runtimes that matter are Node** (`bun run dev`/`build`/`start` all execute next via node). The `dev:bun`/`build:bun`/`start:bun` scripts run Next under the Bun runtime for experimentation.
- **Headroom's Python tooling is managed with uv** — `uv tool install headroom-ai[proxy]`, probed via `uv tool list --show-paths`, with pip (`python3 -m pip install`) as the fallback when uv is absent. See `src/lib/headroom/detect.js` `pkgManager()`.

**Default runtime port is 20128** (dashboard at `/dashboard`, API at `/v1`). Set `PORT` and `NEXT_PUBLIC_BASE_URL` env vars explicitly.

## Running tests

Tests live in `tests/`, an **independent ESM package** — not wired into root scripts:

```bash
bun install                    # root deps first (tests import from src/)
cd tests && bun install        # vitest + its deps → tests/node_modules
bunx vitest run                # all tests
bunx vitest run unit/capabilities.test.js   # single file
```

**The suite is NOT all-green on checkout.** ~938 pass, ~64 expected failures. Judge regressions with:

```bash
node tests/__baseline__/verify-no-regression.mjs <results.json>
```

Never treat the raw test run as authoritative — use `tests/__baseline__/known-fails.txt` as the baseline.

### Translator tests

Always use the vitest config at `tests/vitest.config.js`:

```bash
bunx vitest run --config tests/vitest.config.js "tests/translator/"
```

**Critical**: every translator test that calls `translateRequest`/`translateResponse` **must** `import "./registerAll.js"` at the top. Without it, `require()` silently no-ops in ESM and tests falsely pass (empty registry). See `tests/translator/AGENTS.md`.

Real-provider tests (`tests/translator/real/`) need credentials and `RUN_REAL=1`. Skip them.

## Build & deploy

```bash
bun run build                  # next build --webpack + postbuild (copy-standalone-assets.mjs)
PORT=20128 HOSTNAME=0.0.0.0 bun run start  # production via custom-server.js
```

**`postbuild` runs `copy-standalone-assets.mjs`** — it copies `static/`, `public/`, and `custom-server.js` beside `server.js` in the standalone output. Without it the standalone build serves unsanitized requests.

For CLI bundling from root: `NEXT_TRACING_ROOT_MODE=workspace bun run build` (tracing root moves up to include hoisted `node_modules`).

Docker: `docker build -t 9router .` then `docker run -p 20128:20128 -v $HOME/.9router:/app/data -e DATA_DIR=/app/data 9router`. Publish is CI-triggered on `v*` tags (`docker-publish.yml`).

## Architecture boundaries

- **`src/sse/`** — app-side request glue; **`open-sse/`** — provider-agnostic engine (also usable standalone). Cross this boundary consciously.
- **`src/app/api/v1/*`** → `src/sse/handlers/chat.js` → `open-sse/handlers/chatCore.js` → `open-sse/executors/*` → `open-sse/translator/*` → SSE back.
- **`open-sse/` has its own `AGENTS.md`** — read it before editing anything under `open-sse/`.
- **`tests/translator/` has its own `AGENTS.md`** — read it before editing translator tests.

## Key gotchas

- **`better-sqlite3` is in `optionalDependencies`** — install never fails without build tools. `sql.js` (pure-JS) is the always-works fallback. Don't assume native SQLite is available.
- **`custom-server.js`** derives client IP from the TCP socket and strips `X-Forwarded-For`. Preserve this — trust forwarding headers only from a loopback reverse proxy.
- **`open` must stay external** in `next.config.mjs` `serverExternalPackages` — it derives `import.meta.url` at build time; a hardcoded path breaks on other OSes.
- **`src/lib/localDb.js`** is a backward-compat shim re-exporting `src/lib/db/index.js`. New code imports from `@/lib/db/index.js`. DB file resolves via `src/lib/db/paths.js` (`DATA_DIR`, else `~/.9router/`). Usage/logs still live under `~/.9router` independently.
- **`docs/*` is gitignored except `docs/ARCHITECTURE.md`** — don't expect other docs files to be tracked.
- **`open-sse.old/`** is a refactor backup (gitignored). Don't edit it.
- **Provider registry `index.js` is auto-generated** — regenerate with `scripts/migrate-registry.mjs` or `scripts/injectDisplayToRegistry.mjs`, don't hand-edit.

## Commit style

Conventional Commits (`fix(translator): …`, `feat(...)`). Root (`9router-app`) and `cli/` are versioned independently — changes logged in `CHANGELOG.md`.
