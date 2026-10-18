import { useCallback, useEffect, useState } from 'react';
import { Play, Lock, Sparkles, GitBranch } from 'lucide-react';
import {
  api,
  type IncidentDetail as IncidentDetailType,
  type BlastRadius,
  type QuarantineReport,
  type Explanation,
} from '../lib/api';
import { Loading, ErrorBlock, Empty } from '../components/states';
import { StatusBadge } from '../components/badges';

export default function IncidentDetail({
  id,
  onNav,
  onRefresh,
  dataVersion,
}: {
  id: string;
  onNav: (p: string, id?: string) => void;
  onRefresh: () => void;
  dataVersion: number;
}) {
  const [incident, setIncident] = useState<IncidentDetailType | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const [investigation, setInvestigation] = useState<BlastRadius | null>(null);
  const [investigating, setInvestigating] = useState(false);

  const [quarantine, setQuarantine] = useState<QuarantineReport | null>(null);
  const [quarantining, setQuarantining] = useState(false);
  const [qError, setQError] = useState<string | null>(null);

  const [explanation, setExplanation] = useState<Explanation | null>(null);
  const [explaining, setExplaining] = useState(false);
  const [expError, setExpError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    api
      .incident(id)
      .then((i) => alive && setIncident(i))
      .catch((e) => alive && setError(e.message))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [id, dataVersion]);

  const runInvestigation = useCallback(async () => {
    setInvestigating(true);
    try {
      const res = await api.investigate(id);
      setInvestigation(res.impact);
    } finally {
      setInvestigating(false);
    }
  }, [id]);

  async function runQuarantine() {
    if (!window.confirm('Quarantine the suspect memory and flag every dependent record for review?')) return;
    setQuarantining(true);
    setQError(null);
    try {
      const report = await api.quarantine(id);
      setQuarantine(report);
      onRefresh();
    } catch (e) {
      setQError(e instanceof Error ? e.message : String(e));
    } finally {
      setQuarantining(false);
    }
  }

  async function runExplanation() {
    setExplaining(true);
    setExpError(null);
    try {
      setExplanation(await api.explanation(id));
    } catch (e) {
      setExpError(e instanceof Error ? e.message : String(e));
    } finally {
      setExplaining(false);
    }
  }

  if (loading) return <Loading />;
  if (error) return <ErrorBlock message={error} />;
  if (!incident) return <Empty message="Incident not found." />;

  const downstream = investigation?.downstreamMemoryIds.length;
  const affected = investigation?.affectedDecisionIds.length;

  return (
    <div>
      <div className="detail-header">
        <div style={{ flex: 1, minWidth: 0 }}>
          <h2 className="page-title">{incident.title}</h2>
          <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
            <StatusBadge value={incident.severity} />
            <StatusBadge value={incident.status} />
            <span className="badge neutral">{incident.confidence.replace(/_/g, ' ')}</span>
            <span className="faint mono">{incident.id}</span>
          </div>
        </div>
        <button className="btn primary" onClick={runInvestigation} disabled={investigating}>
          <Play size={14} />
          {investigating ? 'Traversing graph…' : 'Run investigation'}
        </button>
        <button className="btn" onClick={() => onNav('graph', id)} title="Open the memory graph filtered to this incident's attack path">
          <GitBranch size={14} />
          View attack path
        </button>
        {incident.status !== 'contained' && (
          <button className="btn danger" onClick={runQuarantine} disabled={quarantining}>
            <Lock size={14} />
            {quarantining ? 'Quarantining…' : 'Quarantine suspect'}
          </button>
        )}
      </div>

      {qError && <ErrorBlock message={`Quarantine failed: ${qError}`} />}

      {quarantine && (
        <div className="success-banner">
          Quarantined: {quarantine.quarantined.length ? quarantine.quarantined.join(', ') : 'none (already contained)'} ·
          flagged for review — memories: {quarantine.flaggedForReview.memories.length}, decisions: {quarantine.flaggedForReview.decisions.length} ·
          unresolved: {quarantine.unresolved.memories.length + quarantine.unresolved.decisions.length}
        </div>
      )}

      <div className="grid-wide-left">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14, minWidth: 0 }}>
          <div className="card">
            <h3>Suspect memory</h3>
            <div className="mono dim">{incident.targetsMemoryId}</div>
            <div
              className="quoted-memory"
              style={{ cursor: 'pointer' }}
              onClick={() => onNav('memories', incident.targetsMemoryId)}
              title="Open memory detail"
            >
              {incident.targetsMemoryId ? '' : ''}
              <span className="faint"># synthetic demonstration data &mdash;</span> see Memory Explorer for full content
            </div>
            <div className="kv">
              <dt>Detection reason</dt>
              <dd>{incident.reason || '—'}</dd>
              <dt>Detected</dt>
              <dd>{new Date(incident.createdAt).toISOString()}</dd>
              <dt>Contained</dt>
              <dd>{incident.containedAt ? new Date(incident.containedAt).toISOString() : 'not contained'}</dd>
            </div>
          </div>

          <div className="card">
            <h3>Matching evidence</h3>
            {incident.evidence.length === 0 ? (
              <Empty message="No structured evidence recorded." />
            ) : (
              <div className="detail-list">
                {incident.evidence.map((e, idx) => (
                  <div key={idx} className="card" style={{ padding: 10 }}>
                    <span className="badge neutral">{e.kind.replace(/_/g, ' ')}</span>
                    <div style={{ marginTop: 6 }}>{String(e.note ?? '')}</div>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="card">
            <h3>Impact (graph traversal)</h3>
            {downstream == null && affected == null ? (
              <Empty message="Run the investigation to traverse downstream influence paths." />
            ) : (
              <>
                <div className="metric-grid" style={{ marginBottom: 14 }}>
                  <div className="metric-card amber">
                    <div className="metric-value">{downstream ?? 0}</div>
                    <div className="metric-label">Downstream memories reachable</div>
                  </div>
                  <div className="metric-card purple">
                    <div className="metric-value">{affected ?? 0}</div>
                    <div className="metric-label">Affected decisions</div>
                  </div>
                </div>
                {investigation && investigation.chains.length > 0 && (
                  <div>
                    <div className="faint" style={{ marginBottom: 6 }}>Influence chains (suspect → … → consumer):</div>
                    {investigation.chains.slice(0, 12).map((c, i) => (
                      <div key={i} className="chain-row">
                        {c.chain.map((node, j) => (
                          <span key={j} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                            {j > 0 && <span className="chain-arrow">→</span>}
                            <span className="chain-chip">{node}</span>
                          </span>
                        ))}
                      </div>
                    ))}
                    {investigation.truncated && <div className="faint">Traversal truncated at the backend limit.</div>}
                  </div>
                )}
                {investigation && investigation.affectedDecisionIds.length > 0 && (
                  <div style={{ marginTop: 10 }}>
                    <div className="faint" style={{ marginBottom: 6 }}>Affected decisions:</div>
                    {investigation.affectedDecisionIds.map((d) => (
                      <div key={d}>
                        <span className="mono" style={{ fontSize: 12, color: 'var(--muted)' }}>{d}</span>
                      </div>
                    ))}
                  </div>
                )}
              </>
            )}
          </div>

          <div className="card">
            <h3>Recommended remediation</h3>
            <ol style={{ margin: 0, paddingLeft: 20, display: 'flex', flexDirection: 'column', gap: 6 }}>
              {(incident.remediation ?? []).map((r, i) => (
                <li key={i}>{r}</li>
              ))}
              {incident.status === 'open' && <li>Quarantine the suspect memory to prevent further derivation.</li>}
              {incident.status === 'contained' && <li>After independent verification, revalidate the quarantined root first, then each flagged downstream memory, and finally each affected decision.</li>}
              <li>Every status below is persisted in FalkorDB; a restart or refresh does not reset it.</li>
            </ol>
          </div>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div className="card">
            <h3>Containment status</h3>
            <StatusBadge value={incident.status} />
            <p className="faint" style={{ marginTop: 8 }}>
              {incident.status === 'contained'
                ? 'Suspect memory quarantine applied; dependents were flagged review_required.'
                : incident.status === 'investigating'
                  ? 'Blast radius computed; quarantine pending operator decision.'
                  : 'No quarantine applied yet.'}
            </p>
          </div>

          <div className="card">
            <h3>Audit history</h3>
            {incident.audit.length === 0 ? (
              <Empty message="No containment or revalidation events recorded yet." />
            ) : (
              <div className="detail-list">
                {incident.audit.map((event) => (
                  <div key={event.id} className="card" style={{ padding: 10 }}>
                    <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                      <span className="badge neutral">{event.type.replace(/_/g, ' ')}</span>
                      <span className="faint mono">{new Date(event.createdAt).toISOString()}</span>
                    </div>
                    <div style={{ marginTop: 6 }}>{event.reason || 'No reason recorded.'}</div>
                    {event.actor && <div className="faint" style={{ marginTop: 4 }}>actor: {event.actor}</div>}
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="card">
            <h3>LLM narrative (optional)</h3>
            <p className="faint">
              Optional hosted-LLM enrichment. It <strong>never</strong> authorizes a security decision — classification and
              quarantine are deterministic and policy-driven.
            </p>
            <button className="btn" onClick={runExplanation} disabled={explaining}>
              <Sparkles size={14} />
              {explaining ? 'Generating…' : 'Generate narrative'}
            </button>
            {expError && <ErrorBlock message={expError} />}
            {explanation && (
              <div style={{ marginTop: 12, fontSize: 13 }}>
                <div className="faint">
                  {explanation.source === 'llm'
                    ? `LLM narrative (${explanation.provider}${explanation.model ? ` · ${explanation.model}` : ''})`
                    : 'Deterministic narrative (no LLM configured)'}
                </div>
                <p>{explanation.summary}</p>
                <div className="faint">Why it triggered</div>
                <p style={{ margin: '4px 0 8px' }}>{explanation.whyTriggered}</p>
                <div className="faint">Dependency chain</div>
                <p className="mono" style={{ margin: '4px 0 8px' }}>{explanation.dependencyChainSummary}</p>
                {explanation.remediation.length > 0 && (
                  <>
                    <div className="faint">Advisory actions (not automatically applied)</div>
                    <ul style={{ margin: '4px 0 8px', paddingLeft: 18 }}>
                      {explanation.remediation.map((f, i) => (
                        <li key={i}>{f}</li>
                      ))}
                    </ul>
                  </>
                )}
                <div className="faint">{explanation.confidenceNote}</div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
