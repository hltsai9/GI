import { useEffect, useState } from 'react';
import { ChartLineUp, GearSix, Stack, Truck, type Icon } from '@phosphor-icons/react';
import { api, DEMO, devUser, fmtClock, fmtToday, setDevUser, type Me, type Meta } from './api';
import { currentDevice, isTouchOnly, saveDeviceChoice, type Device } from './device';
import { ErrorNote, Msg, useLoad } from './components/ui';
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

function useClock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(t);
  }, []);
  return now;
}

export function App() {
  // Chosen once by device type; resizing or rotating never switches the layout (NFR-01).
  const [device, setDevice] = useState<Device>(currentDevice);
  const [tab, setTab] = useState<Tab>(() => (location.hash.slice(1) as Tab) || (device === 'phone' ? 'receive' : 'stock'));
  const [user, setUser] = useState(devUser);
  const me = useLoad(() => api<Me>('/me'), [user]);
  const meta = useLoad(() => api<Meta>('/meta'), [user]);
  const now = useClock();

  useEffect(() => {
    document.documentElement.dataset.device = device;
    document.documentElement.dataset.touch = String(isTouchOnly());
  }, [device]);
  useEffect(() => {
    history.replaceState(null, '', `#${tab}`);
  }, [tab]);

  const switchView = (d: Device) => {
    saveDeviceChoice(d);
    setDevice(d);
  };
  const chooseUser = (u: string) => {
    setDevUser(u);
    setUser(u);
  };

  const page = !me.data || !meta.data ? (
    <div className="p-body"><ErrorNote error={me.error ?? meta.error} /></div>
  ) : tab === 'receive' ? <Receive meta={meta.data} me={me.data} />
    : tab === 'stock' ? <Stock meta={meta.data} me={me.data} />
    : tab === 'trends' ? <Trends />
    : <Settings meta={meta.data} me={me.data} device={device} reloadMeta={meta.reload} onSwitchView={switchView} user={user} onChooseUser={chooseUser} />;

  const demo = DEMO && (
    <div className="p-seg" style={{ paddingTop: 10 }}>
      <Msg tone="neutral" tag="Demo" text={<span className="muted" style={{ fontSize: 13 }}>Mock data · read-only{device === 'laptop' && <> · <a href="https://github.com/hltsai9/GI">source on GitHub</a></>}</span>} />
    </div>
  );

  return (
    <div className="app">
      {device === 'laptop' && (
        <aside className="side">
          <div style={{ padding: '0 12px' }}>
            <div className="kicker">Cleanroom stores</div>
            <div style={{ fontSize: 24, fontWeight: 600, lineHeight: 1.2 }}>Garments</div>
          </div>
          <nav className="side-nav" aria-label="Main">
            {TABS.map((t) => (
              <button key={t.id} aria-current={tab === t.id ? 'page' : undefined} onClick={() => setTab(t.id)}>
                <t.icon size={22} weight="regular" aria-hidden />{t.label}
              </button>
            ))}
          </nav>
          <div style={{ marginTop: 'auto', padding: '0 12px', fontSize: 13, color: 'var(--color-neutral-700)', lineHeight: 1.5 }}>
            Fab1 + Fab2<br />{fmtToday(now)} · {fmtClock(now.toISOString())}
          </div>
        </aside>
      )}
      <div className="col">
        {device === 'phone' && (
          <>
            <div className="ph-head">
              <span style={{ fontSize: 18, fontWeight: 600 }}>Garments</span>
              <span style={{ fontSize: 12, color: 'var(--color-neutral-700)' }}>Fab1 + Fab2 · {fmtClock(now.toISOString())}</span>
            </div>
            <nav className="ph-tabs" aria-label="Main">
              {TABS.map((t) => (
                <button key={t.id} aria-current={tab === t.id ? 'page' : undefined} onClick={() => setTab(t.id)}>
                  <t.icon size={22} weight="regular" aria-hidden />{t.label}
                </button>
              ))}
            </nav>
          </>
        )}
        {demo}
        {page}
      </div>
    </div>
  );
}
