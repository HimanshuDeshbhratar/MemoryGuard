import { useEffect, useState } from 'react';
import { api, type Health } from '../lib/api';
import { ErrorBlock } from '../components/states';
import { confirmResetDemo } from '../components/dialogs';

export default function SettingsPage({ onRefresh, dataVersion }: { onRefresh: () => void; dataVersion: number }) {
  const [health, setHealth] = useState<Health | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    let alive = true;
    api.health().then((h) => alive && setHealth(h)).catch(() => alive && setHealth(null));
    return () => {
      alive = false;
    };
  }, [dataVersion]);

  async function reseed() {
    setBusy(true);
    setMsg(null);
    try {
      const r = await api.seed();
      setMsg({ ok: true, text: r.message });
      onRefresh();
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  }

  async function reset() {
    if (!(await confirmResetDemo())) return;
    setBusy(true);
    setMsg(null);
    try {
      const r = await api.resetDemo();
      setMsg({ ok: true, text: r.message });
      onRefresh();
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <h2 className="page-title">Settings &amp; Diagnostics</h2>
      <p className="page-sub">Local configuration and demo controls. No paid services required.</p>

      <div className="grid-2">
        <div className="card">
          <h3>Connection</h3>
          <div className="kv">
            <dt>API health</dt>
            <dd>{health?.status ?? 'unknown'}</dd>
            <dt>Database</dt>
            <dd>{health?.database ?? 'unavailable'}</dd>
            <dt>Graph name</dt>
            <dd>{health?.graph ?? '—'}</dd>
            <dt>Frontend ↔ API</dt>
            <dd>same-origin via Vite proxy /api → localhost:4000</dd>
          </div>
        </div>

        <div className="card">
          <h3>Demo data</h3>
          <p className="dim" style={{ fontSize: 13 }}>
            The graph holds <strong>synthetic demonstration data only</strong>. Seeding is idempotent; reset drops the demo graph
            and restores the documented demo state.
          </p>
          <div style={{ display: 'flex', gap: 10 }}>
            <button className="btn" onClick={reseed} disabled={busy}>
              Re-seed demo (idempotent)
            </button>
            <button className="btn danger" onClick={reset} disabled={busy}>
              Reset demo
            </button>
          </div>
          {msg && !msg.ok && <ErrorBlock message={msg.text} />}
          {msg && msg.ok && <div className="success-banner">{msg.text}</div>}
          <div className="lib-note">
            Optional LLM enrichment (backend <span className="mono">.env</span>): LLM_PROVIDER=none|gemini|groq|openrouter,
            plus LLM_API_KEY and LLM_MODEL. The narrative is advisory only — deterministic investigation works with no key.
          </div>
        </div>
      </div>
    </div>
  );
}
