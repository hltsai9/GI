import { useEffect, useState } from 'react';
import { ChartLineUp, GearSix, Stack, Truck, type Icon } from '@phosphor-icons/react';
import { api, DEMO, devUser, setDevUser, type Me, type Meta } from './api';
import { currentDevice, isTouchOnly, saveDeviceChoice, type Device } from './device';
import { ErrorNote, useLoad } from './components/ui';
import { Receive } from './pages/Receive';
import { Stock } from './pages/Stock';
import { Trends } from './pages/Trends';
import { Settings } from './pages/Settings';

// Phosphor Icons, Regular weight.
const TABS: readonly { id: 'receive' | 'stock' | 'trends' | 'settings'; label: string; icon: Icon }[] = [
  { id: 'receive', label: 'Receive', icon: Truck },
  { id: 'stock', label: 'Stock', icon: Stack },
  { id: 'trends', label: 'Trends', icon: ChartLineUp },
  { id: 'settings', label: 'Settings', icon: GearSix },
];
type Tab = (typeof TABS)[number]['id'];

const DEV_USERS = [
  { id: 'dev-floor', label: 'Floor staff' }, { id: 'dev-lead', label: 'Cleanroom lead' },
  { id: 'dev-admin', label: 'Admin' }, { id: 'dev-viewer', label: 'Viewer' },
];

export function App() {
  // Chosen once by device type; resizing or rotating never switches the layout (NFR-01).
  const [device, setDevice] = useState<Device>(currentDevice);
  const [tab, setTab] = useState<Tab>(() => (location.hash.slice(1) as Tab) || (device === 'phone' ? 'receive' : 'stock'));
  const [user, setUser] = useState(devUser);
  const me = useLoad(() => api<Me>('/me'), [user]);
  const meta = useLoad(() => api<Meta>('/meta'), [user]);

  useEffect(() => {
    document.documentElement.dataset.device = device;
    document.documentElement.dataset.touch = String(isTouchOnly());
  }, [device]);
  useEffect(() => {
    history.replaceState(null, '', `#${tab}`);
  }, [tab]);

  const switchView = () => {
    const next = device === 'phone' ? 'laptop' : 'phone';
    saveDeviceChoice(next);
    setDevice(next);
  };

  const nav = (
    <nav className="tabs" aria-label="Main">
      {TABS.map((t) => (
        <button key={t.id} className="tab" aria-current={tab === t.id ? 'page' : undefined} onClick={() => setTab(t.id)}>
          <t.icon size={20} weight="regular" aria-hidden />{t.label}
        </button>
      ))}
    </nav>
  );
  const foot = (
    <div className="sidebar-foot small">
      {DEMO ? <span className="muted">Demo: signed in as the cleanroom lead</span> : <label className="field">
        <span>Signed in as (dev)</span>
        <select className="input" value={user} onChange={(e) => { setDevUser(e.target.value); setUser(e.target.value); }}>
          {DEV_USERS.map((u) => <option key={u.id} value={u.id}>{u.label}</option>)}
        </select>
      </label>}
      <button className="btn" onClick={switchView}>Switch to {device === 'phone' ? 'laptop' : 'phone'} view</button>
    </div>
  );

  const banner = DEMO && (
    <p className="notice small" style={{ margin: '0 0 var(--space-4)' }}>
      Demo with mock data — read-only: saving is turned off. <a href="https://github.com/hltsai9/GI">Source on GitHub</a>
    </p>
  );
  const page = !me.data || !meta.data ? (
    <ErrorNote error={me.error ?? meta.error} />
  ) : tab === 'receive' ? <Receive meta={meta.data} me={me.data} />
    : tab === 'stock' ? <Stock meta={meta.data} me={me.data} device={device} />
    : tab === 'trends' ? <Trends />
    : <Settings meta={meta.data} me={me.data} reloadMeta={meta.reload} />;

  if (device === 'laptop') {
    return (
      <div className="shell">
        <aside className="sidebar">
          <div><div className="brand">Cleanroom stores</div><div className="muted small">Garments · Fab1 + Fab2</div></div>
          {nav}
          {foot}
        </aside>
        <main className="main">{banner}{page}</main>
      </div>
    );
  }
  return (
    <div className="shell">
      <header className="shell-header"><span className="brand">Garments</span><span className="muted small">Fab1 + Fab2</span></header>
      {nav}
      <main className="main">{banner}{page}<div style={{ marginTop: 'var(--space-8)' }}>{foot}</div></main>
    </div>
  );
}
