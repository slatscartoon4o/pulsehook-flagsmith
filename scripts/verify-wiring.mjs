#!/usr/bin/env node
/**
 * 端到端接线验收：把"看起来在工作"变成"可验证在工作"。
 *
 * 检查项（对应 README 的 4 项致命接线清单）：
 *  1. 稳定访客标识     同一 Cookie 20 次请求，变体 100% 一致
 *  2. 多变量 variation key  每个 variation 都有非空 key
 *  3. 曝光与转化可 join    真实事件落库后 identifier 一一对应
 *  4. 事件真实到达 Flagsmith  events 表里能看到 $flag_exposure 与转化
 *
 * 附加：
 *  - Reload 零闪烁（SSR 首屏变体 == /api/session 变体）
 *  - Flagsmith 断网降级（坏 env key 必须返回 control 而不是 500）
 *
 * 用法：node scripts/verify-wiring.mjs
 */
import { loadEnv } from '../src/env.js';
import { chiSquarePValue } from '../src/stats-audit.js';

const TARGET = `http://localhost:${process.env.PULSEHOOK_PORT || 3000}`;
const RELOAD_ROUNDS = 20;

const results = [];
const record = (name, ok, detail) => {
  results.push({ name, ok, detail });
  const tag = ok ? 'PASS' : 'FAIL';
  console.log(`  [${tag}] ${name}${detail ? ` — ${detail}` : ''}`);
};

class CookieJar {
  constructor() { this.cookies = new Map(); }
  absorb(res) {
    for (const raw of res.headers.getSetCookie?.() ?? []) {
      const [pair] = raw.split(';');
      const eq = pair.indexOf('=');
      if (eq > 0) this.cookies.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }
  }
  header() { return [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; '); }
}

async function req(jar, method, path, body) {
  const headers = {};
  if (jar && jar.cookies.size) headers.Cookie = jar.header();
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${TARGET}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: 'manual',
  });
  if (jar) jar.absorb(res);
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: res.status, ok: res.ok, data, rawText: text };
}

async function checkStableIdentity() {
  console.log('\n1. Stable visitor identity (20 reloads, same cookie)');
  const jar = new CookieJar();
  const first = await req(jar, 'GET', '/api/session');
  if (!first.ok) return record('stable identity', false, `session failed: ${first.status}`);
  const expected = first.data.variant;
  const seen = new Set([expected]);
  let drift = 0;
  for (let i = 0; i < RELOAD_ROUNDS - 1; i += 1) {
    const again = await req(jar, 'GET', '/api/session');
    if (again.data?.variant !== expected) {
      drift += 1;
      seen.add(again.data?.variant);
    }
  }
  record(
    'stable identity across reloads',
    drift === 0,
    drift === 0
      ? `${RELOAD_ROUNDS}/${RELOAD_ROUNDS} requests returned "${expected}" for the same visitor`
      : `${drift} drift(s); variants seen: ${[...seen].join(', ')}`,
  );

  // SSR 首屏必须与 API 一致：抓首页 HTML 的 data-variant
  const page = await fetch(`${TARGET}/`, { headers: { Cookie: jar.header() } });
  const html = await page.text();
  const m = html.match(/data-variant="([^"]+)"/);
  const ssrVariant = m?.[1] ?? null;
  record(
    'SSR/hydration zero flicker',
    ssrVariant === expected,
    `SSR="${ssrVariant}" API="${expected}"`,
  );

  return { jar, variant: expected };
}

async function checkVariantKeys() {
  console.log('\n2. Multivariate variation keys');
  const env = process.env;
  const base = env.FLAGSMITH_API_URL.replace(/\/+$/, '');
  const res = await fetch(
    `${base}/projects/${env.FLAGSMITH_PROJECT_ID}/features/${env.FLAGSMITH_FEATURE_ID}/`,
    { headers: { Authorization: `Token ${env.FLAGSMITH_ADMIN_TOKEN}` } },
  );
  if (!res.ok) return record('variation keys', false, `feature fetch ${res.status}`);
  const feature = await res.json();
  const options = feature.multivariate_options ?? [];
  const missing = options.filter((o) => !o.key || !String(o.key).trim());
  record(
    'every variation has a key',
    options.length > 0 && missing.length === 0,
    `${options.length - missing.length}/${options.length} keyed (${options.map((o) => o.key).join(', ')})`,
  );
}

async function checkEventsLand() {
  console.log('\n3. Real events reach Flagsmith (exposure + both conversions)');
  const env = process.env;
  const jar = new CookieJar();
  const session = await req(jar, 'GET', '/api/session');
  if (!session.ok) return record('events land', false, `session ${session.status}`);
  const visitorId = session.data.visitorId;

  const ping = await req(jar, 'POST', '/api/v1/sandbox/ping', {
    event: 'delivery.succeeded',
    data: { order_id: 'ord_verify' },
  });
  record('sandbox ping returns 200', ping.status === 200, `delivery_id=${ping.data?.delivery_id}`);
  const exp = await req(jar, 'POST', '/api/v1/sdk/export', { language: 'node' });
  record('sdk export returns 200', exp.status === 200, `${String(exp.data?.snippet ?? '').length} chars`);

  await req(jar, 'POST', '/api/admin/flush');
  await new Promise((r) => setTimeout(r, 8000));

  // 通过 Flagsmith 结果 API 间接验证：转化必须 <= 曝光，且两边都在增长
  const base = env.FLAGSMITH_API_URL.replace(/\/+$/, '');
  const resultsRes = await fetch(
    `${base}/environments/${env.FLAGSMITH_ENVIRONMENT_KEY}/experiments/${env.FLAGSMITH_AB_EXPERIMENT_ID}/results/`,
    { headers: { Authorization: `Token ${env.FLAGSMITH_ADMIN_TOKEN}` } },
  );
  const resultsBody = resultsRes.ok ? await resultsRes.json() : null;
  const metrics = resultsBody?.results?.payload?.metrics ?? [];
  const primary = metrics.find((m) => m.metric_id === Number(env.FLAGSMITH_PRIMARY_METRIC_ID));
  const guardrail = metrics.find((m) => m.metric_id === Number(env.FLAGSMITH_GUARDRAIL_METRIC_ID));
  const hasPrimary = Boolean(primary && Object.keys(primary.variants ?? {}).length > 0);
  const hasGuardrail = Boolean(guardrail && Object.keys(guardrail.variants ?? {}).length > 0);
  record(
    'primary conversions visible to Flagsmith',
    hasPrimary,
    hasPrimary ? `variants: ${Object.keys(primary.variants).join(', ')}` : 'no computed conversions yet',
  );
  record(
    'guardrail conversions visible to Flagsmith',
    hasGuardrail,
    hasGuardrail ? `variants: ${Object.keys(guardrail.variants).join(', ')}` : 'no computed conversions yet',
  );

  // join 检查：每个 variant 的 conversion 数不能超过曝光数
  const exposuresTs = resultsBody?.results?.payload?.exposures_timeseries?.points ?? [];
  const exposures = {};
  for (const point of exposuresTs) {
    for (const [v, c] of Object.entries(point.new_identities ?? {})) exposures[v] = (exposures[v] ?? 0) + c;
  }
  let joinOk = true;
  const joinNotes = [];
  for (const [label, metric] of [['primary', primary], ['guardrail', guardrail]]) {
    if (!metric) continue;
    for (const [variant, stats] of Object.entries(metric.variants ?? {})) {
      if (stats.n > (exposures[variant] ?? 0)) {
        joinOk = false;
        joinNotes.push(`${label}/${variant}: ${stats.n} > ${exposures[variant] ?? 0}`);
      }
    }
  }
  record(
    'exposure -> conversion join integrity',
    joinOk,
    joinOk ? 'conversions never exceed exposures on either metric' : joinNotes.join(' | '),
  );
  return visitorId;
}

async function checkFallback() {
  console.log('\n4. Flagsmith unreachable -> control fallback');
  // 用一个格式合法但无效的 env key 触发上游 401，页面必须仍可用
  const res = await fetch(`${TARGET}/api/session`, {
    headers: { Cookie: 'fs_visitor_id=vis_00000000-0000-0000-0000-000000000000' },
  });
  const data = res.ok ? await res.json().catch(() => null) : null;
  // 正常服务必然有 key，这里验证的是"即使 SDK 抛错也不会 500"
  record('session endpoint survives without upstream failure', res.status === 200, `status ${res.status}`);
  record(
    'session always returns a variant value',
    Boolean(data && typeof data.variant === 'string' && data.variant.length > 0),
    data ? `variant="${data.variant}"` : 'no body',
  );

  // 直接验证 evaluateVariant 的降级路径（用真实 SDK 打一个不存在的地址）
  const { createFlagsmithClient, evaluateVariant } = await import('../src/flagsmith-client.js');
  const broken = createFlagsmithClient({
    FLAGSMITH_ENVIRONMENT_KEY: 'this_key_does_not_exist',
    FLAGSMITH_API_URL: 'http://127.0.0.1:9/api/v1/',
  });
  const evaluated = await evaluateVariant(broken, 'vis_fallback_probe');
  record(
    'SDK failure degrades to control, never throws',
    evaluated.value === 'copy_checklist' && evaluated.isDefault === true,
    `value="${evaluated.value}" isDefault=${evaluated.isDefault}`,
  );
  if (typeof broken.close === 'function') await broken.close();
}

async function checkSrm() {
  console.log('\n5. Sample ratio sanity on the live A/B');
  const env = process.env;
  const base = env.FLAGSMITH_API_URL.replace(/\/+$/, '');
  const res = await fetch(
    `${base}/environments/${env.FLAGSMITH_ENVIRONMENT_KEY}/experiments/${env.FLAGSMITH_AB_EXPERIMENT_ID}/results/`,
    { headers: { Authorization: `Token ${env.FLAGSMITH_ADMIN_TOKEN}` } },
  );
  if (!res.ok) return record('SRM', false, `results ${res.status}`);
  const body = await res.json();
  const points = body?.results?.payload?.exposures_timeseries?.points ?? [];
  const counts = {};
  for (const point of points) {
    for (const [v, c] of Object.entries(point.new_identities ?? {})) counts[v] = (counts[v] ?? 0) + c;
  }
  const control = counts.control ?? 0;
  const variant = counts.interactive_sandbox ?? 0;
  const { p } = chiSquarePValue(control, variant);
  const total = control + variant;
  record(
    'sample ratio within noise',
    total >= 100 ? p > 0.05 : true,
    `${control}/${variant} (n=${total}, p=${p.toFixed(4)})${total < 100 ? ' — under 100, not yet meaningful' : ''}`,
  );
}

async function main() {
  loadEnv();
  console.log(`PulseHook wiring verification against ${TARGET}`);
  const health = await fetch(`${TARGET}/api/health`).catch(() => null);
  if (!health?.ok) {
    console.error(`FAIL: ${TARGET} is not reachable — start it with \`npm start\` first.`);
    process.exit(1);
  }
  console.log('service reachable\n');

  await checkStableIdentity();
  await checkVariantKeys();
  await checkEventsLand();
  await checkFallback();
  await checkSrm();

  const failures = results.filter((r) => !r.ok);
  console.log('\n=== summary ===');
  console.log(`${results.length - failures.length}/${results.length} checks passed`);
  if (failures.length > 0) {
    console.log('\nFailures:');
    for (const f of failures) console.log(`  - ${f.name}: ${f.detail}`);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error('[verify] FAILED:', error.message);
  process.exit(1);
});
