import { html, setHtml } from '../util.js';

const LABELS = {
  velocity_5_in_10m: 'Velocity: many transactions from one account in a short window',
  new_city: 'New city: location differs from the last few transactions',
  amount_spike: 'Amount spike: far above the account\'s recent average',
  dormant_account: 'Dormant account: large transfer after a long quiet period',
};

export function createRulesView({ api, toast }) {
  let root, rules = [], destroyed = false;

  async function load() {
    try {
      const r = await api.get('/rules');
      if (destroyed) return;
      rules = r.items;
      paint();
    } catch (e) {
      if (!destroyed) toast(e.message, 'error');
    }
  }

  function paint() {
    setHtml(
      root.querySelector('#rules-body'),
      rules.length
        ? rules.map((r) => html`<div class="section" data-rule="${r.id}" style="border-top:1px solid var(--g2);padding-top:20px;margin-bottom:28px">
            <div style="display:flex;justify-content:space-between;gap:16px;flex-wrap:wrap;margin-bottom:12px">
              <div><div class="mono">${r.name}</div><div class="muted">${LABELS[r.name] ?? ''}</div></div>
              <label style="display:flex;gap:8px;align-items:center;margin:0;color:var(--text)"><input type="checkbox" data-enabled ${r.enabled ? 'checked' : ''} style="width:auto"> Enabled</label>
            </div>
            <div class="filters">${Object.entries(r.params).map(([k, v]) => html`<div class="f"><label>${k}</label><input type="number" step="any" data-param="${k}" value="${v}"></div>`)}</div>
            <div class="btn-row"><button class="btn sm" data-save>Save</button><span class="error-text" style="margin:0;min-height:0" role="alert"></span></div>
          </div>`)
        : html`<div class="empty">No rules found. Run the seed script.</div>`,
    );
  }

  async function save(card) {
    const id = Number(card.dataset.rule);
    const rule = rules.find((r) => r.id === id);
    const params = {};
    card.querySelectorAll('[data-param]').forEach((i) => {
      params[i.dataset.param] = Number(i.value);
    });
    const err = card.querySelector('.error-text');
    err.textContent = '';
    try {
      const updated = await api.patch(`/rules/${id}`, { enabled: card.querySelector('[data-enabled]').checked, params });
      Object.assign(rule, updated);
      toast(`Saved ${rule.name}. New transactions use it immediately.`);
      paint();
    } catch (e) {
      err.textContent = e.message;
    }
  }

  return {
    mount(el) {
      root = el;
      setHtml(
        root,
        html`<div class="page-head"><h1>Rules</h1><span class="sub">Admin only. Every change is written to the audit log.</span></div><div id="rules-body"><div class="empty">Loading…</div></div>`,
      );
      root.addEventListener('click', (ev) => {
        const btn = ev.target.closest('[data-save]');
        if (btn) save(btn.closest('[data-rule]'));
      });
      load();
    },
    render() {},
    destroy() {
      destroyed = true;
    },
  };
}
