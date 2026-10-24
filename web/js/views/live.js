import { BAND_COLOR, COLORS, fmtDateTime, fmtINR, html, loadD3, rafBatch, setHtml, setupCanvas } from '../util.js';

const WINDOW_MS = 30 * 60 * 1000; // the chart shows the last 30 minutes
const M = { top: 16, right: 16, bottom: 30, left: 44 };

export function createLiveView({ store, api, navigate, toast }) {
  let root, canvas, detail, d3, resizeObs, tick;
  let pts = []; // screen positions of drawn dots, for hit-testing
  let hover = null;
  let destroyed = false;

  const schedule = rafBatch(draw);

  function draw() {
    if (destroyed || !canvas || !d3) return;
    const { ctx, w, h } = setupCanvas(canvas);
    const now = Date.now();
    const x = d3.scaleTime().domain([new Date(now - WINDOW_MS), new Date(now)]).range([M.left, w - M.right]);
    const y = d3.scaleLinear().domain([0, 1]).range([h - M.bottom, M.top]);

    ctx.clearRect(0, 0, w, h);
    ctx.font = '10px "JetBrains Mono", monospace';
    ctx.textBaseline = 'middle';

    // horizontal guides at the band edges
    for (const v of [0, 0.3, 0.7, 1]) {
      ctx.strokeStyle = v === 0.7 ? 'rgba(229,72,77,0.55)' : COLORS.g2;
      ctx.setLineDash(v === 0.7 ? [4, 4] : []);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(M.left, Math.round(y(v)) + 0.5);
      ctx.lineTo(w - M.right, Math.round(y(v)) + 0.5);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = COLORS.g4;
      ctx.textAlign = 'right';
      ctx.fillText(v.toFixed(2), M.left - 8, y(v));
    }
    // time ticks every 5 minutes
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    for (const t of x.ticks(d3.timeMinute.every(5))) {
      ctx.fillStyle = COLORS.g4;
      ctx.fillText(d3.timeFormat('%H:%M')(t), x(t), h - 10);
    }

    pts = [];
    const { liveTxns } = store.get();
    // draw low first so high-risk dots sit on top
    const visible = liveTxns
      .map((t) => ({ t, ts: Date.parse(t.created_at) }))
      .filter((d) => d.ts >= now - WINDOW_MS && d.ts <= now + 60_000)
      .sort((a, b) => ({ low: 0, medium: 1, high: 2 }[a.t.risk_band] ?? -1) - ({ low: 0, medium: 1, high: 2 }[b.t.risk_band] ?? -1));

    for (const { t, ts } of visible) {
      const cx = Math.min(x(new Date(ts)), w - M.right);
      const known = t.risk_score !== null;
      const cy = y(known ? t.risk_score : 0);
      const r = t.risk_band === 'high' ? 5 : 3.5;
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      if (known) {
        ctx.fillStyle = BAND_COLOR[t.risk_band] ?? COLORS.g3;
        ctx.fill();
      } else {
        // model unavailable: hollow ring on the baseline
        ctx.strokeStyle = COLORS.g5;
        ctx.lineWidth = 1;
        ctx.stroke();
      }
      pts.push({ t, cx, cy });
    }
    if (hover) {
      const p = pts.find((q) => q.t.id === hover);
      if (p) {
        ctx.strokeStyle = COLORS.text;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(p.cx, p.cy, 9, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
    paintStatus();
  }

  function paintStatus() {
    const n = pts.length;
    const el = root.querySelector('#live-count');
    if (el) el.textContent = `${n} transaction${n === 1 ? '' : 's'} in the last 30 minutes`;
  }

  function nearest(ev) {
    const rect = canvas.getBoundingClientRect();
    const mx = ev.clientX - rect.left;
    const my = ev.clientY - rect.top;
    let best = null;
    let bestD = 16 * 16;
    for (const p of pts) {
      const d = (p.cx - mx) ** 2 + (p.cy - my) ** 2;
      if (d <= bestD) {
        best = p;
        bestD = d;
      }
    }
    return best;
  }

  function showDetail(p) {
    hover = p ? p.t.id : null;
    if (!p) {
      setHtml(detail, html`<span class="muted">Hover a dot (or tap on a phone) for details.</span>`);
    } else {
      const t = p.t;
      setHtml(
        detail,
        html`<span class="mono">#${t.id}</span> · <span class="mono">${fmtINR(t.amount)}</span> · ${t.type} via ${t.channel} ·
          <span class="band ${t.risk_band ?? ''}">${t.risk_band ?? 'model unavailable'}${t.risk_score !== null ? ` ${t.risk_score.toFixed(2)}` : ''}</span> ·
          ${t.status} · <span class="muted">${fmtDateTime(t.created_at)}</span>
          ${t.status !== 'approved' ? html` · <button class="linkbtn" id="open-txn">Open case</button>` : ''}`,
      );
      detail.querySelector('#open-txn')?.addEventListener('click', () => openTxn(t.id));
    }
    schedule();
  }

  async function openTxn(id) {
    try {
      const d = await api.get(`/transactions/${id}`);
      if (d.case) navigate(`/cases/${d.case.id}`);
      else toast('This transaction was approved, so it has no case.');
    } catch (e) {
      toast(e.message, 'error');
    }
  }

  async function loadInitial() {
    if (store.get().liveTxns.length) return;
    try {
      const r = await api.get('/transactions?limit=200');
      if (!destroyed && store.get().liveTxns.length === 0) store.set({ liveTxns: r.items });
    } catch (e) {
      if (!destroyed) toast(e.message, 'error');
    }
  }

  return {
    async mount(el) {
      root = el;
      setHtml(
        root,
        html`<div class="page-head"><h1>Live stream</h1><span class="sub" id="live-count"></span></div>
          <canvas class="live" id="live-canvas" role="img" aria-label="Scatter plot of recent transactions: time against risk score"></canvas>
          <div class="legend">
            <span><i style="background:${BAND_COLOR.high}"></i>High (0.70+)</span>
            <span><i style="background:${BAND_COLOR.medium}"></i>Medium</span>
            <span><i style="background:${BAND_COLOR.low}"></i>Low</span>
            <span><i style="border:1px solid ${COLORS.g5}"></i>Model unavailable</span>
          </div>
          <div class="detail-line" id="live-detail"></div>
          <p class="note">New transactions appear as they arrive over a live connection. Simulated data.</p>`,
      );
      canvas = root.querySelector('#live-canvas');
      detail = root.querySelector('#live-detail');
      showDetail(null);

      d3 = await loadD3();
      if (destroyed) return;
      await document.fonts.ready;

      canvas.addEventListener('pointermove', (ev) => {
        if (ev.pointerType === 'mouse') showDetail(nearest(ev));
      });
      canvas.addEventListener('pointerleave', (ev) => {
        if (ev.pointerType === 'mouse') showDetail(null);
      });
      canvas.addEventListener('click', (ev) => showDetail(nearest(ev))); // tap on touch devices
      resizeObs = new ResizeObserver(schedule);
      resizeObs.observe(canvas);
      tick = setInterval(schedule, 1000); // slides the 30-minute window
      await loadInitial();
      schedule();
    },
    render(state, changed) {
      if (changed.includes('liveTxns') || changed.includes('*')) schedule();
    },
    destroy() {
      destroyed = true;
      clearInterval(tick);
      resizeObs?.disconnect();
    },
  };
}
