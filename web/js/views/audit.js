import { fmtDateTime, html, loadScript, qs, setHtml } from '../util.js';

const ENTITIES = ['', 'case', 'rule', 'account'];

const short = (obj) => {
  if (obj === null || obj === undefined) return '';
  const s = JSON.stringify(obj);
  return s.length > 140 ? `${s.slice(0, 137)}…` : s;
};

export function createAuditView({ api, toast }) {
  let root, items = [], cursor = null, entity = '', destroyed = false, googleReady = null;

  function loadGoogle() {
    if (!googleReady) {
      googleReady = loadScript('https://www.gstatic.com/charts/loader.js').then(
        () => new Promise((resolve) => {
          window.google.charts.load('current', { packages: ['table'] });
          window.google.charts.setOnLoadCallback(resolve);
        }),
      );
    }
    return googleReady;
  }

  async function load({ append = false } = {}) {
    try {
      const r = await api.get(`/audit${qs({ entity_type: entity, limit: 25, cursor: append ? cursor : '' })}`);
      if (destroyed) return;
      items = append ? [...items, ...r.items] : r.items;
      cursor = r.next_cursor;
      await paint();
    } catch (e) {
      if (!destroyed) toast(e.message, 'error');
    }
  }

  async function paint() {
    const host = root.querySelector('#audit-table');
    root.querySelector('#more').classList.toggle('hidden', !cursor);
    if (!items.length) {
      setHtml(host, html`<div class="empty">No audit entries yet.</div>`);
      return;
    }
    await loadGoogle();
    if (destroyed) return;
    const g = window.google.visualization;
    const data = new g.DataTable();
    ['When', 'Actor', 'Action', 'Entity', 'Before', 'After'].forEach((c) => data.addColumn('string', c));
    // Google's Table renders cells as text unless allowHtml is set, and we never set it.
    data.addRows(
      items.map((a) => [fmtDateTime(a.created_at), a.actor_email ?? 'system', a.action, `${a.entity_type} ${a.entity_id}`, short(a.before), short(a.after)]),
    );
    host.textContent = '';
    new g.Table(host).draw(data, {
      allowHtml: false,
      width: '100%',
      sort: 'disable',
      cssClassNames: { headerRow: 'gt-head', headerCell: 'gt-hcell', tableRow: 'gt-row', oddTableRow: 'gt-row', hoverTableRow: 'gt-hover', tableCell: 'gt-cell', selectedTableRow: 'gt-row' },
    });
  }

  return {
    mount(el) {
      root = el;
      setHtml(
        root,
        html`<div class="page-head"><h1>Audit log</h1><span class="sub">Append-only. Who did what, when, with before and after values.</span></div>
          <div class="filters"><div class="f"><label for="f-entity">Entity</label><select id="f-entity">${ENTITIES.map((e) => html`<option value="${e}">${e || 'All'}</option>`)}</select></div></div>
          <div class="table-wrap" id="audit-table"><div class="empty">Loading…</div></div>
          <div style="margin-top:16px"><button class="btn hidden" id="more">Load more</button></div>`,
      );
      root.querySelector('#f-entity').addEventListener('change', (e) => {
        entity = e.target.value;
        load();
      });
      root.querySelector('#more').addEventListener('click', () => load({ append: true }));
      load();
    },
    render() {},
    destroy() {
      destroyed = true;
    },
  };
}
