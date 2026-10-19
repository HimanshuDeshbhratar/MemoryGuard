# MemoryGuard REST API

Base URL (dev): `http://localhost:4000` — the Vite dev server proxies `/api` automatically.

All responses are JSON. Errors use structured bodies:

```json
{ "error": "validation_error" | "not_found" | "request_error" | "forbidden" | "internal_error" | "seed_failed" | "reset_failed", "message": "..." }
```

## Health

| Method | Path           | Description                                            |
| ------ | -------------- | ------------------------------------------------------ |
| GET    | `/api/health`  | `{ status, database, graph }`; 503 when DB unreachable |

## Dashboard

| Method | Path             | Description                                                        |
| ------ | ---------------- | ------------------------------------------------------------------ |
| GET    | `/api/dashboard` | `{ metrics: { memories: { total, trusted, suspicious, quarantined, reviewRequired }, affectedDecisions, openIncidents, totalIncidents, agents }, activity: [{ id, kind, message, at }] }` |

Metrics are computed by live graph queries (`services/metrics.ts`); the activity timeline is derived from persisted graph facts (incident creation, memory creation, audit events).

## Agents & policies

| Method | Path           | Description                                  |
| ------ | -------------- | -------------------------------------------- |
| GET    | `/api/agents`  | `{ agents: [{ id, name, role }] }`           |
| GET    | `/api/policies`| Protected policies and structured matchers   |

## Memories

| Method | Path                | Notes                                                                                             |
| ------ | ------------------- | ------------------------------------------------------------------------------------------------- |
| GET    | `/api/memories`     | Query: `search`, `status`, `agentId`, `limit` (1–100, default 50), `offset`. Returns `{ items, total, limit, offset }` |
| GET    | `/api/memories/:id` | Full record: content, provenance, derived from/derived memories, supporting sources, dependent decisions, incident associations |
| POST   | `/api/memories`     | Create + run the detection pipeline. Body: `{ content (1–4000), agentId, sourceType: web_scrape\|internal_doc\|runbook\|agent_derivation\|user_chat\|other, sourceRef?, sourceTrusted?, derivedFrom?: string \| string[], contextId? }` → 201 with `{ memoryId, incidentId, derivedFrom: string[], exposedTo: string[], contextId }` (`incidentId` is `null` when no policy matched). `derivedFrom` accepts a single id (legacy) or an array of up to 20 parent ids (one `DERIVED_FROM` edge each; unknown ids → 400). `contextId` must exist and belong to `agentId` (else 400/403); it links the new memory to the context and records `EXPOSED_TO` for every memory actually retrieved there. |

`exposedTo` is **observed exposure** (server-derived from the context's recorded retrievals), never a caller-supplied field.

## Retrieval contexts (observed exposure)

A `Context` records what one agent retrieved while working on one task. The context is owned by the agent that created it; another agent cannot append to it, write into it, or read it.

| Method | Path                | Notes                                                                                             |
| ------ | ------------------- | ------------------------------------------------------------------------------------------------- |
| POST   | `/api/retrievals`   | Body: `{ contextId, agentId, memoryIds: string[] (1–50), correlationId? }` → 201 `{ contextId, agentId, retrievedMemoryIds, recordedAt, correlationId }`. Validates that the agent and every memory exist (400); rejects reuse of another agent's context (`403`). Idempotent (`MERGE` drops duplicates). |
| GET    | `/api/contexts/:id` | Query `agentId` (required). Returns `{ contextId, agentId, createdAt, correlationId, retrievedMemories: [{ id, content, status }], exposedRecords: [{ id, label, kind }] }`. `404` if unknown, `403` if the caller's `agentId` is not the owner. |

Retrieval records **exposure**, not causation: it does not prove that a retrieved memory influenced anything, only that it was in the context.

## Decisions

| Method | Path             | Notes                                                                                             |
| ------ | ---------------- | ------------------------------------------------------------------------------------------------- |
| POST   | `/api/decisions` | Body: `{ description (1–500), agentId, dependsOn?: string[] (≤50 memory ids), contextId? }` → 201 `{ decisionId, dependsOn, exposedTo, contextId }`. Validates the agent and every dependency memory (400) and context ownership (400/403). A decision created with a `contextId` gets the same `CREATED_IN` / `EXPOSED_TO` provenance as a memory. |

## Incidents & investigation

| Method | Path                              | Description                                                                                      |
| ------ | --------------------------------- | ------------------------------------------------------------------------------------------------- |
| GET    | `/api/incidents`                  | List with severity, status, suspect memory, counts, agents                                       |
| GET    | `/api/incidents/:id`              | Full detail: reason, evidence records, `remediation`, containment state                          |
| GET    | `/api/incidents/:id/containment-status` | Read-only reconciliation of the incident status with review flags. Returns `{ incidentId, incidentStatus, flaggedForReview, unresolved, lineage: { memories, decisions }, exposure: { memories, decisions, contextIds }, provenance }` — declared lineage and observed exposure are reported separately. |
| POST   | `/api/incidents/:id/investigate`  | Runs blast-radius traversal: `{ incident, evidencePaths, impact: { incidentId, suspectMemoryId, downstreamMemoryIds, affectedDecisionIds, exposedMemoryIds, exposedDecisionIds, exposureContextIds, memoryDepth, chains, truncated, provenance } }`. `downstreamMemoryIds`/`affectedDecisionIds` are **confirmed declared lineage**; `exposed*` are **observed exposure** (unproven). `provenance` reports coverage. |
| POST   | `/api/incidents/:id/quarantine`   | Body `{ "confirmed": true }` required. Quarantines the suspect memory, flags records reachable through declared lineage **or** observed exposure `review_required`, sets the incident `contained`, writes an audit event. Returns `{ incidentId, suspectMemoryId, quarantined, flaggedForReview, unresolved, exposed: { memories, decisions, contextIds }, provenance }`. Idempotent. |
| POST   | `/api/incidents/:id/explanation`  | Optional LLM narrative (404-safe; returns deterministic fallback when no provider is configured). Response: `{ source: 'llm'\|'deterministic', provider, model, summary, whyTriggered, dependencyChainSummary, remediation: string[], confidenceNote }` |

## Containment revalidation

| Method | Path                                | Notes                                                                                             |
| ------ | ----------------------------------- | ------------------------------------------------------------------------------------------------- |
| POST   | `/api/memories/:id/revalidate?root=true` | Root-revalidate a quarantined memory. Body: `{ reason (10–1000), actor? }`                    |
| POST   | `/api/memories/:id/revalidate`      | Revalidate a `review_required` memory (still refuses while its upstream is quarantined → 409)      |
| POST   | `/api/decisions/:id/revalidate`     | Revalidate a flagged decision → 409 while any dependency (`DEPENDS_ON` + `DERIVED_FROM*`) **or** any observed-exposure (`EXPOSED_TO*`) memory is quarantined/review_required |

Status transitions are enforced server-side; client-supplied trust/status values are never trusted.

## Graph view

| Method | Path          | Query params                                             | Returns                                                        |
| ------ | ------------- | -------------------------------------------------------- | --------------------------------------------------------------- |
| GET    | `/api/graph`  | `incident?`, `type?` (Agent\|Memory\|Source\|Decision\|Incident\|all), `status?`, `agentId?` | `{ incidentId, nodes: [{ id, type, label, status, agentId, props }], edges: [{ id, source, target, type, evidence }], truncated }` |

Edges are real stored relationships only. This includes observed-exposure edges (`EXPOSED_TO`, dashed amber in the UI) alongside declared lineage (`DERIVED_FROM`, `DEPENDS_ON`). `Context` nodes themselves are not returned by the graph view, so `RETRIEVED` / `CREATED_IN` edges are dropped rather than left dangling; exposure is visible through the `EXPOSED_TO` edges and the incident/memory detail views.

## Demo (local only)

| Method | Path            | Notes                                                                                                         |
| ------ | --------------- | ------------------------------------------------------------------------------------------------------------- |
| POST   | `/api/demo/seed`| Idempotent MERGE upsert of the synthetic dataset                                                              |
| POST   | `/api/demo/reset`| Requires `ALLOW_DEMO_RESET=true` and body `{ confirmPhrase: "reset-demo", acknowledgeSynthetic: true }`; drops the demo graph and reseeds. Arbitrary Cypher is never accepted. |
