/**
 * Typed API client for the MemoryGuard backend.
 * All data comes from live backend queries against FalkorDB — the frontend
 * never fabricates graph edges, trust scores or metrics.
 */

export type MemoryStatus = 'trusted' | 'suspicious' | 'quarantined' | 'review_required';
export type DecisionStatus = 'active' | 'review_required' | 'revalidated' | 'revoked';
export type IncidentStatus = 'open' | 'investigating' | 'contained' | 'resolved';

export interface Health {
  status: 'ok' | 'degraded';
  database: 'connected' | 'unavailable';
  graph: string;
}

export interface DashboardMetrics {
  memories: {
    total: number;
    trusted: number;
    suspicious: number;
    quarantined: number;
    reviewRequired: number;
  };
  affectedDecisions: number;
  openIncidents: number;
  totalIncidents: number;
  agents: number;
}

export interface ActivityItem {
  id: string;
  kind: string;
  message: string;
  at: string;
}

export interface IncidentSummary {
  id: string;
  title: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
  status: IncidentStatus;
  createdAt: string;
  confidence: string;
  targetsMemoryId: string;
  affectedDecisions: number;
  downstreamMemories: number;
  agents: string[];
}

export interface EvidenceRecord {
  kind: string;
  note: string;
  [k: string]: unknown;
}

export interface IncidentDetail extends IncidentSummary {
  reason: string;
  containedAt: string | null;
  evidence: EvidenceRecord[];
  remediation?: string[];
  /** Persisted containment and revalidation audit events for this incident. */
  audit: Array<{
    id: string;
    type: string;
    actor: string;
    reason: string;
    createdAt: string;
  }>;
}

export interface MemoryListItem {
  id: string;
  content: string;
  status: MemoryStatus;
  trust: string;
  createdAt: string;
  updatedAt: string;
  sourceType: string;
  sourceRef: string;
  sourceTrusted: boolean;
  reason: string;
  agentId: string;
  incidentIds: string[];
}

/** The single-memory record returned inside GET /api/memories/:id ({ memory }). */
export interface MemoryRecord extends Omit<MemoryListItem, 'incidentIds'> {
  incidents: string[];
}

/** Mirrors backend MemoryProvenance (GET /api/memories/:id → { memory, ...lineage }). */
export interface MemoryDetail {
  memory: MemoryRecord;
  derivedFrom: Array<{ id: string; content: string; status: string }>;
  derivedMemories: Array<{ id: string; content: string; status: string }>;
  supportingSources: Array<{ id: string; type: string; description: string; trusted: boolean }>;
  dependentDecisions: Array<{ id: string; description: string; status: DecisionStatus }>;
  createdAtBy: { id: string; name: string; role: string } | null;
  auditTrail: unknown[];
  /** Observed exposure: memories retrieved in a context this memory was written in (unproven). */
  exposedTo: Array<{ id: string; content: string; status: string; contextId: string }>;
  /** Records written in a context that retrieved this memory (potential influence). */
  exposedRecords: Array<{ id: string; label: string; kind: 'memory' | 'decision'; contextId: string }>;
  /** Retrieval contexts this memory was written in (empty when provenance is unknown). */
  createdInContexts: string[];
}

export interface GraphNode {
  id: string;
  type: 'Agent' | 'Memory' | 'Source' | 'Decision' | 'Incident';
  label: string;
  status: string | null;
  /** Structured node metadata from the backend (content, severity, role, sourceType, etc.) */
  meta: Record<string, unknown>;
  /** True if this node is the suspect memory targeted by the active incident filter */
  incidentSuspect: boolean;
  /** True if this node is on the downstream attack path of the active incident */
  onIncidentPath: boolean;
  /** True if this node has been flagged via FLAGGED_BY relationship */
  flagged: boolean;
}

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  type: string;
  /** Optional relationship metadata, when the backend attaches it. */
  evidence?: string | null;
}

export interface GraphView {
  incidentId: string | null;
  nodes: GraphNode[];
  edges: GraphEdge[];
  truncated: boolean;
}

export interface PolicyDef {
  id: string;
  title: string;
  statement: string;
  severity: string;
  confidence: string;
  matchers: Array<{ field: string; pattern: string }>;
}

export interface AgentInfo {
  id: string;
  name: string;
  role: string;
}

export interface ProvenanceSummary {
  declaredRelationshipCount: number;
  exposureRelationshipCount: number;
  unprovenancedMemories: number;
  coverageComplete: boolean;
  caveat: string;
}

export interface QuarantineReport {
  incidentId: string;
  suspectMemoryId: string | null;
  quarantined: string[];
  flaggedForReview: { memories: string[]; decisions: string[] };
  unresolved: { memories: string[]; decisions: string[] };
  exposed: { memories: string[]; decisions: string[]; contextIds: string[] };
  provenance: ProvenanceSummary;
}

export interface BlastRadius {
  suspectMemoryId: string;
  /** Confirmed recorded lineage (declared DERIVED_FROM). */
  downstreamMemoryIds: string[];
  /** Confirmed recorded lineage: decisions depending on a derived memory. */
  affectedDecisionIds: string[];
  /** Observed exposure (unproven): memories written in a retrieval context that read the suspect. */
  exposedMemoryIds: string[];
  /** Observed exposure (unproven): decisions written in / depending on an exposed record. */
  exposedDecisionIds: string[];
  exposureContextIds: string[];
  memoryDepth: Record<string, number>;
  chains: Array<{ chain: string[]; decisionId: string | null }>;
  truncated: boolean;
  provenance: ProvenanceSummary;
}

/** Mirrors backend RetrievalResult (POST /api/retrievals). */
export interface RetrievalResult {
  contextId: string;
  agentId: string;
  retrievedMemoryIds: string[];
  recordedAt: string;
  correlationId: string | null;
}

/** Mirrors backend ContextDetail (GET /api/contexts/:id?agentId=…). */
export interface ContextDetail {
  contextId: string;
  agentId: string;
  createdAt: string;
  correlationId: string | null;
  retrievedMemories: Array<{ id: string; content: string; status: MemoryStatus }>;
  exposedRecords: Array<{ id: string; label: string; kind: 'memory' | 'decision' }>;
}

/**
 * Mirrors the backend `IncidentExplanation`
 * (`POST /api/incidents/:id/explanation`). The narrative is advisory only —
 * the LLM never authorizes a security decision.
 */
export interface Explanation {
  source: 'llm' | 'deterministic';
  provider: string;
  model: string | null;
  summary: string;
  whyTriggered: string;
  dependencyChainSummary: string;
  remediation: string[];
  confidenceNote: string;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    /* non-JSON error body */
  }
  if (!res.ok) {
    const b = (body ?? {}) as { error?: string; message?: string };
    throw new ApiError(res.status, b.error ?? 'request_failed', b.message ?? `HTTP ${res.status}`);
  }
  return body as T;
}

export const api = {
  health: () => request<Health>('/api/health'),
  dashboard: () => request<{ metrics: DashboardMetrics; activity: ActivityItem[] }>('/api/dashboard'),
  agents: () => request<{ agents: AgentInfo[] }>('/api/agents'),
  policies: () => request<{ policies: PolicyDef[] }>('/api/policies'),
  memories: (params?: { search?: string; status?: string; agentId?: string; limit?: number; offset?: number }) => {
    const qs = new URLSearchParams();
    if (params) {
      if (params.search) qs.set('search', params.search);
      if (params.status && params.status !== 'all') qs.set('status', params.status);
      if (params.agentId && params.agentId !== 'all') qs.set('agentId', params.agentId);
      if (params.limit != null) qs.set('limit', String(params.limit));
      if (params.offset != null) qs.set('offset', String(params.offset));
    }
    const suffix = qs.toString() ? `?${qs}` : '';
    return request<{ items: MemoryListItem[]; total: number; limit: number; offset: number }>(`/api/memories${suffix}`);
  },
  memory: (id: string) => request<MemoryDetail>(`/api/memories/${encodeURIComponent(id)}`), // typed via MemoryDetail wrapper
  createMemory: (body: unknown) =>
    request<{ memoryId: string; incidentId: string | null; derivedFrom: string[]; exposedTo: string[]; contextId: string | null }>(
      '/api/memories',
      { method: 'POST', body: JSON.stringify(body) },
    ),
  /** Record that an agent retrieved memories into a context (observed exposure). */
  recordRetrieval: (body: { contextId: string; agentId: string; memoryIds: string[]; correlationId?: string }) =>
    request<RetrievalResult>('/api/retrievals', { method: 'POST', body: JSON.stringify(body) }),
  context: (id: string, agentId: string) =>
    request<ContextDetail>(`/api/contexts/${encodeURIComponent(id)}?agentId=${encodeURIComponent(agentId)}`),
  /** Create a decision; when `contextId` is supplied its exposure is recorded server-side. */
  createDecision: (body: { description: string; agentId: string; dependsOn?: string[]; contextId?: string }) =>
    request<{ decisionId: string; dependsOn: string[]; exposedTo: string[]; contextId: string | null }>('/api/decisions', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  incidents: () => request<{ incidents: IncidentSummary[] }>('/api/incidents'),
  incident: (id: string) => request<IncidentDetail>(`/api/incidents/${encodeURIComponent(id)}`),
  investigate: (id: string) =>
    request<{ incident: IncidentDetail; evidencePaths: unknown; impact: BlastRadius }>(
      `/api/incidents/${encodeURIComponent(id)}/investigate`,
      { method: 'POST' },
    ),
  quarantine: (id: string) =>
    request<QuarantineReport>(`/api/incidents/${encodeURIComponent(id)}/quarantine`, {
      method: 'POST',
      body: JSON.stringify({ confirmed: true }),
    }),
  explanation: (id: string) => request<Explanation>(`/api/incidents/${encodeURIComponent(id)}/explanation`, { method: 'POST' }),
  revalidateMemory: (id: string, reason: string, opts?: { root?: boolean }) =>
    request<{ ok: boolean;[k: string]: unknown }>(`/api/memories/${encodeURIComponent(id)}/revalidate${opts?.root ? '?root=true' : ''}`, {
      method: 'POST',
      body: JSON.stringify({ reason, actor: 'operator' }),
    }),
  revalidateDecision: (id: string, reason: string) =>
    request<{ ok: boolean;[k: string]: unknown }>(`/api/decisions/${encodeURIComponent(id)}/revalidate`, {
      method: 'POST',
      body: JSON.stringify({ reason, actor: 'operator' }),
    }),
  graph: (params?: { incident?: string; type?: string; status?: string; agentId?: string }) => {
    const qs = new URLSearchParams();
    if (params) {
      if (params.incident) qs.set('incident', params.incident);
      if (params.type && params.type !== 'all') qs.set('type', params.type);
      if (params.status && params.status !== 'all') qs.set('status', params.status);
      if (params.agentId && params.agentId !== 'all') qs.set('agentId', params.agentId);
    }
    const suffix = qs.toString() ? `?${qs}` : '';
    return request<GraphView>(`/api/graph${suffix}`);
  },
  seed: () => request<{ ok: boolean; message: string }>('/api/demo/seed', { method: 'POST' }),
  resetDemo: () =>
    request<{ ok: boolean; message: string }>('/api/demo/reset', {
      method: 'POST',
      body: JSON.stringify({ confirmPhrase: 'reset-demo', acknowledgeSynthetic: true }),
    }),
};

export function timeAgo(iso: string): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return iso;
  const s = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export function shortContent(content: string, max = 90): string {
  return content.length > max ? `${content.slice(0, max)}…` : content;
}
