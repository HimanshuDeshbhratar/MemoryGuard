import { useEffect, useState } from 'react';
import { api, type PolicyDef } from '../lib/api';
import { Loading, ErrorBlock, Empty } from '../components/states';
import { StatusBadge } from '../components/badges';

export default function Policies() {
  const [policies, setPolicies] = useState<PolicyDef[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    api
      .policies()
      .then((r) => alive && setPolicies(r.policies))
      .catch((e) => alive && setError(e.message));
    return () => {
      alive = false;
    };
  }, []);

  if (error) return <ErrorBlock message={error} />;
  if (!policies) return <Loading />;

  return (
    <div>
      <h2 className="page-title">Protected Policies</h2>
      <p className="page-sub">
        Policies are stored as structured definitions in backend/src/policies/policies.json. The deterministic evaluator
        matches structured fields against these patterns before a graph write produces an incident.
      </p>
      {policies.length === 0 ? (
        <Empty message="No policies defined." />
      ) : (
        <div className="detail-list">
          {policies.map((p) => (
            <div key={p.id} className="card">
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 6 }}>
                <StatusBadge value={p.severity} />
                <span className="mono faint">{p.id}</span>
              </div>
              <div style={{ fontWeight: 600, fontSize: 14 }}>{p.title}</div>
              <p className="dim" style={{ margin: '4px 0 10px' }}>{p.statement}</p>
              <div className="faint" style={{ marginBottom: 4 }}>Structured matchers</div>
              <div className="detail-list">
                {p.matchers.map((m, i) => (
                  <div key={i}>
                    <span className="badge neutral">{m.field}</span>{' '}
                    <span className="mono dim">{m.pattern.replace(/\\/g, '')}</span>
                  </div>
                ))}
              </div>
              <div className="lib-note">Confidence tier: {p.confidence.replace(/_/g, ' ')}.</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
