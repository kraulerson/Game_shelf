# Game_shelf ↔ Orchestrator Cache Integration (F14–F17) — Design

**Status:** Approved (design) — 2026-06-17
**Repo:** `kraulerson/Game_shelf` (this repo)
**Features:** F14–F17 (promoted to MVP by OQ1 in lancache_orchestrator's `PRODUCT_MANIFESTO.md` §5)
**Counterpart:** `lancache_orchestrator` (F1–F13 complete) — the orchestrator API this consumes.

---

## 1. Goal

Surface the lancache orchestrator's cache state inside Game_shelf and let the
operator drive it from the UI: a **cache badge** on every game, a **cache panel**
on the game detail page, and a **cache dashboard** — all backed by a server-side
**proxy** so the orchestrator's bearer token never reaches the browser, and all
**degrading gracefully** when either side is offline. This is the final MVP block.

## 2. Topology & transport (decided)

- **Game_shelf** runs in Proxmox **LXC 1102 @ 10.100.23.102** (Express backend + React/Vite frontend, nginx).
- **Orchestrator** is dockerized on the **lancache host @ 192.168.1.40**, API on `:8765`, currently loopback-bound + bearer-auth.
- **Cross-host access:** the orchestrator binds the LAN interface so 10.100.23.102 can reach `http://192.168.1.40:8765`. **Hardening (required):**
  - A **host firewall allowlist** on the lancache box permits `:8765` only from `10.100.23.102`.
  - The orchestrator's `/api/v1/platforms/{name}/auth` already requires a `127.0.0.1` origin → cross-host auth is rejected automatically (and F14 doesn't proxy auth anyway).
  - **Residual risk (accepted, documented):** the bearer token travels **cleartext HTTP** between hosts — acceptable on a trusted, segmented home LAN. **TLS via Caddy** (reverse-proxy on the lancache host, orchestrator stays loopback) is a drop-in upgrade later, requiring only an `ORCH_API_URL` change.
- **Orchestrator-side change (separate, in lancache_orchestrator):** bind the API to the LAN interface (an `ORCH_API_HOST` deploy setting) + the firewall rule. Tracked there; not part of this repo's plans.

## 3. Architecture

- **Backend proxy (F14):** `backend/src/routes/cache.js` + a thin axios client `backend/src/services/orchestrator.js`. `ORCH_API_URL` + `ORCH_TOKEN` come from the **backend** env (boot-validated like the existing required vars in `server.js`). Mounted behind Game_shelf's existing auth middleware.
- **Frontend (F15/F16):** React + `@tanstack/react-query` (existing convention) calling **only** `/api/cache/*` on its own backend; `lucide-react` icons; Tailwind. New `pages/Cache.jsx` + a route; badge/panel components under `frontend/src/components/cache/`.
- **The token never leaves the backend** — the React bundle has no knowledge of `ORCH_TOKEN`; F17 enforces this with a CI grep.

## 4. F14 — Backend proxy routes

`app.use('/api/cache', requireAuth, cacheRouter)` — only authenticated Game_shelf users reach it.

**Orchestrator client** (`services/orchestrator.js`): an axios instance, `baseURL = ORCH_API_URL`, `Authorization: Bearer ${ORCH_TOKEN}`, a short timeout (e.g. 5 s), and a single `callOrchestrator()` helper that centralizes error translation.

**Proxied endpoints** (`/api/cache/*` → orchestrator `/api/v1/*`):

| Game_shelf route | Orchestrator | Notes |
|---|---|---|
| `GET /api/cache/games` | `GET /games` | paginated; the proxy pages through to the full set for bulk badge correlation |
| `GET /api/cache/jobs` | `GET /jobs` | dashboard recent-jobs |
| `GET /api/cache/platforms` | `GET /platforms` | auth_status per platform |
| `GET /api/cache/health` | `GET /health` | + version-skew field (F17) |
| `GET/POST/DELETE /api/cache/block-list` | `…/block-list` | dashboard block-list mgmt |
| `POST /api/cache/games/:id/prefill` | `POST /games/:id/prefill` | trigger |
| `POST /api/cache/games/:id/validate` | `POST /games/:id/validate` | trigger |
| `POST /api/cache/games/:id/manifest/fetch` | `POST /games/:id/manifest/fetch` | trigger |
| `POST /api/cache/platforms/:name/library/sync` | `POST /platforms/:name/library/sync` | trigger |

**NOT proxied:** `POST /platforms/{name}/auth` (OQ2) — auth stays on the orchestrator host (operator uses `orchestrator-cli` there; the dashboard shows a copy-pasteable reconnect command instead).

**Error mapping** (one place, in `callOrchestrator()`):
- orchestrator **401** → Game_shelf **502** (misconfigured token — an operator problem, not the user's).
- `ECONNREFUSED` / `ETIMEDOUT` / abort → **503** `{ "status": "orchestrator_offline" }`.
- other non-2xx → passthrough status + body (e.g. a 404 game, a 400 bad trigger).

## 5. F15 — Cache badge + panel + correlation

**Correlation (the join).** Game_shelf `launcher.name` → orchestrator `platform` (`steam`→`steam`, `epic`→`epic`; others untracked). Match Game_shelf `game_editions.launcher_game_id` ↔ orchestrator `games.app_id` for that platform. The proxy bulk-fetches `/api/cache/games` **once** and builds a `Map` keyed `` `${platform}:${app_id}` `` → `{ status, blocked, … }` (no N+1). The exact Epic key (`launcher_game_id` vs `epic_catalog_id`) is confirmed against live data during F15 implementation; `launcher_game_id` is the primary candidate.

**Per-game state.** A Game_shelf `games` row aggregates editions across launchers. The **library card badge shows the game's primary edition's** cache state:
- **Primary edition** = the edition flagged `edition_tiers.is_display_edition = 1` (Game_shelf's existing "display edition" concept).
- **Fallback** when no display edition is set (or it's an untracked launcher): highest by **launcher priority** (`launchers.priority`; Steam → Epic → GOG) then **edition tier** (`edition_tiers.tier`; GOTY → special → standard).
- If the primary edition is on an **untracked launcher** (GOG/other), the card badge is **"not tracked"** (`—`).

**Badge-state mapping** (pure function, `frontend/src/utils/cacheBadge.js`, unit-tested). Colorblind-safe: **icon + text always**, never color alone (Intake §9). `blocked` overlays any status.

| Orchestrator state | lucide icon | color | label |
|---|---|---|---|
| `up_to_date` | `CheckCircle` | green | Cached |
| `downloading` | `Download` | blue | Downloading |
| `pending_update` | `ArrowUpCircle` | amber | Update ready |
| `not_downloaded` | `Circle` | gray | Not cached |
| `validation_failed` | `AlertTriangle` | red | Check failed |
| `failed` | `XCircle` | red | Failed |
| `unknown` | `HelpCircle` | gray | Unknown |
| `blocked` (flag) | `Ban` | slate | Blocked |
| untracked launcher | `Minus` | gray | — |
| orchestrator offline | `CloudOff` | gray | — |

**Components:**
- `components/cache/CacheBadge.jsx` — renders the mapping for one state; used on library cards (the primary edition) and inline.
- `components/cache/CachePanel.jsx` — on **GameDetail**, lists **every** tracked edition as a row (platform, status badge, a **Block** toggle, **Prefill**/**Validate** buttons). Mutations call the `/api/cache` POST/DELETE endpoints (react-query `useMutation`, optimistic-but-reconciled).
- `hooks/useCacheStatus.js` — a react-query hook that bulk-fetches once for the library view and exposes the keyed map; a per-game selector derives the primary-edition badge.

## 6. F16 — Cache Dashboard (`frontend/src/pages/Cache.jsx` + route)

Independently-fetched, **error-isolated** sections (one section failing doesn't blank the page):
1. **Stats** — counts by status (derived from the bulk `/games`), e.g. cached / needs-update / failed / blocked totals.
2. **Platform auth cards** — per platform: `auth_status` + `last_sync_at`; when expired/never, a **copy-pasteable reconnect command** (e.g. `orchestrator-cli auth steam`) since auth isn't proxied.
3. **Recent 25 jobs** — from `/jobs` (kind, state, game, timestamps).
4. **Block-list management** — list + add/remove via `/block-list`; designed for **≥500 entries without pagination** (a simple windowed/virtualized list; client-side filter).

**Degraded:** orchestrator offline → a full-page banner + skeleton sections; each section also handles its own fetch error in isolation.

## 7. F17 — Graceful degradation + security

- **Health + version skew:** `GET /api/cache/health` returns the orchestrator's `/health` body plus a `version` field; the UI compares it to a known-good range to warn on **schema skew**. **One check per page load** (react-query `staleTime` long, no polling) + a manual **Retry** button — **no retry storms**.
- **Bidirectional degradation:**
  - **Game_shelf down →** the orchestrator is unaffected (it's an independent service; this is its existing posture).
  - **Orchestrator down →** Game_shelf's **library stays fully functional**; cache badges render neutral `—`, cache mutations are disabled, and the dashboard shows the offline banner. **Tolerant field merging** — a games response missing the new `blocked` field (schema skew) must not crash the badge; unknown statuses fall through to "Unknown".
- **Token-never-in-frontend invariant (CI-enforced):** a test/CI step greps the built frontend bundle **and** `frontend/src` for `ORCH_TOKEN` / the token value and **fails** if found. The token exists only in the backend env.
- **Deploy hardening:** orchestrator LAN-bind + host firewall allowlist (§2); auth endpoints stay loopback-origin-gated; cleartext-token residual risk documented.

## 8. Testing strategy

- **Backend** (`backend/tests/**`, existing `node --test`): proxy route tests with the orchestrator axios call **stubbed** — token injection (Authorization header set, never in a response to the client), error mapping (401→502, ECONNREFUSED/timeout→503 `orchestrator_offline`, passthrough), the `/games` paging-to-full-set, and `requireAuth` gating.
- **Frontend** (**new: `vitest` + React Testing Library**): the pure `cacheBadge` mapping (every state incl. blocked/offline/untracked), the primary-edition selector (display-edition + launcher/tier fallback), `CacheBadge`/`CachePanel`/`useCacheStatus` (offline → neutral, mutations disabled), the dashboard sections' error isolation.
- **Token-grep test:** part of F17, runs against `frontend/dist` + `frontend/src`.

## 9. Decomposition & build order

One spec (this) → **four implementation plans**, each its own TDD cycle:
1. **F14 — Backend proxy** (orchestrator client + `/api/cache/*` + error mapping + auth gating). Foundation.
2. **F15 — Badge + panel** (correlation, badge mapping, library card + GameDetail panel; adds vitest).
3. **F16 — Cache dashboard** (the four sections).
4. **F17 — Graceful degradation + security** (health/version skew, offline states woven through, token-grep CI, deploy hardening doc). Largely hardening of F14–F16.

## 10. Known limitations / out of scope

- **GOG is untracked** — the orchestrator is Steam+Epic only; GOG editions show "not tracked".
- **Auth is not proxied** — reconnecting an expired platform is done via `orchestrator-cli` on the lancache host (the dashboard shows the command). A future authenticated-from-UI flow is out of scope (OQ2).
- **Cleartext token over LAN** until TLS-via-Caddy is added (a drop-in `ORCH_API_URL` change).
- **Epic correlation key** confirmed against live data during F15 (likely `launcher_game_id`).

## 11. File-level change map (for planning)

- `backend/src/services/orchestrator.js` — **new** axios client + `callOrchestrator()` error mapping.
- `backend/src/routes/cache.js` — **new** `/api/cache/*` router.
- `backend/src/server.js` — register the router + add `ORCH_API_URL`/`ORCH_TOKEN` to boot env validation.
- `backend/tests/routes/cache.test.js` — **new** proxy tests.
- `frontend/src/utils/cacheBadge.js` — **new** pure badge mapping + primary-edition selector.
- `frontend/src/hooks/useCacheStatus.js` — **new** react-query bulk-fetch + keyed map.
- `frontend/src/components/cache/{CacheBadge,CachePanel}.jsx` — **new**.
- `frontend/src/pages/Cache.jsx` + the router — **new** dashboard.
- Library card + GameDetail page — render the badge / panel.
- `frontend/package.json` + `vitest.config.js` — add vitest + RTL.
- `.env.example` — `ORCH_API_URL`, `ORCH_TOKEN`.
- CI / a test — the token-grep invariant.
