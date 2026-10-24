import { chartBase, COLORS, fmtInt, html, loadCanvasJS, setHtml } from '../util.js';

export function createMerchantsView({ api, toast }) {
  let root, range = '7d', destroyed = false;

  async function load() {
    try {
      const r = await api.get(`/stats/merchants?range=${range}`);
      if (destroyed) return;
      await paint(r.items);
    } catch (e) {
      if (!destroyed) toast(e.message, 'error');
    }
  }

  async function paint(items) {
    const host = root.querySelector('#merchant-chart');
    const table = root.querySelector('#merchant-table');
    if (!items.length) {
      setHtml(host, html`<div class="empty">No merchant transactions in this range.</div>`);
      table.textContent = '';
      return;
    }
    const CanvasJS = await loadCanvasJS();
    if (destroyed) return;
    host.textContent = '';
    host.style.height = `${Math.max(240, items.length * 44 + 60)}px`;
    const axis = chartBase()._axis;
    // CanvasJS draws bar charts bottom-up, so reverse to put the highest rate on top.
    const sorted = [...items].sort((a, b) => a.flag_rate - b.flag_rate);
    new CanvasJS.Chart(host, {
      ...chartBase(),
      axisX: { ...axis, gridThickness: 0, interval: 1 },
      axisY: { ...axis, title: 'Flag rate (%)', minimum: 0, suffix: '%', gridThickness: 1 },
      toolTip: { ...chartBase().toolTip, shared: false },
      data: [{
        type: 'bar',
        color: COLORS.g5,
        indexLabel: '{y}%',
        indexLabelFontColor: COLORS.text,
        indexLabelFontFamily: 'JetBrains Mono, monospace',
        indexLabelFontSize: 11,
        yValueFormatString: '0.0',
        dataPoints: sorted.map((m) => ({ label: m.category, y: Math.round(m.flag_rate * 1000) / 10, toolTipContent: `${m.category}: {y}% flagged (${m.flagged_count} of ${m.txn_count})` })),
      }],
    }).render();

    setHtml(
      table,
      html`<div class="table-wrap"><table><thead><tr><th>Category</th><th class="num">Transactions</th><th class="num">Flagged</th><th class="num">Flag rate</th><th class="num">Confirmed fraud</th></tr></thead><tbody>
        ${items.map((m) => html`<tr><td>${m.category}</td><td class="mono num">${fmtInt(m.txn_count)}</td><td class="mono num">${fmtInt(m.flagged_count)}</td><td class="mono num">${(m.flag_rate * 100).toFixed(1)}%</td><td class="mono num">${fmtInt(m.confirmed_fraud_count)}</td></tr>`)}
      </tbody></table></div>`,
    );
  }

  return {
    mount(el) {
      root = el;
      setHtml(
        root,
        html`<div class="page-head"><h1>Merchant categories</h1>
            <div class="seg" role="group" aria-label="Range">${['24h', '7d', '30d'].map((r) => html`<button data-range="${r}" class="${r === range ? 'on' : ''}">${r}</button>`)}</div></div>
          <div class="section"><div id="merchant-chart" class="chart"></div></div>
          <div class="section"><h2>Detail</h2><div id="merchant-table"></div>
            <p class="note">Flag rate is the share of payments to each category that were flagged. Confirmed fraud comes from delayed labels, so it trails. Simulated data.</p></div>`,
      );
      root.querySelectorAll('[data-range]').forEach((b) =>
        b.addEventListener('click', () => {
          range = b.dataset.range;
          root.querySelectorAll('[data-range]').forEach((x) => x.classList.toggle('on', x === b));
          load();
        }),
      );
      load();
    },
    render() {},
    destroy() {
      destroyed = true;
    },
  };
}
