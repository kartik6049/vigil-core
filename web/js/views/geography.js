import { CONFIG } from '../../config.js';
import { COLORS, fmtInt, html, loadD3, rafBatch, setHtml, setupCanvas } from '../util.js';

/** Longitude, latitude of the cities used by the simulator. Unknown cities are listed but not plotted. */
const CITY_COORDS = {
  Mumbai: [72.8777, 19.076], Delhi: [77.1025, 28.7041], Bengaluru: [77.5946, 12.9716], Hyderabad: [78.4867, 17.385],
  Chennai: [80.2707, 13.0827], Kolkata: [88.3639, 22.5726], Pune: [73.8567, 18.5204], Ahmedabad: [72.5714, 23.0225],
  Jaipur: [75.7873, 26.9124], Surat: [72.8311, 21.1702], Lucknow: [80.9462, 26.8467], Kochi: [76.2673, 9.9312],
  Indore: [75.8577, 22.7196], Chandigarh: [76.7794, 30.7333], Nagpur: [79.0882, 21.1458],
};
// Frame used when the outline file is missing: a box around India.
const FALLBACK_BOX = { type: 'Feature', geometry: { type: 'Polygon', coordinates: [[[68, 6], [98, 6], [98, 36], [68, 36], [68, 6]]] } };

/** Every ring of any GeoJSON object, as arrays of [lon, lat]. */
function ringsOf(g) {
  if (!g) return [];
  switch (g.type) {
    case 'FeatureCollection': return g.features.flatMap(ringsOf);
    case 'Feature': return ringsOf(g.geometry);
    case 'GeometryCollection': return g.geometries.flatMap(ringsOf);
    case 'Polygon': return g.coordinates;
    case 'MultiPolygon': return g.coordinates.flat();
    default: return [];
  }
}

export function createGeographyView({ api, toast }) {
  let root, canvas, d3, geo = null, outlineLoaded = false, cities = [], range = '24h', resizeObs, destroyed = false, active = null;
  let dots = [];
  const schedule = rafBatch(draw);

  async function loadOutline() {
    try {
      const res = await fetch(CONFIG.INDIA_GEOJSON);
      if (!res.ok) throw new Error('missing');
      geo = await res.json();
      outlineLoaded = true;
    } catch {
      geo = FALLBACK_BOX;
      outlineLoaded = false;
    }
  }

  async function loadCities() {
    try {
      const r = await api.get(`/stats/cities?range=${range}`);
      if (destroyed) return;
      cities = r.items;
      paintList();
      schedule();
    } catch (e) {
      if (!destroyed) toast(e.message, 'error');
    }
  }

  function draw() {
    if (destroyed || !canvas || !d3 || !geo) return;
    const { ctx, w, h } = setupCanvas(canvas);
    ctx.clearRect(0, 0, w, h);
    // Fit and draw by hand instead of d3.geoPath: d3 reads the winding direction of a polygon as
    // "inside vs outside", so a file wound the other way is read as "the whole globe except India".
    const base = d3.geoMercator().scale(1).translate([0, 0]);
    const rings = ringsOf(outlineLoaded ? geo : FALLBACK_BOX).map((r) => r.map((pt) => base(pt)).filter(Boolean));
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const r of rings) for (const [x, y] of r) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
    const pad = 20;
    const k = Math.min((w - 2 * pad) / (x1 - x0), (h - 2 * pad) / (y1 - y0));
    const ox = (w - (x1 - x0) * k) / 2, oy = (h - (y1 - y0) * k) / 2;
    const projection = (ll) => {
      const q = base(ll);
      return q && [ox + (q[0] - x0) * k, oy + (q[1] - y0) * k];
    };

    ctx.beginPath();
    for (const r of rings) {
      r.forEach(([x, y], i) => {
        const px = ox + (x - x0) * k, py = oy + (y - y0) * k;
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      });
      ctx.closePath();
    }
    ctx.fillStyle = COLORS.g1;
    ctx.fill('evenodd');
    ctx.strokeStyle = outlineLoaded ? COLORS.g3 : COLORS.g2;
    ctx.lineWidth = 1;
    ctx.stroke();

    const max = Math.max(1, ...cities.map((c) => c.flagged_count));
    const r = d3.scaleSqrt().domain([0, max]).range([4, Math.min(34, w / 12)]);
    dots = [];
    for (const c of cities) {
      const xy = CITY_COORDS[c.city] && projection(CITY_COORDS[c.city]);
      if (!xy) continue;
      const radius = r(c.flagged_count);
      ctx.beginPath();
      ctx.arc(xy[0], xy[1], radius, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(229,72,77,0.28)';
      ctx.fill();
      ctx.strokeStyle = COLORS.accent;
      ctx.lineWidth = active === c.city ? 2.5 : 1;
      ctx.stroke();
      dots.push({ city: c, x: xy[0], y: xy[1], r: radius });
    }
    ctx.font = '11px "JetBrains Mono", monospace';
    ctx.fillStyle = COLORS.g5;
    ctx.textAlign = 'left';
    for (const d of dots) ctx.fillText(d.city.city, d.x + d.r + 6, d.y + 4);
  }

  function paintList() {
    const body = root.querySelector('#geo-list');
    setHtml(
      body,
      cities.length
        ? html`<div class="table-wrap"><table><thead><tr><th>City</th><th class="num">Flagged</th><th class="num">Blocked</th><th class="num">Transactions</th></tr></thead><tbody>
          ${cities.map((c) => html`<tr><td>${c.city}${CITY_COORDS[c.city] ? '' : html` <span class="muted">(not plotted)</span>`}</td><td class="mono num">${fmtInt(c.flagged_count)}</td><td class="mono num">${fmtInt(c.blocked_count)}</td><td class="mono num">${fmtInt(c.txn_count)}</td></tr>`)}
          </tbody></table></div>`
        : html`<div class="empty">No flagged transactions in this range.</div>`,
    );
    root.querySelector('#geo-note').textContent = outlineLoaded
      ? ''
      : 'The India outline file is not installed, so a plain frame is shown. See web/data/README.md.';
  }

  return {
    async mount(el) {
      root = el;
      setHtml(
        root,
        html`<div class="page-head"><h1>Geography</h1>
            <div class="seg" role="group" aria-label="Range">${['1h', '24h', '7d'].map((r) => html`<button data-range="${r}" class="${r === range ? 'on' : ''}">${r}</button>`)}</div></div>
          <canvas class="geo" id="geo-canvas" role="img" aria-label="Map of India with circles sized by flagged transactions per city"></canvas>
          <p class="note" id="geo-note"></p>
          <p class="note">Boundaries: DataMeet, following the Survey of India depiction. Circle area is proportional to flagged transactions. Simulated data.</p>
          <div class="section" style="margin-top:28px"><h2>Flagged by city</h2><div id="geo-list"></div></div>`,
      );
      canvas = root.querySelector('#geo-canvas');
      root.querySelectorAll('[data-range]').forEach((b) =>
        b.addEventListener('click', () => {
          range = b.dataset.range;
          root.querySelectorAll('[data-range]').forEach((x) => x.classList.toggle('on', x === b));
          loadCities();
        }),
      );
      const pick = (ev) => {
        const rect = canvas.getBoundingClientRect();
        const mx = ev.clientX - rect.left, my = ev.clientY - rect.top;
        const hit = dots.find((d) => (d.x - mx) ** 2 + (d.y - my) ** 2 <= (d.r + 4) ** 2);
        active = hit ? hit.city.city : null;
        canvas.title = hit ? `${hit.city.city}: ${hit.city.flagged_count} flagged` : '';
        schedule();
      };
      canvas.addEventListener('pointermove', (ev) => ev.pointerType === 'mouse' && pick(ev));
      canvas.addEventListener('click', pick);

      [d3] = await Promise.all([loadD3(), loadOutline()]);
      if (destroyed) return;
      await document.fonts.ready;
      resizeObs = new ResizeObserver(schedule);
      resizeObs.observe(canvas);
      await loadCities();
      schedule();
    },
    render() {},
    destroy() {
      destroyed = true;
      resizeObs?.disconnect();
    },
  };
}
