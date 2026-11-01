# 9Router — Agent Instructions

Quick-reference for agents working in this repo. **Read `CLAUDE.md` for full context**, then consult the per-directory AGENTS.md files before editing their areas.

## Setup

```bash
cp .env.example .env            # override JWT_SECRET, INITIAL_PASSWORD, etc.
bun install
PORT=20128 bun run dev          # dev server (next dev, port 20127)
```

**Package handling (this repo):**
- **JS is managed with bun everywhere** — root, `gitbook/`, and `tests/` each keep their own `bun.lock`. `bunfig.toml` sets `[install] frozenLockfile = true`, `.bun-version` pins `1.4.2`, and all three `package.json` files carry `packageManager: bun@1.4.2`. Add a dep with `bun add <pkg>` (that's what updates the lockfile); a bare `bun install` fails loudly if `bun.lock` drifts.
- **Docker and CI install with `bun install --frozen-lockfile`** — npm is gone from every build path. CI pins bun via `oven-sh/setup-bun@v2` and node via `actions/setup-node@v6`.
- **The server runtime is Node** (`bun run dev`/`build`/`start` execute next/custom-server via node; `Dockerfile` builds with `oven/bun` but runs `node custom-server.js` in `node:24-alpine`). The `dev:bun`/`build:bun`/`start:bun` scripts run Next under the Bun runtime for experimentation.
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

**The suite is NOT all-green on checkout.** ~2190 tests, ~114 expected failures (see `tests/__baseline__/known-fails.txt`). Judge regressions with a JSON-reporter run + the gate:

```bash
cd tests
bunx vitest run --reporter=json --outputFile=results.json
node ../tests/__baseline__/verify-no-regression.mjs results.json   # from repo root
```

Never treat the raw test run as authoritative — use `tests/__baseline__/known-fails.txt` as the baseline. CI runs exactly this in `.github/workflows/test.yml`.

### Translator tests

Always use the vitest config at `tests/vitest.config.js`:

```bash
bunx vitest run --config tests/vitest.config.js "tests/translator/"
```

**Critical**: every translator test that calls `translateRequest`/`translateResponse` **must** `import "./registerAll.js"` at the top. Without it, `require()` silently no-ops in ESM and tests falsely pass (empty registry). See `tests/translator/AGENTS.md`.

Real-provider tests (`tests/translator/real/`) need credentials and `RUN_REAL=1`. Skip them.

## Build & deploy

```bash
bun run build                  # next build --turbopack + postbuild (copy-standalone-assets.mjs)
PORT=20128 HOSTNAME=0.0.0.0 bun run start  # production via custom-server.js
```

**`postbuild` runs `copy-standalone-assets.mjs`** — it copies `static/`, `public/`, and `custom-server.js` beside `server.js` in the standalone output. Without it the standalone build serves unsanitized requests.

For CLI bundling from root: `NEXT_TRACING_ROOT_MODE=workspace bun run build` (tracing root moves up to include hoisted `node_modules`).

Docker: `docker build -t 9router .` then `docker run -p 20128:20128 -v $HOME/.9router:/app/data -e DATA_DIR=/app/data 9router`. The image is multi-stage: `oven/bun:1.4.2-alpine` installs (`bun install --frozen-lockfile`) and builds, `node:24-alpine` runs `custom-server.js`. Publish is CI-triggered on `v*` tags (`docker-publish.yml`).

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

## Context & Dependency Source

### Repomix Pack

A compressed repo pack is generated via `repomix` (config: `repomix.config.json`, output: `9router.context.xml`).

```bash
# Generate pack (after significant changes)
repomix

# Check token count per file
repomix --token-count-tree 50
```

### OpenSrc — Dependency Source

Read dependency implementations, not just types. Cache lives at `~/.opensrc/`.

```bash
# Get source path (auto-fetches on cache miss)
cat $(opensrc path express)/src/express.js

# Pre-fetch multiple deps
opensrc fetch express jose bcryptjs http-proxy-middleware marked @node-saml/node-saml

# Search inside cached source
rg "createServer" $(opensrc path express)
```

**Currently cached for this project:** express, jose, bcryptjs, http-proxy-middleware, marked, @node-saml/node-saml.

See `opensrc list` for full cache status.

## Post-Commit Hook

The repomix pack regenerates automatically on every successful commit. To wire it up:

```bash
# One-time setup
cat > .git/hooks/post-commit << 'HOOK'
#!/bin/bash
# Regenerate repomix pack on commit
repomix --quiet 2>/dev/null && echo "✅ 9router.context.xml regenerated"
HOOK
chmod +x .git/hooks/post-commit
```

## Commit style

Conventional Commits (`fix(translator): …`, `feat(...)`). Root (`9router-app`) and `cli/` are versioned independently — changes logged in `CHANGELOG.md`.
