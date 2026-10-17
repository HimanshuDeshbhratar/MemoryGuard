import { useCallback, useEffect, useState } from 'react';
import {
  LayoutDashboard,
  ShieldAlert,
  GitBranch,
  Database,
  ShieldCheck,
  Settings as SettingsIcon,
  Bug,
  RotateCcw,
  Wifi,
  WifiOff,
  CheckCircle2,
  XCircle,
} from 'lucide-react';
import { api, type Health } from './lib/api';
import Overview from './pages/Overview';
import Incidents from './pages/Incidents';
import IncidentDetail from './pages/IncidentDetail';
import MemoryGraph from './pages/MemoryGraph';
import MemoryExplorer from './pages/MemoryExplorer';
import MemoryDetail from './pages/MemoryDetail';
import Policies from './pages/Policies';
import SettingsPage from './pages/Settings';
import { confirmResetDemo } from './components/dialogs';

interface Route {
  page: string;
  param: string | null;
}

function parseHash(): Route {
  const h = window.location.hash.replace(/^#\/?/, '');
  const [page, param] = h.split('/');
  return { page: page || 'overview', param: param || null };
}

export const NAV_ITEMS = [
  { id: 'overview', label: 'Overview', icon: LayoutDashboard },
  { id: 'incidents', label: 'Incidents', icon: ShieldAlert },
  { id: 'graph', label: 'Memory Graph', icon: GitBranch },
  { id: 'memories', label: 'Memory Explorer', icon: Database },
  { id: 'policies', label: 'Policies', icon: ShieldCheck },
  { id: 'settings', label: 'Settings', icon: SettingsIcon },
] as const;

export type RefreshFn = () => void;

export default function App() {
  const [route, setRoute] = useState<Route>(parseHash);
  const [health, setHealth] = useState<Health | null>(null);
  const [openIncidents, setOpenIncidents] = useState<number | null>(null);
  const [resetState, setResetState] = useState<'idle' | 'busy' | 'done' | 'error'>('idle');
  const [dataVersion, setDataVersion] = useState(0);

  const refresh = useCallback(() => setDataVersion((v) => v + 1), []);

  const loadStatus = useCallback(() => {
    api.health().then(setHealth).catch(() => setHealth(null));
    api
      .incidents()
      .then((r) => setOpenIncidents(r.incidents.filter((i) => i.status !== 'resolved' && i.status !== 'contained').length))
      .catch(() => setOpenIncidents(null));
  }, []);

  useEffect(() => {
    loadStatus();
    const onHash = () => {
      setRoute(parseHash());
      loadStatus();
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, [loadStatus, dataVersion]);

  async function onReset() {
    if (!(await confirmResetDemo())) return;
    setResetState('busy');
    try {
      await api.resetDemo();
      setResetState('done');
      refresh();
    } catch {
      setResetState('error');
    }
    setTimeout(() => setResetState('idle'), 3000);
  }

  const nav = (page: string, param?: string) => {
    window.location.hash = `/${page}${param ? `/${encodeURIComponent(param)}` : ''}`;
  };

  let page: React.ReactNode;
  switch (route.page) {
    case 'incidents':
      page = route.param ? (
        <IncidentDetail id={route.param} onNav={nav} onRefresh={refresh} dataVersion={dataVersion} />
      ) : (
        <Incidents onNav={nav} dataVersion={dataVersion} />
      );
      break;
    case 'graph':
      page = <MemoryGraph onNav={nav} dataVersion={dataVersion} />;
      break;
    case 'memories':
      page = route.param ? (
        <MemoryDetail id={route.param} onNav={nav} />
      ) : (
        <MemoryExplorer onNav={nav} dataVersion={dataVersion} />
      );
      break;
    case 'policies':
      page = <Policies />;
      break;
    case 'settings':
      page = <SettingsPage onRefresh={refresh} dataVersion={dataVersion} />;
      break;
    default:
      page = <Overview onNav={nav} dataVersion={dataVersion} />;
  }

  const dbOk = health?.database === 'connected';

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-icon">
            <Bug size={18} />
          </div>
          <div>
            <div className="brand-name">MemoryGuard</div>
            <div className="brand-sub">Memory Forensics</div>
          </div>
        </div>
        <nav className="nav">
          {NAV_ITEMS.map(({ id, label, icon: Icon }) => (
            <a key={id} className={route.page === id ? 'active' : ''} href={`#/${id}`}>
              <Icon size={16} /> {label}
            </a>
          ))}
        </nav>
        <div className="sidebar-footer">
          Synthetic demo dataset &mdash; all data is labeled demonstration data, not a real incident.
        </div>
      </aside>

      <div className="main">
        <header className="header">
          <h1>MemoryGuard</h1>
          <span className="db-status">
            {dbOk ? <Wifi size={14} className="dim" /> : <WifiOff size={14} style={{ color: 'var(--red)' }} />}
            <span className="dot" style={{ background: dbOk ? 'var(--green)' : 'var(--red)' }} />
            {dbOk ? `FalkorDB · ${health?.graph ?? '—'}` : health ? 'Degraded' : 'Connecting…'}
          </span>
          {openIncidents != null && openIncidents > 0 && (
            <span
              className="incident-count"
              style={{ cursor: 'pointer' }}
              onClick={() => nav('incidents')}
              title="Open incidents"
            >
              {openIncidents} open incident{openIncidents === 1 ? '' : 's'}
            </span>
          )}
          <div className="spacer" />
          <button className="btn primary small" onClick={onReset} disabled={resetState === 'busy'}>
            {resetState === 'busy' ? (
              <RotateCcw size={14} className="animate" />
            ) : resetState === 'done' ? (
              <CheckCircle2 size={14} />
            ) : resetState === 'error' ? (
              <XCircle size={14} />
            ) : (
              <RotateCcw size={14} />
            )}
            Reset demo
          </button>
        </header>
        <main className="content">{page}</main>
      </div>
    </div>
  );
}
