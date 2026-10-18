# MemoryGuard — Hackathon Submission

## Project title

**MemoryGuard — Graph-Powered AI Agent Memory Security**

## Submission description

MemoryGuard is an incident-response console for **contaminated AI-agent memory**. When an
agent records a suspicious instruction, other agents can derive memories from it and make
decisions based on it. MemoryGuard uses **FalkorDB** as the system of record to:

- detect the conflict deterministically against protected policies,
- trace the suspect memory's influence downstream (`DERIVED_FROM`),
- find the decisions that transitively depend on it (`DEPENDS_ON`),
- let an operator **quarantine** the root and propagate `review_required`,
- **block revalidation** (HTTP 409) while a quarantined dependency remains, and
- persist a tamper-evident audit trail — all in the graph.

It ships with a synthetic demonstration incident, `inc-auth-checks`, a React graph
investigation UI, and an **optional** LLM narrative that never authorizes a security
decision.

> All data is synthetic (`#SYNTHETIC DEMONSTRATION DATA#`). No real incident,
> credential, or production system is represented. The project is a local demo — it has
> **no authentication layer** and must not be exposed publicly as-is.

## Recommended primary track

**Agent Memory and Coordination.**

The project is fundamentally about memory provenance and coordination: how one agent's
stored memory propagates into another agent's derived memory and finally into a decision,
and how to contain that propagation safely. FalkorDB's variable-length traversal is what
makes the containment logic tractable.

### Secondary track

**Connected Data Agents** — recommended as a *secondary* selection **only if the official
FalkorDB Graph Hacks 2026 rules explicitly allow multiple track selections**. Treat the
secondary as optional; do not select it if only one track may be chosen. (Verified against
the published rules by the repository author before submitting.)

## Repository URL

<https://github.com/HimanshuDeshbhratar/MemoryGuard>

## FalkorDB usage

FalkorDB is not a cache here — it is the **source of truth for both the data and the
containment state**.

- **Model** — `Agent`, `Memory`, `Source`, `Decision`, `Incident`, `AuditEvent` nodes with
  directed `CREATED`, `DERIVED_FROM`, `SUPPORTED_BY`, `DEPENDS_ON`, `TARGETS`, `AFFECTS`,
  `FLAGGED_BY`, `HAS_EVENT` relationships. Full reference: [`GRAPH.md`](./GRAPH.md).
- **Provenance as a graph** — "is this decision tainted?" becomes a bounded traversal
  (`DERIVED_FROM`, `DEPENDS_ON`) instead of a hand-maintained denormalized field.
- **Containment as graph state** — quarantine and `review_required` are node properties;
  they survive backend restarts and UI refreshes without a separate store.
- **Audit trail as edges** — each containment/revalidation action is an `AuditEvent`
  reached via `HAS_EVENT`, keyed so retries do not duplicate events.
- **Idempotent by construction** — keyed `MERGE` for nodes/edges plus deterministic audit
  event ids make re-seeding and repeated operator actions safe.
- **Parameterized Cypher only** — every request value is a query parameter; traversal
  depth/caps are constants (`TRAVERSAL = { maxDepth: 6, maxNodes: 200 }`).
- **Indexes** — `CREATE INDEX FOR (n:Label) ON (n.id)` for each node label, created
  idempotently at startup.

## Local demo instructions

Prerequisites: Docker + Docker Compose, Node 18+ (verified on Node 24), npm.

```bash
git clone https://github.com/HimanshuDeshbhratar/MemoryGuard.git
cd MemoryGuard

docker compose up -d falkordb
docker compose ps                 # wait for "healthy"

cd backend  && npm install && npm run dev     # http://localhost:4000
cd ../frontend && npm install && npm run dev  # http://localhost:5173
```

Full walkthrough (UI + exact curl sequence): [`../README.md` §9](../README.md#9-demo-walkthrough--synthetic-incident-inc-auth-checks).

Key API steps:

```bash
BASE=http://localhost:4000
curl -s -X POST $BASE/api/incidents/inc-auth-checks/investigate
curl -s -X POST $BASE/api/incidents/inc-auth-checks/quarantine \
  -H 'Content-Type: application/json' -d '{"confirmed":true}'
curl -s -i -X POST $BASE/api/decisions/dec-deploy/revalidate \
  -H 'Content-Type: application/json' -d '{"reason":"attempt before root is cleared"}'   # → 409
```

## Demo video script (2–3 minutes)

Target length ≈ 2:30. Record at 1440p, terminal + browser side by side. Speak to the
outcome, not the code.

| Time | On screen | Narration |
| ---- | --------- | --------- |
| 0:00–0:15 | Title card + `docker compose ps` showing `healthy` | "MemoryGuard — graph-powered AI agent memory security. One command brings up FalkorDB and the app." |
| 0:15–0:35 | Overview page: metrics + activity timeline | "Agent memory is long-lived. A single bad memory can propagate — derived, summarized, and cited — until it drives a decision. Here's the live state of the graph." |
| 0:35–1:00 | Incidents → `inc-auth-checks`; scroll the evidence panel | "This is a synthetic incident. An untrusted memory tells an agent to disable authentication checks before a production deploy. Detection is deterministic and policy-based — not a keyword filter." |
| 1:00–1:25 | Click **Run investigation**; point at the chain `mem-suspicious-root → mem-derived-plan → dec-deploy` | "The graph shows the blast radius: one downstream memory and one decision that transitively depends on the tainted memory. Unrelated memories are excluded because the traversal is the only source of edges." |
| 1:25–1:50 | Click **Quarantine suspect**, confirm; row statuses flip to `quarantined` / `review_required` | "Containment is operator-confirmed, never automatic. The root becomes quarantined and every dependent record is flagged for review — all persisted in FalkorDB." |
| 1:50–2:10 | `curl` the decision revalidation; show **409** with `blockedBy` | "And it stays contained. Revalidating the decision is blocked with a 409 while the quarantined dependency exists. No silent bypass." |
| 2:10–2:25 | Memory Graph view; toggle a filter | "Here's the same state as a graph — every edge is a real stored relationship." |
| 2:25–2:35 | Refresh the page; state persists; Settings → Reset demo | "Refresh or restart the backend — the quarantine holds, because the state lives in the graph. Deterministic by default; the LLM narrative is optional and advisory only." |

## Blog post — draft / outline

**Title:** *Your agent's memory is a graph problem: tracing and containing poisoned memories*

1. **The new failure mode.** Persistent agent memory is a supply chain. One bad write
   propagates into derived memories and downstream decisions. Text filters miss the
   derived record because it reads as benign in isolation.
2. **Reframing as provenance.** Model agents, memories, sources, decisions, and incidents
   as a graph. "Is this decision tainted?" becomes a bounded traversal
   (`DERIVED_FROM`, `DEPENDS_ON`) rather than a stale boolean field.
3. **Detection that isn't a keyword filter.** Deterministic policies with structured
   matchers over content *and* provenance, with `unless` guards to suppress false
   positives. Show the `inc-auth-checks` policy (`POL-AUTH-001`).
4. **Containment you can trust.** Operator-confirmed quarantine, `review_required`
   propagation, and revalidation gated behind a 409 while a quarantined dependency exists.
5. **Idempotency is a feature.** Keyed `MERGE`, deterministic audit-event ids, and
   single-query status+audit writes make retries safe.
6. **Where the LLM belongs.** Advisory narrative only. Classification and containment stay
   deterministic.
7. **What we'd do next.** Multi-tenant graphs, richer policy DSL, signed audit chain,
   evaluation on larger corpora.

## FalkorDB feedback

**What worked well**

- Variable-length traversals (`[:DERIVED_FROM*1..6]`) made the core question — "what is
  downstream of this memory?" — a one-liner instead of application-side recursion.
- `MERGE ... ON CREATE SET` gave us idempotent seeding and audit events with almost no
  extra code.
- The Redis-style client and `roQuery`/`query` split kept read and write paths clean, and
  JSON stored as node properties (incident `evidence`) avoided a second store.
- Docker image + `redis-cli ping` healthcheck made local and CI setup trivial.

**Constructive suggestions**

- **Idempotent `CREATE INDEX`.** Older releases error on a duplicate index; we had to
  catch "already indexed" as success. `CREATE INDEX IF NOT EXISTS` semantics would remove
  that workaround.
- **Parameterized traversal bounds.** `[:REL*1..$maxDepth]` and `LIMIT $n` are not
  accepted uniformly, forcing us to interpolate constants into the query text. Supporting
  parameters there would make dynamic bounds cleaner.
- **Transactions / multi-statement atomicity.** The JS client exposes no transaction API,
  so we designed writes to be individually idempotent instead of atomic. A documented
  transaction or `CALL {}` subquery pattern would help multi-step containment.
- **Clearer docs on JSON property round-tripping.** We defensively parse properties that
  may already be objects; a documented guarantee would remove the ambiguity.

## Screenshots to capture (real, by the author)

No screenshots are committed yet, and none were fabricated. Capture these from a running
local instance so they match the current UI:

1. `overview.png` — Overview metrics + activity timeline after `POST /api/demo/seed`.
2. `incident-investigation.png` — `inc-auth-checks` after **Run investigation**, showing
   the influence chain and "1 downstream memory / 1 affected decision".
3. `quarantine.png` — the success banner after **Quarantine suspect**, with
   `mem-derived-plan` / `dec-deploy` shown as `review_required`.
4. `revalidation-409.png` — the 409 response for the decision revalidation.
5. `memory-graph.png` — the graph filtered to the incident, showing suspect/attack-path
   highlights.

## Final submission checklist

- [x] Source pushed to <https://github.com/HimanshuDeshbhratar/MemoryGuard>
      *(verify the latest commit is on `origin/main` before submitting)*
- [x] `README.md` with pitch, architecture, schema, setup, walkthrough, verified results.
- [x] `docs/GRAPH.md` (graph model + Cypher) and `docs/API.md` (REST reference).
- [x] Backend tests green (49 passed) and frontend build green (see README §11).
- [x] Policy benchmark reproduces `TP=9 FP=0 FN=0 TN=7` on the small synthetic corpus.
- [x] `.github/workflows/ci.yml` added (backend typecheck/tests/benchmark + frontend build).
- [ ] **Record and upload the 2–3 minute demo video; paste the URL here: _pending_.**
- [ ] **Publish the blog post (optional); paste the URL here: _pending_.**
- [ ] Capture the real screenshots listed above.
- [ ] Confirm the official rules permit a secondary track before selecting one.
- [ ] Confirm eligibility requirements and the submission deadline.
- [ ] Paste the final video/blog links and any deployment info into the submission form.

> Links marked **_pending_** are intentionally left blank. Do not replace them with
> placeholders that look real; fill them in only once the asset genuinely exists.
