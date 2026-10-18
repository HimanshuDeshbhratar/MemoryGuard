# MemoryGuard — Graph-Powered AI Agent Memory Security

> **All data in this project is synthetic demonstration data** (labeled `#SYNTHETIC DEMONSTRATION DATA#`) and is seeded idempotently on request. No real security incident, credential, deployment, or customer system is represented.

MemoryGuard is an incident-response platform for **compromised AI-agent memory**. When an agent stores a suspicious instruction (e.g. *"disable authentication checks before deploying to production"*), other agents can derive memories from it and make decisions based on it. MemoryGuard investigates this with a **persistent FalkorDB graph**: it detects the conflict against protected policies, traces the suspect memory's influence downstream, shows the affected decisions, supports **operator-confirmed** quarantine, propagates `review_required`, and blocks revalidation while a quarantined dependency remains — all persisted in the graph.

Built for the **FalkorDB Graph Hacks 2026** hackathon. Submission material: [`docs/HACKATHON_SUBMISSION.md`](docs/HACKATHON_SUBMISSION.md).

---

## 1. Problem

Agent frameworks increasingly persist long-lived "memory" that later agents read and act on. This creates a new failure mode: a single poisoned or careless memory **propagates** — it is derived from, summarized, cited, and eventually consumed by a decision or an action — long after the original write. Keyword filters miss it because the *derived* memory often looks benign on its own; the danger lives in the **relationships**.

MemoryGuard treats memory integrity as a **graph provenance** problem instead of a text-filtering problem.

## 2. Target users

- **AI platform / agent-infra engineers** responsible for a multi-agent or retrieval-augmented system with persistent memory.
- **Security operations and incident responders** who need to trace, contain, and audit contamination that has already spread across records.
- **Hackathon judges and reviewers** evaluating a focused, reproducible graph-native security demo.

## 3. Key features & end-to-end workflow

1. **Detect** — a deterministic policy engine (`backend/src/policies/`) evaluates every new memory against structured matchers (content text, source type, source trust), plus `unless` guards that suppress false positives. A confirmed match persists an `Incident` with structured evidence — never just a keyword hit.
2. **Trace (blast radius)** — bounded graph traversal finds memories reachable from the suspect (`DERIVED_FROM*`), then decisions that transitively `DEPENDS_ON` the tainted memory. Unrelated memories are excluded because the traversal is the only source of edges.
3. **Contain** — an **operator-confirmed** quarantine (never automatic) marks the suspect memory `quarantined`, flags dependent memories and decisions `review_required`, links them with `FLAGGED_BY`, sets the incident `contained`, and writes an `AuditEvent`.
4. **Close the loop** — revalidation is **gated**: a decision cannot be revalidated while any dependency (direct `DEPENDS_ON` or any transitive `DERIVED_FROM` ancestor) is quarantined or under review → the backend answers **HTTP 409**. The quarantined root needs the explicit `?root=true` path.
5. **Explain (optional)** — a hosted-LLM adapter can produce a narrative, but **the LLM never authorizes a security decision**. Classification and containment are deterministic; with no key configured the deterministic explanation is returned.

The whole pipeline is reproducible against a live FalkorDB instance with the synthetic `inc-auth-checks` dataset (see §7).

## 4. Architecture

```
React 18 + Vite (port 5173)
   │  /api/*  (dev proxy)
   ▼
Express + TypeScript API (port 4000)  ──  Zod validation, deterministic policy engine
   │  parameterized Cypher
   ▼
FalkorDB (port 6379, docker compose)   ──  persistent graph: memories, provenance,
                                            incidents, containment state, audit trail
```

| Layer     | Technology |
| --------- | ---------- |
| Frontend  | React 18, TypeScript, Vite 5, `@xyflow/react` graph, lucide-react |
| Backend   | Node.js, TypeScript, Express 4, Zod validation, Vitest + Supertest |
| Database  | FalkorDB (Docker), Cypher, parameterized queries, idempotent `MERGE` |
| AI (opt.) | Provider adapter (gemini / groq / openrouter); deterministic zero-cost fallback |
| CI        | GitHub Actions (backend typecheck + tests + benchmark against a FalkorDB service; frontend typecheck + build) |

Frontend pages: **Overview**, **Incidents** + **Incident detail**, **Memory Graph**, **Memory Explorer** + **Memory detail**, **Policies**, **Settings**.

## 5. Graph schema

Named graph `MEMORYGUARD`. Node labels and key properties:

| Label       | Key properties |
| ----------- | -------------- |
| `Agent`     | `id`, `name`, `role`, `status`, `synthetic` |
| `Memory`    | `id`, `content`, `status`, `trust`, `createdAt`, `updatedAt`, `sourceType`, `sourceRef`, `reason`, `quarantinedAt`, `revalidatedAt`, `revalidationReason`, `synthetic` |
| `Source`    | `id`, `type`, `description`, `trusted`, `synthetic` |
| `Decision`  | `id`, `description`, `status`, `createdAt`, `lastValidatedAt`, `revalidationReason`, `synthetic` |
| `Incident`  | `id`, `title`, `severity`, `confidence`, `reason`, `status`, `createdAt`, `containedAt`, `policyId`, `evidence` (JSON), `synthetic` |
| `AuditEvent`| `id`, `type`, `actor`, `createdAt`, `reason` |

Statuses: memory `trusted / suspicious / quarantined / review_required`; decision `active / review_required / revalidated / revoked`; incident `open / investigating / contained / resolved`.

Relationship directions are fixed (edge property `evidence` is JSON where present):

```
(:Agent)-[:CREATED]->(:Memory)
(:Agent)-[:CREATED]->(:Decision)
(:Memory)-[:DERIVED_FROM]->(:Memory)        // child → parent
(:Memory)-[:SUPPORTED_BY]->(:Source)
(:Decision)-[:DEPENDS_ON]->(:Memory)
(:Incident)-[:TARGETS]->(:Memory)
(:Incident)-[:AFFECTS]->(:Decision)
(:Memory)-[:FLAGGED_BY]->(:Incident)        // set on quarantine/review
(:Decision)-[:FLAGGED_BY]->(:Incident)
(:Incident)-[:HAS_EVENT]->(:AuditEvent)     // quarantine / revalidation trail
```

All writes use stable `id` properties and idempotent `MERGE`, so repeated seeds never duplicate nodes. Quarantine and revalidation states are ordinary graph properties and survive restarts.

> `MERGE`-based `attachEvidence()` in `backend/src/db/schema.ts` can create standalone `(:Evidence)` nodes, but the current pipeline stores structured evidence as a JSON property on `Incident`, so that helper is **not wired into any route**.

## 6. Important Cypher & graph algorithms

Traversal limits: `TRAVERSAL = { maxDepth: 6, maxNodes: 200 }` (`backend/src/lib/types.ts`).

- **Downstream memories** — bounded `DERIVED_FROM*1..6` expansion from the suspect, with `min(length(path))` for hop depth and a node cap that reports truncation.
- **Affected decisions** — `(d:Decision)-[:DEPENDS_ON]->(m:Memory)` where `m` is the root **or** transitively derives from it (`(m)-[:DERIVED_FROM*1..6]->(root)`).
- **Influence chains** — `(root)<-[:DERIVED_FROM*0..6]-(:Memory)<-[:DEPENDS_ON]-(d:Decision)`, returning `[x IN nodes(path) | x.id]` so the UI renders real chains.
- **Quarantine** — status `SET`s plus `FLAGGED_BY` `MERGE`s; audit events use `MERGE (e:AuditEvent {id: ...})` keyed by incident, making retries idempotent.
- **Gated revalidation** — a decision is blocked while any memory in its `DEPENDS_ON` + `DERIVED_FROM*0..6` closure is `quarantined` or `review_required`.

Full, copy-accurate Cypher, index definitions, idempotency notes, and traversal boundaries: **[`docs/GRAPH.md`](docs/GRAPH.md)**. REST surfaces: [`docs/API.md`](docs/API.md).

## 7. Prerequisites & local setup

Prerequisites: **Node 18+** (verified on Node 24), **Docker + Docker Compose**, **npm**.

```bash
# 1. FalkorDB (binds only to 127.0.0.1, persists to a named volume)
docker compose up -d falkordb
docker compose ps                 # wait for "healthy"

# 2. Backend (port 4000; creates indexes and seeds the synthetic dataset on start)
cd backend
npm install
npm run dev                       # tsx watch src/server.ts

# 3. Frontend (Vite dev server proxies /api -> localhost:4000)
cd ../frontend
npm install
npm run dev                       # open http://localhost:5173
```

No API key or paid service is required. `AUTO_SEED=true` (default) seeds the synthetic dataset on backend start.

Seed / reset (both restricted to demo use):

```bash
# idempotent upsert of the synthetic dataset
curl -X POST http://localhost:4000/api/demo/seed

# destructive reset — requires ALLOW_DEMO_RESET=true (default) and an explicit body
curl -X POST http://localhost:4000/api/demo/reset \
  -H 'Content-Type: application/json' \
  -d '{"confirmPhrase":"reset-demo","acknowledgeSynthetic":true}'
```

You can also seed from the CLI: `cd backend && npm run seed`.

## 8. Environment variables & optional LLM

`backend/.env.example` (copy to `backend/.env`; all defaults work with a local FalkorDB):

```ini
PORT=4000
FALKORDB_HOST=127.0.0.1
FALKORDB_PORT=6379
FALKORDB_GRAPH=MEMORYGUARD
# FALKORDB_PASSWORD=
CORS_ORIGIN=http://localhost:5173
ALLOW_DEMO_RESET=true
AUTO_SEED=true

# Optional LLM enrichment (narrative only; never authorizes decisions)
LLM_PROVIDER=none            # none | gemini | groq | openrouter
LLM_API_KEY=
LLM_MODEL=                   # user-supplied; never hard-coded
# LLM_BASE_URL=              # OpenAI-compatible base URL (required for gemini via proxy)
LLM_TIMEOUT_MS=20000
```

The LLM adapter is **off by default**. Enable it by setting `LLM_PROVIDER`, `LLM_API_KEY`, and `LLM_MODEL`; if any call fails, times out, or returns malformed output, the endpoint silently falls back to the deterministic explanation.

## 9. Demo walkthrough — synthetic incident `inc-auth-checks`

Seeded scenario: `mem-suspicious-root` (untrusted, `suspicious`) is derived into `mem-derived-plan`, which the `dec-deploy` decision depends on. `mem-unrelated-trusted` and `mem-deploy-notes` are deliberately unrelated and must never appear in results.

**UI path (http://localhost:5173):**

1. **Overview** — live metrics (memories by status, open incidents, affected decisions) and an activity timeline derived from persisted graph facts.
2. **Incidents → inc-auth-checks** — suspect memory, detection reason, and structured evidence.
3. **Run investigation** → influence chain `mem-suspicious-root → mem-derived-plan → dec-deploy`; **1** downstream memory, **1** affected decision.
4. **Quarantine suspect** (confirm the dialog) → root becomes `quarantined`, `mem-derived-plan` and `dec-deploy` become `review_required`, incident becomes `contained`. Refresh or restart the backend — state holds.
5. **Revalidate** `dec-deploy` → **409** until the quarantined dependency is cleared. The root needs `?root=true` with a documented reason.
6. **Memory Graph** — renders stored relationships only (never invents edges); filter by node type, trust state, or agent.
7. **Settings → Reset demo** restores the documented demo state after explicit confirmation.

**Exact API sequence** (verified against a local FalkorDB; matches the steps above):

```bash
BASE=http://localhost:4000

curl -s $BASE/api/health
curl -s $BASE/api/incidents/inc-auth-checks | jq '{status, suspect: .suspectMemory.id}'
curl -s -X POST $BASE/api/incidents/inc-auth-checks/investigate \
  | jq '.impact | {downstreamMemoryIds, affectedDecisionIds, chains}'

# operator-confirmed quarantine (body is required)
curl -s -X POST $BASE/api/incidents/inc-auth-checks/quarantine \
  -H 'Content-Type: application/json' -d '{"confirmed":true}'

curl -s $BASE/api/memories/mem-suspicious-root | jq '.memory.status'   # "quarantined"
curl -s $BASE/api/memories/mem-derived-plan   | jq '.memory.status'   # "review_required"

# gated revalidation → HTTP 409 with {"ok":false,"blockedBy":[...]}
curl -s -i -X POST $BASE/api/decisions/dec-deploy/revalidate \
  -H 'Content-Type: application/json' \
  -d '{"reason":"attempt before root is cleared"}'

# clear the root explicitly, then revalidate downstream (root=true path)
curl -s -X POST "$BASE/api/memories/mem-suspicious-root/revalidate?root=true" \
  -H 'Content-Type: application/json' -d '{"reason":"Independently verified as inert synthetic demo data."}'
curl -s -X POST $BASE/api/memories/mem-derived-plan/revalidate \
  -H 'Content-Type: application/json' -d '{"reason":"Downstream review complete after root clearance."}'
curl -s -X POST $BASE/api/decisions/dec-deploy/revalidate \
  -H 'Content-Type: application/json' -d '{"reason":"Dependencies reviewed; no production action taken."}'

# optional advisory narrative (deterministic when no LLM key is set)
curl -s -X POST $BASE/api/incidents/inc-auth-checks/explanation | jq
```

## 10. Test, typecheck, build & benchmark

```bash
# Backend (Vitest + Supertest against a live FalkorDB)
cd backend
npm run typecheck       # tsc --noEmit
npm test                # vitest run
npm run seed            # optional CLI seed of the synthetic dataset
npx tsx benchmark/run.ts   # policy benchmark; exits non-zero on FP / unexplained FN

# Frontend
cd ../frontend
npm run typecheck       # tsc -b
npm run build           # tsc -b && vite build
```

The backend suite uses a **dedicated throwaway graph, `MEMORYGUARD_TEST`**, and deletes only that graph before/after its run — it never touches the `MEMORYGUARD` demo graph.

If FalkorDB is not running, `docker compose up -d falkordb` and wait for `healthy` before `npm test`.

A GitHub Actions workflow is included at `.github/workflows/ci.yml` (backend typecheck + tests + benchmark against a FalkorDB service container; frontend typecheck + build). It has **not been executed on GitHub** in this repository yet — the identical commands were run locally and are reported in §11.

## 11. Verified results & limitations

Reproduced on 2026-10-18 against a local FalkorDB (`docker compose`) — Node v24.21.0, npm 11.6.2, Docker 28.0.1:

| Check | Command | Result |
| ----- | ------- | ------ |
| Backend typecheck | `npm run typecheck` (backend) | ✅ pass |
| Backend tests | `npm test` (backend) | ✅ **49 passed** (10 policy + 39 API), 2 files |
| Policy benchmark | `npx tsx benchmark/run.ts` | ✅ **TP=9 FP=0 FN=0 TN=7**, precision 100%, recall 100% |
| Frontend typecheck | `npm run typecheck` (frontend) | ✅ pass |
| Frontend build | `npm run build` (frontend) | ✅ pass (≈360 kB JS / 26 kB CSS) |

**These numbers are deliberately narrow.** The benchmark is a **16-entry, hand-labeled synthetic corpus** scored by the deterministic regex/matcher engine. `TP=9 FP=0 FN=0 TN=7` describes *that corpus only* and is **not** evidence of production detection accuracy, real-world precision, or coverage. Two corpus entries are marked `provenanceDependent` and cannot be classified correctly by text alone — they require graph lineage, which is evaluated separately by the traversal layer.

Re-run these commands yourself and compare — nothing here is a projected or estimated figure.

## 12. Security properties & known limitations

Security properties:

- Zod validation on query, params, and body payloads; 64 KB JSON body cap; malformed JSON returns `400`, not `500`.
- **Parameterized Cypher everywhere**; user input is never interpolated into a query; the only interpolated identifiers come from fixed literals, and traversal depth is a constant.
- The frontend cannot supply trust scores or drive status transitions; allowed transitions are enforced server-side.
- Demo reset requires `ALLOW_DEMO_RESET`, the literal phrase `reset-demo`, and `acknowledgeSynthetic: true`; **arbitrary Cypher is never accepted** by the API.
- Narrow CORS (`CORS_ORIGIN`), `trust proxy` disabled; internal errors are logged server-side and only a generic message is returned to clients.
- Stored memory content is **data only** — it is pattern-matched, never executed.
- **Authentication is intentionally absent.** This is a local demonstration tool. Do **not** deploy it to a public internet endpoint as-is; add authentication and authorization first. The demo-reset route is destructive and must not be exposed.
- Database disconnection degrades gracefully (`/api/health` reports `degraded`, HTTP 503).

Known limitations:

- Policy detection is deterministic pattern matching; it is intentionally conservative and does not generalize to arbitrary novel phrasing.
- Blast-radius traversal is bounded (max depth 6, max 200 nodes) and reports truncation rather than expanding without limit.
- The installed FalkorDB JavaScript client exposes graph queries but no transaction API. Writes are therefore idempotent `MERGE`/`SET` operations designed to be safely retried; each revalidation writes its status and audit event in a single Cypher query.
- `MEMORYGUARD` is a single named graph; there is no multi-tenant isolation.
- The optional LLM narrative is advisory and disabled by default; it is never consulted for classification or containment.

## 13. Repository layout

```
backend/
  src/app.ts                 Express routes + validation + error mapping
  src/server.ts              startup: ping, ensureConstraints, auto-seed, listen
  src/env.ts                 environment parsing
  src/db/falkordb.ts         connection, ping, parameterized query helpers
  src/db/schema.ts           indexes + status guards
  src/policies/              policies.json + deterministic evaluator
  src/services/              detection, blastRadius, containment, seed, metrics,
                             graphView, memories, incidents, llm, demo
  tests/                     Vitest + Supertest (api.test.ts, policy.test.ts)
  benchmark/                 synthetic corpus + runner
frontend/
  src/lib/api.ts             typed API client
  src/pages/                 Overview, Incidents(+Detail), MemoryGraph,
                             MemoryExplorer(+Detail), Policies, Settings
docs/
  GRAPH.md                   FalkorDB model + Cypher reference
  API.md                     REST reference
  HACKATHON_SUBMISSION.md    submission description, demo script, checklist
docker-compose.yml           FalkorDB service (localhost only)
.github/workflows/ci.yml     backend + frontend CI
```

## 14. AI-assisted development disclosure

This project was developed with an AI coding agent (**Codebuff**) and human direction: code, tests, and documentation were generated and iterated against a **live FalkorDB instance**, then reviewed by a human for scope and stack requirements. The project was subsequently audited and polished with further AI assistance (a frontend/backend contract bug, an error-mapping bug, and a broken `npm run seed` script were fixed; regression tests were added), with all verification commands re-run and the results recorded in §11. AI assistance was used for implementation, testing, and documentation — final responsibility for the code and its claims rests with the repository author.

## 15. License / status

Hackathon prototype. No license file is included; treat as source-available for evaluation. See [`docs/HACKATHON_SUBMISSION.md`](docs/HACKATHON_SUBMISSION.md) for the submission checklist and remaining author tasks (demo video, blog post).
