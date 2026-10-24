import { ago, fmtINR, html, qs, setHtml, throttle } from '../util.js';

const STATUSES = [
  ['active', 'Active'],
  ['open', 'Open'],
  ['in_review', 'In review'],
  ['blocked', 'Blocked'],
  ['cleared', 'Cleared'],
];

/** Short reason badges: rule names first (they are the clearest), then top model features. */
function reasonBadges(reasons) {
  const rules = reasons.filter((r) => r.source === 'rule').map((r) => r.rule);
  const system = reasons.filter((r) => r.source === 'system').map((r) => r.feature);
  const model = reasons.filter((r) => r.source === 'model').slice(0, 2).map((r) => r.feature);
  const all = [...rules, ...system, ...model];
  const shown = all.slice(0, 3);
  return html`${shown.map((b) => html`<span class="badge">${b}</span>`)}${all.length > 3 ? html`<span class="badge">+${all.length - 3}</span>` : ''}`;
}

export function createQueueView({ store, api, navigate, toast }) {
  let root;
  let cases = [];
  let cursor = null;
  let selected = 0;
  let filters = { status: 'active', priority: '' };
  let loading = false;
  let destroyed = false;
  let ageTimer;
  let lastTick = store.get().queueTick;

  const me = () => store.get().user;
  const canAct = () => me()?.role === 'analyst';

  async function load({ append = false } = {}) {
    if (loading) return;
    loading = true;
    try {
      const r = await api.get(`/cases${qs({ status: filters.status, priority: filters.priority, limit: 50, cursor: append ? cursor : '' })}`);
      if (destroyed) return;
      cases = append ? [...cases, ...r.items] : r.items;
      cursor = r.next_cursor;
      selected = Math.min(selected, Math.max(cases.length - 1, 0));
      paint();
    } catch (e) {
      if (!destroyed) toast(e.message, 'error');
    } finally {
      loading = false;
    }
  }
  const reloadSoon = throttle(() => load(), 1500);

  function paint() {
    const now = Date.now();
    const rows = cases.map((c, i) => {
      const t = c.transaction;
      const mine = c.assigned_to === me()?.id;
      return html`<tr class="row${i === selected ? ' sel' : ''}" data-i="${i}" data-id="${c.id}">
        <td><span class="badge${c.priority === 1 ? ' p1' : ''}">P${c.priority}</span></td>
        <td class="mono muted">${ago(c.opened_at, now)}</td>
        <td class="mono num">${fmtINR(t.amount)}</td>
        <td>${reasonBadges(t.reasons)}</td>
        <td>${c.status === 'open' ? html`<span class="muted">open</span>` : html`${c.status.replace('_', ' ')}${c.assigned_to_name ? html` <span class="muted">· ${mine ? 'you' : c.assigned_to_name}</span>` : ''}`}</td>
        <td class="num">${canAct() && c.status === 'open' ? html`<button class="btn sm" data-claim="${c.id}">Claim</button>` : ''}</td>
      </tr>`;
    });
    setHtml(
      root.querySelector('#queue-body'),
      cases.length
        ? html`<div class="table-wrap"><table>
            <thead><tr><th>Priority</th><th>Age</th><th class="num">Amount</th><th>Reasons</th><th>Status</th><th></th></tr></thead>
            <tbody>${rows}</tbody></table></div>
            ${cursor ? html`<div style="margin-top:16px"><button class="btn" id="more">Load more</button></div>` : ''}`
        : html`<div class="empty">${loading ? 'Loading…' : 'No cases match. New flagged transactions appear here automatically.'}</div>`,
    );
    root.querySelector('#more')?.addEventListener('click', () => load({ append: true }));
    root.querySelector('#queue-count').textContent = `${cases.length}${cursor ? '+' : ''} case${cases.length === 1 ? '' : 's'}`;
  }

  async function claimNext() {
    try {
      const c = await api.post('/cases/next');
      toast(`Claimed case #${c.id}`);
      navigate(`/cases/${c.id}`);
    } catch (e) {
      toast(e.code === 'no_open_cases' ? 'Queue is empty. Nothing to claim.' : e.message, e.code === 'no_open_cases' ? 'info' : 'error');
    }
  }

  async function claim(id) {
    try {
      await api.post(`/cases/${id}/claim`);
      toast(`Claimed case #${id}`);
      await load();
    } catch (e) {
      toast(e.message, 'error');
      if (e.status === 409) load();
    }
  }

  function onKey(ev) {
    if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(ev.target.tagName)) return;
    const key = ev.key.toLowerCase();
    const c = cases[selected];
    if (key === 'j' || key === 'k') {
      selected = Math.max(0, Math.min(cases.length - 1, selected + (key === 'j' ? 1 : -1)));
      paint();
      root.querySelector('tr.sel')?.scrollIntoView({ block: 'nearest' });
    } else if (key === 'enter' && c) {
      navigate(`/cases/${c.id}`);
    } else if (key === 'c' && c && canAct()) {
      if (c.status === 'open') claim(c.id);
      else toast('Only open cases can be claimed.');
    } else if ((key === 'b' || key === 'l') && c) {
      // Blocking and clearing need a note and a confirmation, so shortcuts open the case with the decision ready.
      navigate(`/cases/${c.id}?resolve=${key === 'b' ? 'blocked' : 'cleared'}`);
    }
  }

  return {
    mount(el) {
      root = el;
      setHtml(
        root,
        html`<div class="page-head"><h1>Cases</h1><div class="btn-row"><span class="sub" id="queue-count"></span>
            ${canAct() ? html`<button class="btn primary" id="claim-next">Claim next</button>` : ''}</div></div>
          <div class="filters">
            <div class="f"><label for="f-status">Status</label><select id="f-status">${STATUSES.map(([v, l]) => html`<option value="${v}">${l}</option>`)}</select></div>
            <div class="f"><label for="f-priority">Priority</label><select id="f-priority"><option value="">All</option><option value="1">P1</option><option value="2">P2</option></select></div>
          </div>
          <div id="queue-body"></div>
          <p class="note hover-only"><kbd>J</kbd>/<kbd>K</kbd> move · <kbd>Enter</kbd> open · <kbd>C</kbd> claim · <kbd>B</kbd> block · <kbd>L</kbd> clear</p>`,
      );
      root.querySelector('#claim-next')?.addEventListener('click', claimNext);
      root.querySelector('#f-status').addEventListener('change', (e) => {
        filters.status = e.target.value;
        selected = 0;
        load();
      });
      root.querySelector('#f-priority').addEventListener('change', (e) => {
        filters.priority = e.target.value;
        selected = 0;
        load();
      });
      root.querySelector('#queue-body').addEventListener('click', (ev) => {
        const claimBtn = ev.target.closest('[data-claim]');
        if (claimBtn) return claim(Number(claimBtn.dataset.claim));
        const row = ev.target.closest('tr.row');
        if (row) navigate(`/cases/${row.dataset.id}`);
      });
      document.addEventListener('keydown', onKey);
      ageTimer = setInterval(() => cases.length && paint(), 30_000);
      load();
    },
    render(state, changed) {
      // Live updates can arrive in bursts; refresh the list at most every 1.5 s.
      if (changed.includes('queueTick') && state.queueTick !== lastTick) {
        lastTick = state.queueTick;
        reloadSoon();
      }
    },
    destroy() {
      destroyed = true;
      document.removeEventListener('keydown', onKey);
      clearInterval(ageTimer);
    },
  };
}
