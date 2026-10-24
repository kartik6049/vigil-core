/* Shared helpers: escaping, formatting, canvas setup, lazy script loading. */

export const COLORS = {
  bg: '#0D0E11',
  text: '#F4F4F2',
  g1: '#16181D',
  g2: '#23262D',
  g3: '#3A3E47',
  g4: '#6B707A',
  g5: '#A3A7AF',
  accent: '#E5484D',
};
export const BAND_COLOR = { high: COLORS.accent, medium: COLORS.g5, low: COLORS.g3 };

/* ---------- escaping ---------- */

export const esc = (v) =>
  String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** Marks a string as already-safe HTML. Only html`` produces these; never wrap user data in raw(). */
export class Raw {
  constructor(s) {
    this.s = s;
  }
  toString() {
    return this.s;
  }
}
export const raw = (s) => new Raw(s);

/**
 * Tagged template that escapes every interpolated value unless it is itself the result of html``.
 * This is how all text from the API reaches the DOM: escaping is the default, not something to remember.
 */
export function html(strings, ...vals) {
  const piece = (v) => (v instanceof Raw ? v.s : esc(v));
  let out = '';
  strings.forEach((s, i) => {
    out += s;
    if (i < vals.length) {
      const v = vals[i];
      out += Array.isArray(v) ? v.map(piece).join('') : piece(v);
    }
  });
  return new Raw(out);
}

export function setHtml(el, template) {
  // Accepts an html`` result or a list of them (for example rules.map(...)). Anything else is escaped as text.
  const one = (v) => (v instanceof Raw ? v.s : esc(v));
  el.innerHTML = Array.isArray(template) ? template.map(one).join('') : one(template);
}

/* ---------- formatting ---------- */

export const fmtInt = (n) => Number(n ?? 0).toLocaleString('en-IN');

export function fmtINR(amount) {
  const n = Number(amount);
  return '₹' + n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** Compact rupees using Indian units: 12,50,000 -> ₹12.5 L. */
export function fmtINRShort(amount) {
  const n = Number(amount);
  if (n >= 1e7) return `₹${(n / 1e7).toFixed(2)} Cr`;
  if (n >= 1e5) return `₹${(n / 1e5).toFixed(2)} L`;
  return '₹' + n.toLocaleString('en-IN', { maximumFractionDigits: 0 });
}

export function ago(iso, now = Date.now()) {
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

export function fmtDuration(seconds) {
  if (seconds === null || seconds === undefined) return '–';
  const s = Math.round(seconds);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  return `${(s / 3600).toFixed(1)}h`;
}

const timeFmt = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
export const fmtTime = (iso) => timeFmt.format(new Date(iso));
const dtFmt = new Intl.DateTimeFormat('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
export const fmtDateTime = (iso) => dtFmt.format(new Date(iso));

/* ---------- function helpers ---------- */

export function throttle(fn, ms) {
  let last = 0;
  let timer = null;
  return (...args) => {
    const wait = ms - (Date.now() - last);
    if (wait <= 0) {
      last = Date.now();
      fn(...args);
    } else if (!timer) {
      timer = setTimeout(() => {
        timer = null;
        last = Date.now();
        fn(...args);
      }, wait);
    }
  };
}

/** Collapses many calls in one frame into a single requestAnimationFrame callback. */
export function rafBatch(fn) {
  let queued = false;
  return () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      fn();
    });
  };
}

export const qs = (obj) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(obj)) if (v !== undefined && v !== null && v !== '') p.set(k, v);
  const s = p.toString();
  return s ? `?${s}` : '';
};

/* ---------- canvas ---------- */

/** Sizes the canvas backing store for devicePixelRatio and returns a CSS-pixel drawing context. */
export function setupCanvas(canvas) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  const bw = Math.round(w * dpr);
  const bh = Math.round(h * dpr);
  if (canvas.width !== bw || canvas.height !== bh) {
    canvas.width = bw;
    canvas.height = bh;
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, w, h };
}

/* ---------- lazy third-party scripts ---------- */

const scripts = new Map();
export function loadScript(url) {
  if (!scripts.has(url)) {
    scripts.set(
      url,
      new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = url;
        s.async = true;
        s.onload = resolve;
        s.onerror = () => {
          scripts.delete(url);
          reject(new Error(`Could not load ${url}`));
        };
        document.head.appendChild(s);
      }),
    );
  }
  return scripts.get(url);
}

export const loadD3 = () => loadScript('https://cdn.jsdelivr.net/npm/d3@7/dist/d3.min.js').then(() => window.d3);
export const loadCanvasJS = () => loadScript('https://cdn.canvasjs.com/canvasjs.min.js').then(() => window.CanvasJS);

/** Shared CanvasJS styling so every chart matches the dark, flat design. */
export function chartBase(extra = {}) {
  const font = { fontFamily: 'JetBrains Mono, monospace', fontSize: 11, fontColor: COLORS.g4 };
  return {
    animationEnabled: false,
    backgroundColor: 'transparent',
    theme: 'dark2',
    toolTip: { shared: true, backgroundColor: COLORS.g1, borderColor: COLORS.g3, fontColor: COLORS.text, cornerRadius: 0 },
    legend: { fontColor: COLORS.g5, fontFamily: 'Inter, sans-serif', fontSize: 12, cursor: 'pointer' },
    _axis: { labelFontColor: font.fontColor, labelFontFamily: font.fontFamily, labelFontSize: font.fontSize, lineColor: COLORS.g2, tickColor: COLORS.g2, gridColor: COLORS.g2, titleFontColor: COLORS.g4, titleFontFamily: 'Inter, sans-serif', titleFontSize: 12 },
    ...extra,
  };
}
