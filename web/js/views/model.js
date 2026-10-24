import { chartBase, COLORS, html, loadCanvasJS, setHtml } from '../util.js';

export function createModelView({ api, toast }) {
  let root, destroyed = false;

  async function load() {
    try {
      const r = await api.get('/model/metrics');
      if (destroyed) return;
      await paint(r.items);
    } catch (e) {
      if (!destroyed) toast(e.message, 'error');
    }
  }

  async function paint(items) {
    const host = root.querySelector('#model-chart');
    if (!items.length) {
      setHtml(host, html`<div class="empty">No model metrics yet. They appear once the scoring service (vigil-ml) publishes daily precision, recall and drift figures.</div>`);
      root.querySelector('#model-meta').textContent = '';
      return;
    }
    const CanvasJS = await loadCanvasJS();
    if (destroyed) return;
    host.textContent = '';
    const axis = chartBase()._axis;
    const pts = (key) => items.filter((i) => i[key] !== null).map((i) => ({ x: new Date(i.day), y: i[key] }));
    new CanvasJS.Chart(host, {
      ...chartBase(),
      axisX: { ...axis, valueFormatString: 'DD MMM', gridThickness: 0 },
      axisY: { ...axis, title: 'Precision and recall', minimum: 0, maximum: 1, interval: 0.25, gridThickness: 1 },
      axisY2: { ...axis, title: 'Drift (PSI)', minimum: 0, gridThickness: 0, stripLines: [{ value: 0.2, color: COLORS.accent, thickness: 1, labelFontColor: COLORS.accent, labelFontSize: 10, label: 'PSI 0.2: investigate', labelAlign: 'near' }] },
      legend: { ...chartBase().legend, verticalAlign: 'top', horizontalAlign: 'left' },
      data: [
        { type: 'line', name: 'Precision', showInLegend: true, color: COLORS.text, lineThickness: 2, markerType: 'none', dataPoints: pts('precision_at_t') },
        { type: 'line', name: 'Recall', showInLegend: true, color: COLORS.g5, lineThickness: 2, markerType: 'none', lineDashType: 'dash', dataPoints: pts('recall_at_t') },
        { type: 'line', axisYType: 'secondary', name: 'PSI (score)', showInLegend: true, color: COLORS.accent, lineThickness: 2, markerType: 'none', dataPoints: pts('psi_score') },
        { type: 'line', axisYType: 'secondary', name: 'PSI (amount)', showInLegend: true, color: COLORS.g4, lineThickness: 1, markerType: 'none', dataPoints: pts('psi_amount') },
      ],
    }).render();
    const latest = items[items.length - 1];
    root.querySelector('#model-meta').textContent = `Latest: ${latest.model_version} on ${latest.day}`;
  }

  return {
    mount(el) {
      root = el;
      setHtml(
        root,
        html`<div class="page-head"><h1>Model health</h1><span class="sub" id="model-meta"></span></div>
          <div class="section"><div id="model-chart" class="chart" style="height:380px"></div>
            <p class="note">Precision and recall use delayed ground-truth labels, so recent days fill in over time. PSI measures how far today's inputs and scores have drifted from training; above about 0.2 usually means the model needs a look. Simulated data.</p></div>`,
      );
      load();
    },
    render() {},
    destroy() {
      destroyed = true;
    },
  };
}
