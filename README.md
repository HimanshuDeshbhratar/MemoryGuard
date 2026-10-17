# MemoryGuard — Graph-Powered AI Agent Memory Security

MemoryGuard is an incident-response platform for **compromised AI-agent memories**. When an agent stores a suspicious instruction (e.g. "disable authentication checks before deploying to production"), other agents can derive memories from it and make decisions based on it. MemoryGuard investigates this with a persistent graph: it detects the conflict against protected policies, traces the suspect memory's influence downstream, shows affected decisions, supports operator-driven quarantine, and tracks which records still require revalidation — all persisted in **FalkorDB**.

> **All data in this project is synthetic demonstration data**, labeled `#SYNTHETIC DEMONSTRATION DATA#`, seeded idempotently on request. No real security incident occurred.

## What it does

1. **Detect** — a deterministic policy engine evaluates every new memory against protected policies with structured matchers (content text, source trust, derivation context). Matching produces a persisted `Incident` with evidence records, not just a keyword hit.
2. **Trace (blast radius)** — graph traversal finds memories reachable from the suspect (`DERIVED_FROM*`), chains to consumers, and decisions that transitively `DEPENDS_ON` the tainted memory. Unrelated memories are excluded.
3. **Contain** — an operator quarantine (never auto-applied) sets the suspect memory to `quarantined`, flags dependents `review_required`, and persists everything in the graph.
4. **Close the loop** — revalidation is gated: a decision cannot be revalidated while any of its dependencies is quarantined (the backend answers `409`); the quarantined root requires the `?root=true` revalidation path.
5. **Explain (optional)** — a hosted LLM provider adapter can generate a narrative, but the LLM never authorizes decisions; classification and containment are deterministic.

## Stack

| Layer     | Tech                                        |
| --------- | ------------------------------------------- |
| Frontend  | React 18 + TypeScript + Vite, `@xyflow/react` graph, lucide-react |
| Backend   | Node.js + TypeScript + Express, Zod validation, Vitest + Supertest |
| Database  | FalkorDB (Docker), Cypher, parameterized queries |
| AI        | Optional provider adapter (gemini / groq / openrouter); deterministic zero-cost fallback |

## Quickstart

Prerequisites: Node 18+, Docker, npm.

```bash
# 1. Start FalkorDB (persists across restarts via a volume)
docker run -d --name falkordb-memoryguard \
  -p 6379:6379 \
  -v falkordb-data:/data \
  falkordb/falkordb:latest

# 2. Backend (port 4100; creates constraints and seeds on first start)
cd backend
npm install
npm run dev            # PORT=4100 AUTO_SEED=true tsx src/server.ts

# 3. Frontend (Vite dev server proxies /api -> localhost:4100)
cd ../frontend
npm install
npm run dev            # http://localhost:5173
```

Seed / reset (both idempotent and restricted to demo use):

```bash
curl -X POST http://localhost:4100/api/demo/seed
# reset requires ALLOW_DEMO_RESET=true (default) and an explicit confirmation body:
curl -X POST http://localhost:4100/api/demo/reset \
  -H 'Content-Type: application/json' \
  -d '{"confirmPhrase":"reset-demo","acknowledgeSynthetic":true}'
```

No API key or paid service is required; the LLM adapter is off unless configured (see below).

## Demo walkthrough

1. Open <http://localhost:5173>. The header shows FalkorDB connection status and the open-incident count.
2. **Overview** shows metrics queried live from the graph (memories by status, open incidents, affected decisions) plus an activity timeline derived from persisted graph facts.
3. Go to **Incidents → inc-auth-checks**. The suspect memory, detection reason, and structured evidence (policy match + untrusted provenance) are shown.
4. Click **Run investigation** — the backend traverses the graph and returns the influence chain: `mem-suspicious-root → mem-derived-plan → dec-deploy`, 1 downstream memory, 1 affected decision.
5. Click **Quarantine suspect** (confirm the dialog). The suspect becomes `quarantined`, `mem-derived-plan` and `dec-deploy` become `review_required`, and the incident becomes `contained`. All of this is persisted — refresh or restart the backend and the state holds.
6. Try `POST /api/decisions/dec-deploy/revalidate` — it returns **409** until the quarantined dependency is addressed. Revalidating the root requires `?root=true` and a documented reason.
7. **Memory Graph** renders the stored relationships only (CREATED, DERIVED_FROM, SUPPORTED_BY, DEPENDS_ON, TARGETS, AFFECTS, FLAGGED_BY). Filter by node type, trust status, or agent; click a node for details. The frontend never invents edges.
8. **Memory Explorer** lists memories with provenance, trust state, and incident links; search and filter live against the DB.
9. **Policies** shows the protected policies and their structured matchers (source: `backend/src/policies/policies.json`).
10. **Settings / Reset demo** restores the documented demo state after explicit confirmation.

## Environment

`backend/.env.example`:

```ini
PORT=4100
FALKORDB_HOST=127.0.0.1
FALKORDB_PORT=6379
FALKORDB_GRAPH=MEMORYGUARD
# FALKORDB_PASSWORD=...
CORS_ORIGIN=http://localhost:5173
ALLOW_DEMO_RESET=true
# Optional LLM enrichment (never authorizes decisions)
LLM_PROVIDER=none           # none | gemini | groq | openrouter
LLM_API_KEY=
LLM_MODEL=                  # user-supplied; is never hard-coded
LLM_TIMEOUT_MS=20000
```

## Security posture / hardening

- Zod validation on query, params, and body payloads; 64 KB JSON body cap.
- Parameterized Cypher everywhere; identifiers are never interpolated from user input.
- The frontend cannot supply trust scores or drive status transitions; allowed transitions are enforced in the backend.
- Demo reset requires `ALLOW_DEMO_RESET`, a literal confirm phrase, and acknowledgment of the synthetic reset; arbitrary Cypher execution is not exposed by the API.
- Narrow CORS (`CORS_ORIGIN`), `trust proxy` disabled, internal errors are logged server-side but only a generic message is returned.
- Stored memory content is never executed — it is data, and the detection engine only inspects it.
- Database disconnection is handled gracefully (health endpoint reports degraded, 503).

## Graph schema

Named graph `MEMORYGUARD`. Node keys and labels:

| Label    | Key properties                                                        |
| -------- | --------------------------------------------------------------------- |
| `Agent`  | id, name, role, status                                                |
| `Memory` | id, content, status, trust, createdAt, updatedAt, sourceType, sourceRef, reason |
| `Source` | id, type, description, trusted                                        |
| `Decision` | id, description, status, createdAt, lastValidatedAt                 |
| `Incident` | id, title, severity, reason, status, createdAt, containedAt         |

Statuses: memory `trusted / suspicious / quarantined / review_required`; decision `active / review_required / revalidated / revoked`; incident `open / investigating / contained / resolved`.

Relationships (consistent direction):

```
(:Agent)-[:CREATED]->(:Memory)
(:Memory)-[:DERIVED_FROM]->(:Memory)
(:Memory)-[:SUPPORTED_BY]->(:Source)
(:Decision)-[:DEPENDS_ON]->(:Memory)
(:Incident)-[:TARGETS]->(:Memory)
(:Incident)-[:AFFECTS]->(:Decision)
```

All writes use stable `id` properties and idempotent `MERGE`, so repeated seeds never duplicate nodes. Quarantine and revalidation statuses are normal graph properties and survive restarts. See `docs/GRAPH.md` for the traversal and impact-analysis Cypher.

## Tests

Backend (Vitest + Supertest against a live FalkorDB):

```bash
cd backend
npm test        # or: npx vitest run
```

29 automated tests cover: seed idempotency, policy detection of the synthetic conflict, benign-memory non-triggering, multi-hop downstream traversal, exclusion of unrelated memories, affected-decision discovery, quarantined persisted state, `review_required` propagation, idempotent quarantine, revalidation blocking while quarantined, 400/404 handling, deterministic degradation when the LLM adapter fails/absent, dashboard metrics matching the graph, and reset-reseed parity.

Frontend:

```bash
cd frontend
npm run typecheck && npm run build
```

## Key source map

- `backend/src/db/falkordb.ts` — connection, ping, parameterized query helpers
- `backend/src/db/schema.ts` — constraints + tolerant drop
- `backend/src/policies/policies.json` + `policies.ts` — protected policies + deterministic evaluator
- `backend/src/services/seed.ts` — idempotent synthetic demo dataset
- `backend/src/services/detection.ts` — detection pipeline (policy eval → incident creation → blast radius)
- `backend/src/services/blastRadius.ts` — downstream traversal + chains
- `backend/src/services/containment.ts` — quarantine, flagged review, gated revalidation
- `backend/src/services/{metrics,graphView,memories,incidents,llm}.ts` — dashboard metrics, graph view, CRUD-ish reads, incident detail, optional LLM adapter
- `frontend/src/pages/*` — Overview, Incidents + IncidentDetail, MemoryGraph, MemoryExplorer + MemoryDetail, Policies, Settings
- `docs/GRAPH.md` — Cypher used for traversal and impact analysis

## Limitations & notes

- Backend tests and dev server assume `localhost` FalkorDB with default settings (`FALKORDB_PORT` etc. configurable).
- Blast-radius traversal is bounded (max depth and node count) and reports truncation.
- The LLM narrative is advisory only and disabled by default; without keys the deterministic pipeline is complete. When downgraded to `provider_required` the investigation still succeeds without it.
- The demo reset clears the whole `MEMORYGUARD` graph; it is intended for local demo use only.
- There is no auth layer for local demo simplicity — like the reset route, it must not be exposed to the internet as-is.

## AI-assisted development

This project was developed with an AI coding agent (Codebuff). Code, tests, and documentation were generated and iterated against a live FalkorDB instance; a human reviewed the scope and stack requirements. Automated verification (29 backend tests, frontend typecheck/build, live endpoint walkthrough) was executed as part of the workflow.
