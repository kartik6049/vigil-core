import { BAND_COLOR, COLORS, ago, fmtDateTime, fmtINR, html, loadD3, setHtml } from '../util.js';

export function createCaseView({ store, api, navigate, toast, route }) {
  const id = route.id;
  let root;
  let c = null; // the case
  let txn = null; // transaction detail (accounts, reasons)
  let history = [];
  let pending = ['blocked', 'cleared'].includes(route.query.resolve) ? route.query.resolve : null;
  let note = '';
  let busy = false;
  let destroyed = false;

  const me = () => store.get().user;

  async function load() {
    try {
      c = await api.get(`/cases/${id}`);
      const [t, h, from, to] = await Promise.all([
        api.get(`/transactions/${c.transaction_id}`),
        api.get(`/accounts/${c.transaction.from_account_id}/transactions?limit=20`),
        api.get(`/accounts/${c.transaction.from_account_id}`),
        api.get(`/accounts/${c.transaction.to_account_id}`),
      ]);
      if (destroyed) return;
      txn = { ...t, from_account: from, to_account: to };
      history = h.items;
      await paint();
    } catch (e) {
      if (destroyed) return;
      toast(e.message, 'error');
      if (e.status === 404) navigate('/cases');
    }
  }

  /* ---------- reasons: model contributions as horizontal bars (D3), rules as a list ---------- */
  async function paintReasons() {
    const host = root.querySelector('#reason-bars');
    const model = txn.reasons.filter((r) => r.source === 'model').sort((a, b) => b.contribution - a.contribution);
    if (!model.length) {
      setHtml(host, html`<div class="empty">No model reasons${txn.reasons.some((r) => r.feature === 'model_unavailable') ? ': the model was unavailable for this transaction' : ''}.</div>`);
      return;
    }
    const d3 = await loadD3();
    if (destroyed) return;
    const W = 460, rowH = 30, labelW = 150, valueW = 48;
    const H = model.length * rowH + 4;
    const x = d3.scaleLinear().domain([0, Math.max(0.4, d3.max(model, (r) => r.contribution))]).range([0, W - labelW - valueW]);
    const svg = d3.create('svg').attr('viewBox', `0 0 ${W} ${H}`).attr('role', 'img').attr('aria-label', 'Model reasons by contribution');
    const g = svg.selectAll('g').data(model).join('g').attr('transform', (_, i) => `translate(0,${i * rowH + 2})`);
    g.append('text').attr('x', 0).attr('y', rowH / 2).attr('dominant-baseline', 'middle').attr('fill', COLORS.g5).attr('font-size', 12).attr('font-family', 'JetBrains Mono, monospace').text((r) => r.feature);
    g.append('rect').attr('x', labelW).attr('y', 8).attr('height', 12).attr('width', (r) => Math.max(2, x(r.contribution))).attr('fill', (_, i) => (i === 0 ? COLORS.accent : COLORS.g3));
    g.append('text').attr('x', (r) => labelW + Math.max(2, x(r.contribution)) + 8).attr('y', rowH / 2).attr('dominant-baseline', 'middle').attr('fill', COLORS.text).attr('font-size', 11).attr('font-family', 'JetBrains Mono, monospace').text((r) => r.contribution.toFixed(2));
    host.textContent = '';
    host.appendChild(svg.node());
  }

  function actionPanel() {
    const user = me();
    const mine = c.assigned_to === user.id;
    if (c.status === 'blocked' || c.status === 'cleared') {
      return html`<div class="panel"><div class="fact"><div class="k">Resolved ${c.status} ${c.resolved_at ? `· ${fmtDateTime(c.resolved_at)}` : ''}${c.assigned_to_name ? ` · by ${c.assigned_to_name}` : ''}</div>
        <div class="v">${c.resolution_note}</div></div></div>`;
    }
    if (user.role !== 'analyst') return html`<div class="panel muted">Admins can review cases but only analysts claim and resolve them.</div>`;
    if (c.status === 'open') {
      return html`<div class="panel"><div class="btn-row"><button class="btn primary" id="claim">Claim this case</button></div></div>`;
    }
    if (!mine) return html`<div class="panel muted">In review by ${c.assigned_to_name ?? 'another analyst'}.</div>`;

    const long = note.trim().length >= 3;
    return html`<div class="panel">
      <label for="note">Decision note (required)</label>
      <textarea id="note" maxlength="1000" placeholder="Why are you blocking or clearing this?">${note}</textarea>
      ${pending
        ? html`<div class="confirm ${pending === 'blocked' ? 'block' : ''}">
            ${pending === 'blocked'
              ? html`<strong>Block this case?</strong> The transaction is marked blocked and account <span class="mono">#${c.transaction.from_account_id}</span> (${txn.from_account.holder_name}) will be blocked.`
              : html`<strong>Clear this case?</strong> The transaction is released as legitimate. The account stays active.`}
            <div class="btn-row" style="margin-top:12px">
              <button class="btn ${pending === 'blocked' ? 'danger' : 'primary'}" id="confirm" ${long && !busy ? '' : 'disabled'}>${pending === 'blocked' ? 'Confirm block' : 'Confirm clear'}</button>
              <button class="btn" id="cancel">Cancel</button>
            </div>
            ${long ? '' : html`<div class="note">Write a note of at least 3 characters to continue.</div>`}
          </div>`
        : html`<div class="btn-row"><button class="btn danger" data-decide="blocked">Block…</button><button class="btn" data-decide="cleared">Clear…</button></div>`}
    </div>`;
  }

  async function paint() {
    const t = c.transaction;
    const ruleReasons = txn.reasons.filter((r) => r.source !== 'model');
    const cityMismatch = t.ip_city && t.ip_city !== txn.from_account.city;
    setHtml(
      root,
      html`<div class="page-head"><div><h1>Case #${c.id}</h1>
          <div class="sub"><span class="badge${c.priority === 1 ? ' p1' : ''}">P${c.priority}</span> ${c.status.replace('_', ' ')} · opened ${ago(c.opened_at)} ago · v${c.version}</div></div>
          <a class="linkbtn" href="#/cases">← Back to cases</a></div>

        <div class="section"><div class="facts">
          <div class="fact"><div class="k">Amount</div><div class="v big mono">${fmtINR(t.amount)}</div></div>
          <div class="fact"><div class="k">Risk</div><div class="v"><span class="band ${t.risk_band ?? ''}" style="color:${BAND_COLOR[t.risk_band] ?? COLORS.g4}">${t.risk_band ?? 'model unavailable'}</span> <span class="mono">${t.risk_score !== null ? t.risk_score.toFixed(2) : ''}</span></div></div>
          <div class="fact"><div class="k">Type · channel</div><div class="v">${t.type} · ${t.channel}</div></div>
          <div class="fact"><div class="k">From</div><div class="v">${txn.from_account.holder_name} <span class="muted mono">#${txn.from_account.id}</span><br><span class="muted">${txn.from_account.city}${txn.from_account.status === 'blocked' ? ' · ' : ''}</span>${txn.from_account.status === 'blocked' ? html`<span class="accent">blocked</span>` : ''}</div></div>
          <div class="fact"><div class="k">To</div><div class="v">${txn.to_account.holder_name} <span class="muted mono">#${txn.to_account.id}</span><br><span class="muted">${txn.to_account.merchant_category ?? txn.to_account.kind} · ${txn.to_account.city}</span></div></div>
          <div class="fact"><div class="k">IP city</div><div class="v">${t.ip_city ?? '–'}${cityMismatch ? html` <span class="muted">(home: ${txn.from_account.city})</span>` : ''}</div></div>
          <div class="fact"><div class="k">When</div><div class="v mono">${fmtDateTime(t.created_at)}</div></div>
          <div class="fact"><div class="k">Model</div><div class="v mono">${txn.model_version ?? '–'}</div></div>
        </div></div>

        <div class="section split">
          <div><h2 class="muted" style="font-size:12px;letter-spacing:.08em;text-transform:uppercase;font-weight:500;margin-bottom:14px">Why it scored this way</h2><div class="rbars" id="reason-bars"></div></div>
          <div><h2 class="muted" style="font-size:12px;letter-spacing:.08em;text-transform:uppercase;font-weight:500;margin-bottom:14px">Rules and system flags</h2>
            ${ruleReasons.length
              ? ruleReasons.map((r) => html`<div class="rule-hit"><div class="name">${r.rule ?? r.feature}</div>${r.detail ? html`<div class="detail">${r.detail}</div>` : ''}</div>`)
              : html`<div class="empty">No rules fired.</div>`}
          </div>
        </div>

        <div class="section"><h2>Decision</h2>${actionPanel()}</div>

        <div class="section"><h2>Account ${txn.from_account.id}: last ${history.length} transactions</h2>
          <div class="table-wrap"><table><thead><tr><th>When</th><th class="num">Amount</th><th>Type</th><th>City</th><th>Risk</th><th>Status</th></tr></thead><tbody>
            ${history.map((h) => html`<tr${h.id === c.transaction_id ? ' class="sel"' : ''}>
              <td class="mono muted">${fmtDateTime(h.created_at)}</td><td class="mono num">${fmtINR(h.amount)}</td><td>${h.type}</td><td>${h.ip_city ?? '–'}</td>
              <td><span class="band ${h.risk_band ?? ''}">${h.risk_band ?? '–'}</span></td><td>${h.status}</td></tr>`)}
          </tbody></table></div></div>`,
    );
    bind();
    await paintReasons();
  }

  function bind() {
    root.querySelector('#claim')?.addEventListener('click', async () => {
      try {
        await api.post(`/cases/${id}/claim`);
        toast('Case claimed');
        await load();
      } catch (e) {
        toast(e.message, 'error');
        if (e.status === 409) load();
      }
    });
    root.querySelectorAll('[data-decide]').forEach((b) =>
      b.addEventListener('click', () => {
        pending = b.dataset.decide;
        paint();
      }),
    );
    root.querySelector('#cancel')?.addEventListener('click', () => {
      pending = null;
      paint();
    });
    const noteEl = root.querySelector('#note');
    noteEl?.addEventListener('input', () => {
      note = noteEl.value;
      // enable or disable the confirm button without re-rendering (which would drop focus)
      const confirm = root.querySelector('#confirm');
      if (confirm) confirm.disabled = busy || note.trim().length < 3;
    });
    root.querySelector('#confirm')?.addEventListener('click', resolve);
  }

  async function resolve() {
    if (busy || !pending) return;
    busy = true;
    try {
      // Sending the version we last saw makes this safe: if anyone changed the case meanwhile, the API answers 409.
      await api.post(`/cases/${id}/resolve`, { decision: pending, note: note.trim(), version: c.version });
      toast(pending === 'blocked' ? 'Case blocked. Account blocked.' : 'Case cleared.');
      pending = null;
      note = '';
      busy = false;
      await load();
    } catch (e) {
      busy = false;
      toast(e.status === 409 ? `${e.message}. Reloaded the latest version.` : e.message, 'error');
      if (e.status === 409) {
        pending = null;
        await load();
      } else paint();
    }
  }

  return {
    mount(el) {
      root = el;
      setHtml(root, html`<div class="page-head"><h1>Case #${id}</h1></div><div class="empty">Loading…</div>`);
      load();
    },
    render(state, changed) {
      // Another analyst may touch this case; the stream tells us, so refresh quietly.
      if (changed.includes('queueTick') && c && !busy && !pending) load();
    },
    destroy() {
      destroyed = true;
    },
  };
}
