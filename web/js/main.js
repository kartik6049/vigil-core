import { createApi } from './api.js';
import { createStore } from './store.js';
import { clearSession, decodeExp, loadSession, saveSession } from './session.js';
import { startStream } from './stream.js';
import { html, setHtml } from './util.js';
import { createLoginView } from './views/login.js';
import { createOverviewView } from './views/overview.js';
import { createLiveView } from './views/live.js';
import { createQueueView } from './views/queue.js';
import { createCaseView } from './views/caseDetail.js';
import { createGeographyView } from './views/geography.js';
import { createMerchantsView } from './views/merchants.js';
import { createModelView } from './views/model.js';
import { createRulesView } from './views/rules.js';
import { createAuditView } from './views/audit.js';

/* ---------- state ---------- */
const store = createStore({
  user: null,
  token: null,
  route: { name: 'login', id: null, query: {} },
  streamStatus: 'off',
  liveTxns: [], // newest first, fed by the initial load and by SSE
  queueTick: 0, // bumped whenever the case queue may have changed
  toast: null,
});

let streamHandle = null;
let expiryTimer = null;

const api = createApi({
  getToken: () => store.get().token,
  onUnauthorized: () => signOut('Your session expired. Please sign in again.'),
});

function toast(message, kind = 'info') {
  store.set({ toast: { id: Date.now(), message, kind } });
}

function navigate(path) {
  location.hash = `#${path}`;
}

/* ---------- auth lifecycle ---------- */
function signIn(token, user) {
  saveSession(token, user);
  store.set({ token, user, liveTxns: [] });
  armExpiry(token);
  streamHandle?.stop();
  streamHandle = startStream({
    getToken: () => store.get().token,
    onStatus: (streamStatus) => store.set({ streamStatus }),
    onEvent: handleStreamEvent,
  });
}

function signOut(message) {
  streamHandle?.stop();
  streamHandle = null;
  clearTimeout(expiryTimer);
  clearSession();
  store.set({ token: null, user: null, liveTxns: [], streamStatus: 'off' });
  if (message) toast(message, 'error');
  navigate('/login');
}

function armExpiry(token) {
  clearTimeout(expiryTimer);
  const ms = decodeExp(token) - Date.now();
  if (ms > 0) expiryTimer = setTimeout(() => signOut('Your session expired. Please sign in again.'), Math.min(ms, 2 ** 31 - 1));
}

function handleStreamEvent(event, data) {
  if (event === 'txn.new') {
    const cur = store.get().liveTxns;
    if (cur.some((t) => t.id === data.id)) return;
    store.set({ liveTxns: [data, ...cur].slice(0, 600) });
  } else if (event === 'txn.flagged' || event === 'case.updated') {
    store.set({ queueTick: store.get().queueTick + 1 });
  }
}

/* ---------- routing ---------- */
const ADMIN_ONLY = new Set(['rules', 'audit']);

function parseHash(hash) {
  const [path, query = ''] = hash.replace(/^#/, '').split('?');
  const parts = path.split('/').filter(Boolean);
  return { name: parts[0] ?? 'overview', id: parts[1] ? Number(parts[1]) : null, query: Object.fromEntries(new URLSearchParams(query)) };
}

const NAV = [
  { name: 'overview', label: 'Overview' },
  { name: 'live', label: 'Live stream' },
  { name: 'cases', label: 'Cases' },
  { name: 'geography', label: 'Geography' },
  { name: 'merchants', label: 'Merchants' },
  { name: 'model', label: 'Model health' },
];
const NAV_ADMIN = [
  { name: 'rules', label: 'Rules' },
  { name: 'audit', label: 'Audit log' },
];

const app = document.getElementById('app');
const toastEl = document.getElementById('toast');
let currentView = null;
let shellFor = null; // 'login' | user id: avoids rebuilding the shell on every route change

function viewFor(route) {
  const deps = { store, api, navigate, toast, route };
  switch (route.name) {
    case 'login': return createLoginView(deps, { signIn });
    case 'live': return createLiveView(deps);
    case 'cases': return route.id ? createCaseView(deps) : createQueueView(deps);
    case 'geography': return createGeographyView(deps);
    case 'merchants': return createMerchantsView(deps);
    case 'model': return createModelView(deps);
    case 'rules': return createRulesView(deps);
    case 'audit': return createAuditView(deps);
    default: return createOverviewView(deps);
  }
}

function renderShell(user) {
  const links = (items) =>
    items.map((n) => html`<a href="#/${n.name}" data-nav="${n.name}">${n.label}</a>`);
  setHtml(
    app,
    html`<div class="shell">
      <nav class="side" aria-label="Main">
        <div class="brand">Vigil<span class="dot">.</span></div>
        <div class="nav">
          ${links(NAV)}
          ${user.role === 'admin' ? html`<div class="group">Admin</div>${links(NAV_ADMIN)}` : ''}
        </div>
        <div class="side-foot">
          <div class="stream-state"><span class="stream-dot" id="stream-dot"></span><span id="stream-label">Offline</span></div>
          <div class="who">${user.name}</div>
          <div>${user.role} · <button class="linkbtn" id="signout">Sign out</button></div>
        </div>
      </nav>
      <main id="view" tabindex="-1"></main>
    </div>`,
  );
  document.getElementById('signout').addEventListener('click', () => signOut());
}

function updateNavState() {
  const { route, streamStatus } = store.get();
  document.querySelectorAll('[data-nav]').forEach((a) => {
    const active = a.dataset.nav === route.name;
    a.classList.toggle('active', active);
    if (active) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });
  const dot = document.getElementById('stream-dot');
  const label = document.getElementById('stream-label');
  if (dot && label) {
    dot.classList.toggle('live', streamStatus === 'live');
    label.textContent = { live: 'Live', connecting: 'Connecting…', reconnecting: 'Reconnecting…', off: 'Offline' }[streamStatus];
  }
}

function mountRoute() {
  const { user } = store.get();
  let route = parseHash(location.hash);

  if (!user && route.name !== 'login') return navigate('/login');
  if (user && route.name === 'login') return navigate('/overview');
  if (user && ADMIN_ONLY.has(route.name) && user.role !== 'admin') {
    toast('That page is for admins.', 'error');
    return navigate('/overview');
  }
  route = { ...route, name: route.name };

  currentView?.destroy?.();
  currentView = null;

  const shellKey = user ? user.id : 'login';
  if (shellFor !== shellKey) {
    if (user) renderShell(user);
    else setHtml(app, html`<div id="view"></div>`);
    shellFor = shellKey;
  }

  store.set({ route });
  const container = document.getElementById('view');
  container.scrollTop = 0;
  window.scrollTo(0, 0);
  currentView = viewFor(route);
  currentView.mount(container);
  currentView.render(store.get(), ['*']);
  updateNavState();
  document.title = `${route.name === 'login' ? 'Sign in' : route.name[0].toUpperCase() + route.name.slice(1)} · Vigil.`;
}

/* ---------- reactive wiring ---------- */
store.subscribe((state, changed) => {
  if (changed.includes('toast') && state.toast) {
    const { id, message, kind } = state.toast;
    setHtml(toastEl, html`<div class="t ${kind}">${message}</div>`);
    setTimeout(() => {
      if (store.get().toast?.id === id) toastEl.textContent = '';
    }, 4500);
  }
  if (changed.includes('streamStatus')) updateNavState();
  currentView?.render(state, changed);
});

window.addEventListener('hashchange', mountRoute);

/* ---------- boot ---------- */
await document.fonts.ready.catch(() => {});
const session = loadSession();
if (session) {
  signIn(session.token, session.user);
}
if (!location.hash) location.hash = session ? '#/overview' : '#/login';
mountRoute();
