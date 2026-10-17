import { useEffect, useState } from 'react';
import { Play } from 'lucide-react';
import { api, timeAgo, type DashboardMetrics, type ActivityItem, type IncidentSummary } from '../lib/api';
import { Loading, ErrorBlock, Empty } from '../components/states';
import { StatusBadge } from '../components/badges';

type Data = { metrics: DashboardMetrics; activity: ActivityItem[] } | null;

export default function Overview({ onNav, dataVersion }: { onNav: (p: string, id?: string) => void; dataVersion: number }) {
  const [data, setData] = useState<Data>(null);
  const [incidents, setIncidents] = useState<IncidentSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [demoBusy, setDemoBusy] = useState(false);
  const [demoMsg, setDemoMsg] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    Promise.all([api.dashboard(), api.incidents()])
      .then(([d, i]) => {
        if (!alive) return;
        setData(d);
        setIncidents(i.incidents);
        setError(null);
      })
      .catch((e) => alive && setError(e.message ?? String(e)))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [dataVersion]);

  async function runDemoIncident() {
    setDemoBusy(true);
    setDemoMsg(null);
    try {
      const target = incidents?.find((i) => i.status === 'open' || i.status === 'investigating') ?? incidents?.[0];
      const res = await api.investigate(target ? target.id : 'inc-auth-checks');
      setDemoMsg(`Investigation complete: ${res.impact.downstreamMemoryIds.length} downstream memories, ${res.impact.affectedDecisionIds.length} affected decisions.`);
      const d = await api.dashboard();
      setData(d);
    } catch (e) {
      setDemoMsg(`Demo failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setDemoBusy(false);
    }
  }

  if (loading) return <Loading label="Querying graph metrics…" />;
  if (error) return <ErrorBlock message={`Backend query failed: ${error}`} />;
  if (!data || !incidents) return <Empty message="No data." />;

  const m = data.metrics.memories;

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 18 }}>
        <button className="btn primary" onClick={runDemoIncident} disabled={demoBusy}>
          <Play size={15} />
          {demoBusy ? 'Running investigation…' : 'Run demo incident'}
        </button>
        {demoMsg && <span className="dim" style={{ fontSize: 12.5 }}>{demoMsg}</span>}
      </div>

      <div className="metric-grid">
        <div className="metric-card">
          <div className="metric-value">{m.total}</div>
          <div className="metric-label">Total memories</div>
        </div>
        <div className="metric-card green">
          <div className="metric-value">{m.trusted}</div>
          <div className="metric-label">Trusted</div>
        </div>
        <div className="metric-card red">
          <div className="metric-value">{m.quarantined}</div>
          <div className="metric-label">Quarantined</div>
        </div>
        <div className="metric-card purple">
          <div className="metric-value">{data.metrics.affectedDecisions}</div>
          <div className="metric-label">Affected decisions</div>
        </div>
        <div className="metric-card red">
          <div className="metric-value">{data.metrics.openIncidents}</div>
          <div className="metric-label">Open incidents</div>
        </div>
      </div>

      <div className="grid-wide-left">
        <div className="card" style={{ padding: 0 }}>
          <h3 style={{ padding: '14px 16px 0' }}>Incidents</h3>
          {incidents.length === 0 ? (
            <Empty message="No incidents recorded." />
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Severity</th>
                    <th>Incident</th>
                    <th>Affected agents</th>
                    <th>Detected</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {incidents.map((i) => (
                    <tr key={i.id} className="row-click" onClick={() => onNav('incidents', i.id)}>
                      <td>
                        <StatusBadge value={i.severity} />
                      </td>
                      <td>
                        <div style={{ fontWeight: 600 }}>{i.title}</div>
                        <div className="faint mono">{i.id}</div>
                      </td>
                      <td className="dim">{i.agents.length}</td>
                      <td className="faint">{timeAgo(i.createdAt)}</td>
                      <td>
                        <StatusBadge value={i.status} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div className="card">
          <h3>Recent activity</h3>
          {data.activity.length === 0 ? (
            <Empty message="No activity yet — seed the demo or create a memory." />
          ) : (
            <div className="timeline">
              {data.activity.map((a) => (
                <div key={a.id} className="timeline-item">
                  <div className={`timeline-dot kind-${a.kind}`} />
                  <div>
                    <div className="kind">{a.kind.replace(/_/g, ' ')}</div>
                    <div>{a.message}</div>
                    <div className="at">{timeAgo(a.at)}</div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
