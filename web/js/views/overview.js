import { chartBase, COLORS, fmtDuration, fmtInt, fmtINRShort, html, loadCanvasJS, setHtml } from '../util.js';

const RANGES = [
  { key: '1h', label: '1h', ms: 3_600_000 },
  { key: '24h', label: '24h', ms: 86_400_000 },
  { key: '7d', label: '7d', ms: 7 * 86_400_000 },
];

export function createOverviewView({ store, api, toast }) {
  let root;
  let chart = null;
  let range = '24h';
  let destroyed = false;
  let refreshTimer;
  let data = { overview: null, hourly: null };

  async function load() {
    try {
      const { ms } = RANGES.find((r) => r.key === range);
      const [overview, hourly] = await Promise.all([
        api.get(`/stats/overview?range=${range}`),
        api.get(`/stats/hourly?from=${encodeURIComponent(new Date(Date.now() - ms).toISOString())}&to=${encodeURIComponent(new Date().toISOString())}`),
      ]);
      if (destroyed) return;
      data = { overview, hourly: hourly.items };
      paintKpis();
      await paintChart();
    } catch (e) {
      if (!destroyed) toast(e.message, 'error');
    }
  }

  function paintKpis() {
    const o = data.overview;
    const kpi = (label, value, accent = false) =>
      html`<div class="kpi"><div class="kpi-label">${label}</div><div class="kpi-value mono${accent ? ' accent' : ''}">${value}</div></div>`;
    setHtml(
      root.querySelector('#kpis'),
      html`${kpi('Transactions', fmtInt(o.txn_count))}${kpi('Flagged', fmtInt(o.flagged_count))}${kpi('Blocked amount', fmtINRShort(o.blocked_amount), Number(o.blocked_amount) > 0)}${kpi('Open cases', fmtInt(o.open_cases))}${kpi('Median time to resolve', fmtDuration(o.median_time_to_resolve_seconds))}`,
    );
  }

  async function paintChart() {
    const host = root.querySelector('#hourly-chart');
    const items = data.hourly ?? [];
    if (items.length === 0) {
      chart = null;
      setHtml(host, html`<div class="empty">No hourly data yet. The roll-up refreshes every 5 minutes once transactions arrive.</div>`);
      return;
    }
    const CanvasJS = await loadCanvasJS();
    if (destroyed) return;
    host.textContent = '';
    const axis = chartBase()._axis;
    const points = (key) => items.map((i) => ({ x: new Date(i.hour), y: i[key] }));
    chart = new CanvasJS.Chart(host, {
      ...chartBase(),
      axisX: { ...axis, valueFormatString: range === '7d' ? 'DD MMM' : 'HH:mm', gridThickness: 0 },
      axisY: { ...axis, gridThickness: 1, includeZero: true },
      legend: { ...chartBase().legend, verticalAlign: 'top', horizontalAlign: 'left' },
      data: [
        { type: 'line', name: 'Transactions', showInLegend: true, color: COLORS.g5, lineThickness: 2, markerType: 'circle', markerSize: 6, dataPoints: points('txn_count') },
        { type: 'line', name: 'Flagged', showInLegend: true, color: COLORS.accent, lineThickness: 2, markerType: 'circle', markerSize: 6, dataPoints: points('flagged_count') },
      ],
    });
    chart.render();
  }

  return {
    mount(el) {
      root = el;
      setHtml(
        root,
        html`<div class="page-head"><h1>Overview</h1>
            <div class="seg" role="group" aria-label="Range">${RANGES.map((r) => html`<button data-range="${r.key}" class="${r.key === range ? 'on' : ''}">${r.label}</button>`)}</div>
          </div>
          <div class="kpis" id="kpis">${[1, 2, 3, 4, 5].map(() => html`<div class="kpi"><div class="kpi-label">&nbsp;</div><div class="kpi-value mono muted">–</div></div>`)}</div>
          <div class="section"><h2>Transactions per hour</h2><div id="hourly-chart" class="chart"></div>
          <p class="note">Hourly figures come from a materialized view refreshed every 5 minutes, so the latest hour can lag. All data is simulated.</p></div>`,
      );
      root.querySelectorAll('[data-range]').forEach((b) =>
        b.addEventListener('click', () => {
          range = b.dataset.range;
          root.querySelectorAll('[data-range]').forEach((x) => x.classList.toggle('on', x === b));
          load();
        }),
      );
      load();
      refreshTimer = setInterval(load, 60_000);
    },
    render() {},
    destroy() {
      destroyed = true;
      clearInterval(refreshTimer);
      chart = null;
    },
  };
}
