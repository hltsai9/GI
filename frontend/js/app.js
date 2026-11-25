import { h, mount, state, load, update, clearCache } from './dom.js';
import { DEMO, devUser, fmtClock, fmtToday, setAdminToken, setDevUser } from './api.js';
import { currentDevice, isTouchOnly, saveDeviceChoice } from './device.js';
import { ph } from './icons.js';
import { ErrorNote, Msg } from './ui.js';
import { Receive } from './pages/receive.js';
import { Stock } from './pages/stock.js';
import { Trends } from './pages/trends.js';
import { Settings } from './pages/settings.js';

// Phosphor Icons, Regular weight.
const TABS = [
  { id: 'receive', label: 'Receive', icon: 'truck' },
  { id: 'stock', label: 'Stock', icon: 'stack' },
  { id: 'trends', label: 'Trends', icon: 'chartLineUp' },
  { id: 'settings', label: 'Settings', icon: 'gearSix' },
];

function setDevice(d) {
  document.documentElement.dataset.device = d;
  document.documentElement.dataset.touch = String(isTouchOnly());
}

/** Where the app opens: floor staff on a phone start at Receive (the morning delivery); the lead, viewers and
 *  admins at Stock, which is what they check first. Laptops start at Stock. */
const firstTab = (device, role) => (device === 'phone' && role === 'floor' ? 'receive' : 'stock');

function App() {
  // Chosen once by device type; resizing or rotating never switches the layout (NFR-01).
  const [device, setDeviceState] = state('app.device', currentDevice);
  // A link (#stock …) opens that tab; otherwise the first tab depends on the role (known once /me is loaded).
  const [chosen, setTabRaw] = state('app.tab', () => (TABS.some((t) => `#${t.id}` === location.hash) ? location.hash.slice(1) : null));
  const [user, setUser] = state('app.user', devUser);
  const me = load('/me');
  const tab = chosen ?? firstTab(device, me.data?.role);
  const meta = load('/meta');
  const now = new Date();
  const sites = meta.data ? meta.data.locations.map((l) => l.code).join(' + ') : '';

  const setTab = (t) => {
    history.replaceState(null, '', `#${t}`);
    setTabRaw(t);
  };
  const switchView = (d) => {
    saveDeviceChoice(d);
    setDevice(d);
    setDeviceState(d);
  };
  const chooseUser = (u) => {
    if (u !== 'dev-admin') setAdminToken(null); // leaving admin locks it again
    setDevUser(u);
    clearCache(); // everything is reloaded as the new user
    setUser(u);
  };

  const page = !me.data || !meta.data ? h('div', { class: 'p-body' }, ErrorNote(me.error ?? meta.error))
    : tab === 'receive' ? Receive({ meta: meta.data, me: me.data })
      : tab === 'stock' ? Stock({ meta: meta.data, me: me.data })
        : tab === 'trends' ? Trends({ meta: meta.data })
          : Settings({ meta: meta.data, me: me.data, device, onSwitchView: switchView, user, onChooseUser: chooseUser });

  const nav = (cls) => h('nav', { class: cls, 'aria-label': 'Main' },
    TABS.map((t) => h('button', { 'aria-current': tab === t.id ? 'page' : null, onClick: () => setTab(t.id) }, ph(t.icon, 22), t.label)));

  return h('div', { class: 'app' },
    device === 'laptop' && h('aside', { class: 'side' },
      h('div', { style: { padding: '0 12px' } },
        h('div', { class: 'kicker' }, 'Cleanroom stores'),
        h('div', { style: { fontSize: 24, fontWeight: 600, lineHeight: 1.2 } }, 'Garments')),
      nav('side-nav'),
      h('div', { style: { marginTop: 'auto', padding: '0 12px', fontSize: 13, color: 'var(--color-neutral-700)', lineHeight: 1.5 } },
        sites, h('br'), `${fmtToday(now)} · ${fmtClock(now.toISOString())}`)),
    h('div', { class: 'col' },
      device === 'phone' && [
        h('div', { class: 'ph-head' },
          h('span', { style: { fontSize: 18, fontWeight: 600 } }, 'Garments'),
          h('span', { style: { fontSize: 13, color: 'var(--color-neutral-700)' } }, `${sites} · ${fmtClock(now.toISOString())}`)),
      ],
      DEMO && h('div', { class: 'p-seg', style: { paddingTop: 10 } },
        Msg({ tone: 'neutral', tag: 'Demo', text: h('span', { class: 'muted', style: { fontSize: 13 } }, 'Mock data · read-only',
          device === 'laptop' && [' · ', h('a', { href: 'https://github.com/hltsai9/GI' }, 'source on GitHub')]) })),
      page,
      // Phone: the tabs sit at the bottom, within reach of the thumb (decided 2026-11-24; the mockup had them on top).
      device === 'phone' && nav('ph-tabs')));
}

setDevice(state('app.device', currentDevice)[0]);
mount(document.getElementById('root'), App);
setInterval(update, 30_000); // the clock
