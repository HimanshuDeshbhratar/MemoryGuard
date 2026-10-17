import express, { type NextFunction, type Request, type Response } from 'express';
import cors from 'cors';
import { z, ZodError } from 'zod';
import { env } from './env.js';
import { ping } from './db/falkordb.js';
import { PROTECTED_POLICIES } from './policies/policies.js';
import * as metrics from './services/metrics.js';
import { graphView } from './services/graphView.js';
import { listAgents, createMemory, getMemoryWithProvenance, listMemories } from './services/memories.js';
import { getIncident, getIncidentEvidencePaths, listIncidents } from './services/incidents.js';
import { computeBlastRadius } from './services/blastRadius.js';
import { quarantine, revalidateDecision, revalidateMemory, revalidateQuarantinedRoot } from './services/containment.js';
import { explainIncident } from './services/llm.js';
import { demo } from './routes/demo.js';
import { NotFoundError } from './services/containment.js';

const app = express();
app.set('trust proxy', false);

app.use(cors({ origin: [env.corsOrigin], methods: ['GET', 'POST'] }));
// Bound request sizes (json body max 64 KB).
app.use(express.json({ limit: '64kb' }));

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

const asyncRoute =
  <A>(fn: (req: Request, res: Response, next: NextFunction) => Promise<A>) =>
  (req: Request, res: Response, next: NextFunction) => {
    fn(req, res, next).catch(next);
  };

// ---------------------------------------------------------------- health
app.get('/api/health', asyncRoute(async (_req, res) => {
  const dbOk = await ping();
  res.status(dbOk ? 200 : 503).json({
    status: dbOk ? 'ok' : 'degraded',
    database: dbOk ? 'connected' : 'unavailable',
    graph: env.falkordbGraph,
  });
}));

// ---------------------------------------------------------------- dashboard
app.get('/api/dashboard', asyncRoute(async (_req, res) => {
  const [m, activity] = await Promise.all([metrics.dashboardMetrics(), metrics.recentActivity()]);
  res.json({ metrics: m, activity });
}));

// ---------------------------------------------------------------- agents
app.get('/api/agents', asyncRoute(async (_req, res) => {
  res.json({ agents: await listAgents() });
}));

// ---------------------------------------------------------------- policies
app.get('/api/policies', asyncRoute(async (_req, res) => {
  res.json({
    policies: PROTECTED_POLICIES.map((p) => ({
      id: p.id,
      title: p.title,
      statement: p.statement,
      severity: p.severity,
      confidence: p.confidence,
      matchers: p.matchers.map((m) => ({ field: m.field, pattern: m.pattern })),
    })),
  });
}));

// ---------------------------------------------------------------- memories
const createMemorySchema = z.object({
  content: z.string().min(1).max(4000),
  agentId: z.string().min(1).max(80),
  sourceType: z.enum(['web_scrape', 'internal_doc', 'runbook', 'agent_derivation', 'user_chat', 'other']),
  sourceRef: z.string().max(300).optional(),
  sourceTrusted: z.boolean().default(false),
  derivedFrom: z.string().min(1).max(80).optional(),
});

const memoriesQuerySchema = z.object({
  search: z.string().max(200).optional(),
  status: z.enum(['trusted', 'suspicious', 'quarantined', 'review_required']).optional(),
  agentId: z.string().max(80).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

app.get('/api/memories', asyncRoute(async (req, res) => {
  const q = memoriesQuerySchema.parse(req.query);
  const { items, total } = await listMemories(q);
  res.json({ items, total, limit: q.limit, offset: q.offset });
}));

app.get('/api/memories/:id', asyncRoute(async (req, res) => {
  const id = z.string().min(1).max(80).parse(req.params.id);
  const memory = await getMemoryWithProvenance(id);
  if (!memory) throw new NotFoundError(`memory ${id} not found`);
  res.json(memory);
}));

app.post('/api/memories', asyncRoute(async (req, res) => {
  const input = createMemorySchema.parse(req.body);
  const result = await createMemory(input);
  res.status(201).json(result);
}));

// ---------------------------------------------------------------- incidents
app.get('/api/incidents', asyncRoute(async (_req, res) => {
  res.json({ incidents: await listIncidents() });
}));

const incidentIdParam = z.object({ id: z.string().min(1).max(80) });

app.get('/api/incidents/:id', asyncRoute(async (req, res) => {
  const { id } = incidentIdParam.parse(req.params);
  const incident = await getIncident(id);
  if (!incident) throw new NotFoundError(`incident ${id} not found`);
  res.json(incident);
}));

app.post('/api/incidents/:id/investigate', asyncRoute(async (req, res) => {
  const { id } = incidentIdParam.parse(req.params);
  const incident = await getIncident(id);
  if (!incident) throw new NotFoundError(`incident ${id} not found`);
  const paths = await getIncidentEvidencePaths(id);
  const impact = await computeBlastRadius(id);
  res.json({ incident, evidencePaths: paths, impact });
}));

const quarantineSchema = z.object({ confirmed: z.literal(true) });

app.post('/api/incidents/:id/quarantine', asyncRoute(async (req, res, next) => {
  try {
    const { id } = incidentIdParam.parse(req.params);
    quarantineSchema.parse(req.body);
    const incident = await getIncident(id);
    if (!incident) throw new NotFoundError(`incident ${id} not found`);
    const report = await quarantine(id);
    res.json(report);
  } catch (err) {
    next(err);
  }
}));

const revalidateSchema = z.object({ reason: z.string().min(10).max(1000), actor: z.string().max(80).optional() });

app.post('/api/memories/:id/revalidate', asyncRoute(async (req, res) => {
  const id = z.string().min(1).max(80).parse(req.params.id);
  const { reason, actor } = revalidateSchema.parse(req.body);
  if (req.query.root === 'true') {
    const result = await revalidateQuarantinedRoot(id, reason, actor ?? 'operator');
    res.json(result);
    return;
  }
  const result = await revalidateMemory(id, reason, actor ?? 'operator');
  if (!result.ok) res.status(409).json(result);
  else res.json(result);
}));

app.post('/api/decisions/:id/revalidate', asyncRoute(async (req, res) => {
  const id = z.string().min(1).max(80).parse(req.params.id);
  const { reason, actor } = revalidateSchema.parse(req.body);
  const result = await revalidateDecision(id, reason, actor ?? 'operator');
  if (!result.ok) res.status(409).json(result);
  else res.json(result);
}));

// ---------------------------------------------------------------- graph
const graphQuerySchema = z.object({
  incident: z.string().max(80).optional(),
  type: z.enum(['Agent', 'Memory', 'Source', 'Decision', 'Incident', 'all']).default('all'),
  status: z.enum(['trusted', 'suspicious', 'quarantined', 'review_required']).optional(),
  agentId: z.string().max(80).optional(),
});

app.get('/api/graph', asyncRoute(async (req, res) => {
  const q = graphQuerySchema.parse(req.query);
  const view = await graphView({ incidentId: q.incident, type: q.type, status: q.status, agentId: q.agentId });
  res.json(view);
}));

// ---------------------------------------------------------------- explanations
app.post('/api/incidents/:id/explanation', asyncRoute(async (req, res) => {
  const { id } = incidentIdParam.parse(req.params);
  const explanation = await explainIncident(id);
  if (!explanation) throw new NotFoundError(`incident ${id} not found`);
  res.json(explanation);
}));

// ---------------------------------------------------------------- demo routes
app.use('/api/demo', demo);

// ---------------------------------------------------------------- 404 + errors
app.use((_req: Request, res: Response) => {
  res.status(404).json({ error: 'not_found', message: 'unknown API route' });
});

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof ZodError) {
    res.status(400).json({ error: 'validation_error', issues: err.issues });
    return;
  }
  if (err instanceof NotFoundError) {
    res.status(404).json({ error: 'not_found', message: err.message });
    return;
  }
  if (err instanceof HttpError) {
    res.status(err.status).json({ error: 'request_error', message: err.message });
    return;
  }
  const message = err instanceof Error ? err.message : 'internal error';
  // No stack traces or credentials are exposed to the client.
  if (process.env.NODE_ENV !== 'test') {
    console.error('[api error]', message);
  }
  res.status(500).json({ error: 'internal_error', message: 'internal server error' });
});

export { app, HttpError };
