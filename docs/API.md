# MemoryGuard REST API

Base URL (dev): `http://localhost:4100` — the Vite dev server proxies `/api` automatically.

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
| POST   | `/api/memories`     | Create + run the detection pipeline. Body: `{ content (1–4000), agentId, sourceType: web_scrape\|internal_doc\|runbook\|agent_derivation\|user_chat\|other, sourceRef?, sourceTrusted?, derivedFrom? }` → 201 with the memory record (and incident, if a policy matched) |

## Incidents & investigation

| Method | Path                              | Description                                                                                      |
| ------ | --------------------------------- | ------------------------------------------------------------------------------------------------- |
| GET    | `/api/incidents`                  | List with severity, status, suspect memory, counts, agents                                       |
| GET    | `/api/incidents/:id`              | Full detail: reason, evidence records, `remediation`, containment state                          |
| POST   | `/api/incidents/:id/investigate`  | Runs blast-radius traversal: `{ incident, evidencePaths, impact: { suspectMemoryId, downstreamMemoryIds, affectedDecisionIds, memoryDepth, chains, truncated } }` |
| POST   | `/api/incidents/:id/quarantine`   | Body `{ "confirmed": true }` required. Quarantines the suspect memory, flags dependents `review_required`, sets the incident `contained`, writes an audit event. Idempotent. |
| POST   | `/api/incidents/:id/explanation`  | Optional LLM narrative (404-safe; returns deterministic fallback when no provider is configured)  |

## Containment revalidation

| Method | Path                                | Notes                                                                                             |
| ------ | ----------------------------------- | ------------------------------------------------------------------------------------------------- |
| POST   | `/api/memories/:id/revalidate?root=true` | Root-revalidate a quarantined memory. Body: `{ reason (10–1000), actor? }`                    |
| POST   | `/api/memories/:id/revalidate`      | Revalidate a `review_required` memory (still refuses while its upstream is quarantined → 409)      |
| POST   | `/api/decisions/:id/revalidate`     | Revalidate a flagged decision → 409 while any dependency is quarantined                            |

Status transitions are enforced server-side; client-supplied trust/status values are never trusted.

## Graph view

| Method | Path          | Query params                                             | Returns                                                        |
| ------ | ------------- | -------------------------------------------------------- | --------------------------------------------------------------- |
| GET    | `/api/graph`  | `incident?`, `type?` (Agent\|Memory\|Source\|Decision\|Incident\|all), `status?`, `agentId?` | `{ incidentId, nodes: [{ id, type, label, status, agentId, props }], edges: [{ id, source, target, type, evidence }], truncated }` |

Edges are real stored relationships only.

## Demo (local only)

| Method | Path            | Notes                                                                                                         |
| ------ | --------------- | ------------------------------------------------------------------------------------------------------------- |
| POST   | `/api/demo/seed`| Idempotent MERGE upsert of the synthetic dataset                                                              |
| POST   | `/api/demo/reset`| Requires `ALLOW_DEMO_RESET=true` and body `{ confirmPhrase: "reset-demo", acknowledgeSynthetic: true }`; drops the demo graph and reseeds. Arbitrary Cypher is never accepted. |
