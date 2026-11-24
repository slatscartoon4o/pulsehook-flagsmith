/**
 * /audit 页面渲染：全部数据来自服务端 /api/audit（只读代理 Flagsmith 结果 API）。
 * 前端不参与任何统计口径计算，只负责把真实数值摆清楚。
 */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const pct = (value) => (typeof value === 'number' && Number.isFinite(value)
  ? `${(value * 100).toFixed(1)}%`
  : '—');
const signedPct = (value) => (typeof value === 'number' && Number.isFinite(value)
  ? `${value >= 0 ? '+' : ''}${(value * 100).toFixed(1)}%`
  : '—');
const num = (value) => (typeof value === 'number' ? value.toLocaleString('en-US') : '—');

function setCheck(id, state, detail) {
  const li = document.querySelector(`.check[data-check="${id}"]`);
  if (!li) return;
  li.dataset.state = state;
  const verdict = $('[data-verdict]', li);
  if (verdict) {
    verdict.textContent = { pass: 'pass', fail: 'fail', warn: 'warn', pending: 'pending' }[state] ?? state;
  }
  const detailEl = $('[data-detail]', li);
  if (detailEl && detail) detailEl.textContent = detail;
}

function renderMetric(prefix, metric) {
  const body = $(`[data-${prefix}-body]`);
  const inferenceEl = $(`[data-${prefix}-inference]`);
  if (!body) return;

  if (!metric?.present || (!metric.control?.exposures && !metric.variant?.exposures)) {
    body.innerHTML = '<tr><td colspan="4" class="muted-row">No computed results yet — run the traffic simulation, then refresh.</td></tr>';
    if (inferenceEl) inferenceEl.hidden = true;
    return;
  }

  const rows = [
    { label: 'control (copy_checklist)', data: metric.control, cls: 'is-control' },
    { label: 'interactive_sandbox', data: metric.variant, cls: '' },
  ];
  body.innerHTML = rows
    .map(({ label, data, cls }) => `
      <tr>
        <td class="${cls}">${label}</td>
        <td>${num(data.exposures)}</td>
        <td>${num(data.conversions)}</td>
        <td>${pct(data.rate)}</td>
      </tr>`)
    .join('');

  const inf = metric.inference;
  if (!inferenceEl) return;
  if (!inf) {
    inferenceEl.hidden = false;
    inferenceEl.innerHTML =
      '<div class="inference__item"><span>relative lift</span><strong>collecting data</strong></div>';
    return;
  }
  inferenceEl.hidden = false;
  $(`[data-${prefix}="lift"]`).textContent = signedPct(inf.lift);
  $(`[data-${prefix}="ci"]`).textContent =
    `${signedPct(inf.ci_low)} … ${signedPct(inf.ci_high)}`;
  $(`[data-${prefix}="win"]`).textContent = pct(inf.chance_to_win);

  const liftCell = $(`[data-${prefix}="lift"]`);
  const ciCell = $(`[data-${prefix}="ci"]`);
  const good = inf.ci_low > 0;
  const bad = inf.ci_high < 0;
  for (const cell of [liftCell, ciCell]) {
    const item = cell?.closest('.inference__item');
    if (!item) continue;
    item.classList.toggle('is-good', good);
    item.classList.toggle('is-bad', bad);
  }
}

function renderAa(aa) {
  const set = (key, value) => {
    const el = document.querySelector(`[data-aa="${key}"]`);
    if (el) el.textContent = value;
  };
  set('control-exposures', num(aa.exposures?.control ?? 0));
  set('variant-exposures', num(aa.exposures?.aa_twin ?? 0));
  set('srm-p', typeof aa.srm?.p === 'number' ? aa.srm.p.toFixed(4) : '—');
  set('control-cvr', pct(aa.rates?.controlRate));
  set('variant-cvr', pct(aa.rates?.variantRate));

  const note = document.getElementById('aa-interpretation');
  if (!note) return;
  const total = (aa.exposures?.control ?? 0) + (aa.exposures?.aa_twin ?? 0);
  if (total === 0) {
    note.dataset.tone = '';
    note.textContent = 'Waiting for the A/A run to land. Run `npm run simulate:aa`.';
    return;
  }
  if (typeof aa.srm?.p === 'number' && aa.srm.p < 0.05) {
    note.dataset.tone = 'bad';
    note.textContent =
      `SRM p=${aa.srm.p.toFixed(4)} on ${total} visitors — the split is skewed. ` +
      'Fix allocation before trusting any A/B number.';
    return;
  }
  const lift = aa.rates?.lift;
  if (typeof lift === 'number' && Math.abs(lift) > 0.15) {
    note.dataset.tone = 'warn';
    note.textContent =
      `The two identical arms differ by ${signedPct(lift)} — larger than the ±15% effect we are ` +
      `looking for. On ${total} visitors that is plausibly noise, but it caps how much confidence ` +
      'a single A/B run deserves.';
    return;
  }
  note.dataset.tone = 'good';
  note.textContent =
    `On ${total} visitors the split is within noise (p=${aa.srm.p.toFixed(4)}) and the two ` +
    `identical pages differ by ${signedPct(lift ?? 0)}. The exposure→conversion wiring is unbiased.`;
}

function renderDecision(decision) {
  const card = document.getElementById('decision-card');
  const verdict = document.getElementById('decision-verdict');
  const bodyEl = document.getElementById('decision-body');
  const actions = document.getElementById('decision-actions');
  if (!card) return;
  card.dataset.tone = decision.tone ?? 'pending';
  verdict.textContent = decision.verdict;
  bodyEl.textContent = decision.body;
  actions.innerHTML = (decision.actions ?? []).map((a) => `<li>${a}</li>`).join('');
}

function renderStatusPill(report) {
  const pill = document.getElementById('audit-status-text');
  if (!pill) return;
  const failing = (report.experiment.checks ?? []).filter((c) => c.state === 'fail').length;
  const warning = (report.experiment.checks ?? []).filter((c) => c.state === 'warn').length;
  pill.textContent = failing > 0
    ? `${failing} check${failing > 1 ? 's' : ''} failing`
    : warning > 0
      ? `all checks pass · ${warning} pending`
      : 'all four checks pass';
}

function render(report) {
  for (const check of report.experiment.checks ?? []) {
    setCheck(check.id, check.state, check.detail);
  }
  const asOf = document.getElementById('ab-as-of');
  if (asOf) {
    asOf.textContent = report.experiment.asOf
      ? `as of ${new Date(report.experiment.asOf).toLocaleString()}`
      : 'not computed yet';
  }
  renderMetric('primary', report.experiment.metrics?.primary);
  renderMetric('guardrail', report.experiment.metrics?.guardrail);
  renderAa(report.aa ?? { exposures: {}, rates: {}, srm: {} });
  renderDecision(report.experiment.decision ?? {});
  renderStatusPill(report);
  window.__AUDIT__ = report;
}

async function load() {
  try {
    const res = await fetch('/api/audit', { credentials: 'same-origin' });
    if (!res.ok) throw new Error(`audit ${res.status}`);
    render(await res.json());
  } catch (error) {
    const pill = document.getElementById('audit-status-text');
    if (pill) pill.textContent = 'audit unavailable — is Flagsmith running?';
    console.error('[audit]', error);
  }
}

load();
setInterval(load, 30000);
