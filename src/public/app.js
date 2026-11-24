/**
 * PulseHook 前端交互。
 *
 * 铁律：
 *  - 变体只在首屏渲染时决定一次（SSR 已注入 data-variant），刷新不会改变。
 *  - first_api_call_succeeded 只在 POST /api/v1/sandbox/ping 真的返回 200 时才由服务端记录。
 *  - sdk_snippet_exported 只在 POST /api/v1/sdk/export 成功时才由服务端记录。
 *  - 前端绝不自行上报任何统计事件。
 */

const body = document.body;
const configEl = document.getElementById('pulsehook-config');
const config = configEl ? JSON.parse(configEl.textContent) : {};

const VARIANT_SANDBOX = 'interactive_sandbox';

const state = {
  variant: config.variantKey || body.dataset.variant || 'copy_checklist',
  visitorId: config.visitorId || body.dataset.visitor || '',
  ranOnce: false,
};

/* ------------------------------------------------------------- utilities */

const $ = (sel) => document.querySelector(sel);

function toast(message, ms = 2400) {
  const el = $('#toast');
  if (!el) return;
  el.textContent = message;
  el.hidden = false;
  requestAnimationFrame(() => el.classList.add('is-visible'));
  clearTimeout(toast._t);
  toast._t = setTimeout(() => {
    el.classList.remove('is-visible');
    setTimeout(() => { el.hidden = true; }, 220);
  }, ms);
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    ta.remove();
    return ok;
  }
}

async function postJson(url, body) {
  const started = performance.now();
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
    credentials: 'same-origin',
  });
  const elapsed = Math.round(performance.now() - started);
  let data = null;
  try { data = await res.json(); } catch { data = { ok: false, error: 'bad_response' }; }
  return { res, data, elapsed };
}

/* --------------------------------------------------------- view switching */

function showVariant() {
  const isSandbox = state.variant === VARIANT_SANDBOX;
  const active = isSandbox ? $('#sandbox-view') : $('#checklist-view');
  const inactive = isSandbox ? $('#checklist-view') : $('#sandbox-view');
  if (active) active.classList.add('is-active');
  if (inactive) inactive.classList.remove('is-active');
  body.dataset.renderedVariant = isSandbox ? 'interactive_sandbox' : 'copy_checklist';
  // 供 DOM 断言与审计使用
  window.__PULSEHOOK__ = {
    variant: state.variant,
    visitorId: state.visitorId,
    rendered: body.dataset.renderedVariant,
  };
}

/* ----------------------------------------------------- checklist (control) */

function wireCopyButtons() {
  document.querySelectorAll('[data-copy-target]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const target = document.getElementById(btn.dataset.copyTarget);
      if (!target) return;
      const ok = await copyText(target.innerText);
      const original = btn.textContent;
      btn.textContent = ok ? 'Copied' : 'Copy failed';
      btn.classList.toggle('is-copied', ok);
      setTimeout(() => {
        btn.textContent = original;
        btn.classList.remove('is-copied');
      }, 1600);
      if (ok) toast('Snippet copied');
    });
  });
}

async function exportSnippet(button, outputEl, bodyEl, language = 'node') {
  button.classList.add('is-busy');
  try {
    const { res, data } = await postJson('/api/v1/sdk/export', { language });
    if (!res.ok || !data?.ok) {
      toast('Export failed — try again');
      return;
    }
    await copyText(data.snippet);
    bodyEl.textContent = data.snippet;
    outputEl.hidden = false;
    toast(`Exported ${data.filename} and copied to clipboard`, 2800);
  } catch {
    toast('Export failed — network error');
  } finally {
    button.classList.remove('is-busy');
  }
}

function wireChecklist() {
  const button = $('#checklist-export');
  if (!button) return;
  button.addEventListener('click', () => {
    exportSnippet(button, $('#checklist-output'), $('#checklist-output-body'));
  });
}

/* --------------------------------------------------------- sandbox (variant) */

function prettyJson(value) {
  try { return JSON.stringify(value, null, 2); } catch { return String(value); }
}

function renderResponse({ ok, status, elapsed, data }) {
  const empty = $('#response-empty');
  const bodyEl = $('#response-body');
  const statusEl = $('#response-status');
  const latencyEl = $('#response-latency');
  const jsonEl = $('#response-json');

  if (empty) empty.hidden = true;
  if (bodyEl) bodyEl.hidden = false;

  if (statusEl) {
    statusEl.textContent = `${status} ${ok ? 'OK' : 'ERROR'}`;
    statusEl.dataset.kind = ok ? 'ok' : 'error';
  }
  if (latencyEl) latencyEl.textContent = `${elapsed} ms round-trip`;
  if (jsonEl) jsonEl.textContent = prettyJson(data);
}

function wireSandbox() {
  const runBtn = $('#sandbox-run');
  if (!runBtn) return;
  const payloadEl = $('#sandbox-payload');
  const runLabel = $('#sandbox-run-label');

  runBtn.addEventListener('click', async () => {
    let payload;
    try {
      payload = JSON.parse(payloadEl.value);
    } catch {
      toast('Request body is not valid JSON');
      renderResponse({
        ok: false,
        status: 400,
        elapsed: 0,
        data: { ok: false, error: 'invalid_json', message: 'Fix the request body, then run again.' },
      });
      return;
    }

    runBtn.classList.add('is-busy');
    if (runLabel) runLabel.textContent = 'Sending…';
    try {
      const result = await postJson('/api/v1/sandbox/ping', payload);
      renderResponse({
        ok: result.res.ok && Boolean(result.data?.ok),
        status: result.res.status,
        elapsed: result.elapsed,
        data: result.data,
      });
      if (result.res.ok) {
        state.ranOnce = true;
        toast('Webhook delivered — first_api_call_succeeded recorded');
      }
    } catch {
      renderResponse({
        ok: false,
        status: 0,
        elapsed: 0,
        data: { ok: false, error: 'network_error', message: 'Could not reach the sandbox endpoint.' },
      });
      toast('Network error — request not sent');
    } finally {
      runBtn.classList.remove('is-busy');
      if (runLabel) runLabel.textContent = 'Run request';
    }
  });

  const exportBtn = $('#sandbox-export');
  if (exportBtn) {
    exportBtn.addEventListener('click', () => {
      exportSnippet(exportBtn, $('#sandbox-export-output'), $('#sandbox-export-body'));
    });
  }
}

/* ------------------------------------------------------------ status probe */

async function probeFlagsmith() {
  const dot = $('#fs-status');
  const text = $('#fs-status-text');
  try {
    const res = await fetch('/api/session', { credentials: 'same-origin' });
    if (!res.ok) throw new Error(String(res.status));
    const data = await res.json();
    const degraded = Boolean(data.isDefault);
    if (dot) dot.dataset.state = degraded ? 'degraded' : 'ok';
    if (text) {
      text.textContent = degraded
        ? 'Flagsmith: fallback (control)'
        : 'Flagsmith: connected';
    }
    // 零闪烁保证：同一 Cookie 的服务端变体必须与 SSR 一致
    if (data.variant && data.variant !== state.variant) {
      console.warn('[pulsehook] variant drift detected', { ssr: state.variant, api: data.variant });
      body.dataset.variantDrift = 'true';
    } else {
      body.dataset.variantDrift = 'false';
    }
  } catch {
    if (dot) dot.dataset.state = 'down';
    if (text) text.textContent = 'Flagsmith: unreachable (serving control)';
    body.dataset.variantDrift = 'unknown';
  }
}

/* ------------------------------------------------------------------- boot */

function boot() {
  showVariant();
  wireCopyButtons();
  wireChecklist();
  wireSandbox();
  probeFlagsmith();

  // ?force=sandbox 只是给演示用的提示，不改变真实分流
  const forceLink = $('#force-sandbox-link');
  if (forceLink) {
    forceLink.addEventListener('click', (event) => {
      event.preventDefault();
      toast('Variants come from Flagsmith, not the URL — clear cookies for a new assignment', 3600);
    });
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}
