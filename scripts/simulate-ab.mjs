#!/usr/bin/env node
/**
 * A/B 正式实验：1,200 名基于文档化 Persona 的访客。
 *
 * 工程纪律（与 A/A 完全一致）：
 *  - 每个访客独立 Cookie Jar，走真实 HTTP 请求
 *  - 变体由 Flagsmith 真实分配，脚本不预设分组
 *  - Persona 只决定"这个人在看到该变体后的行为倾向"，不决定分组
 *  - 统计数值一律以 Flagsmith Results API 为准，落盘 docs/ab-results.json
 *
 * Persona（README 中同等披露）：
 *  - Senior / Hurried Dev   35%  熟悉文档，偏爱直接导出代码，两种变体都少走弯路
 *  - Explorer / Evaluator   45%  想立刻看到 API 跑通效果，最受益于沙盒，也最容易"玩完就走"
 *  - Impatient / Bouncer    20%  极易流失，最高概率什么都不做完
 *
 * 用法：node scripts/simulate-ab.mjs [visitors=1200]
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadEnv, ROOT } from '../src/env.js';
import { chiSquarePValue, summariseRates } from '../src/stats-audit.js';
import { verdictFor } from '../src/verdict.js';

const TARGET = `http://localhost:${process.env.PULSEHOOK_PORT || 3000}`;
const TOTAL_VISITORS = Number(process.argv[2] || 1200);
const SEED = 20261126;

const log = (...args) => console.log('[ab]', ...args);

function makeRng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

class CookieJar {
  constructor() { this.cookies = new Map(); }
  absorb(response) {
    for (const raw of response.headers.getSetCookie?.() ?? []) {
      const [pair] = raw.split(';');
      const eq = pair.indexOf('=');
      if (eq > 0) this.cookies.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }
  }
  header() { return [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; '); }
}

async function request(jar, method, url, body) {
  const headers = {};
  if (jar.cookies.size > 0) headers.Cookie = jar.header();
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${TARGET}${url}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: 'manual',
  });
  jar.absorb(res);
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: res.status, ok: res.ok, data };
}

/**
 * Persona 行为矩阵。
 * 数值是该 Persona 在某一变体下"真的做了这件事"的概率。
 * 这些是先验假设，不是结果 —— README 里明确写了这一点。
 */
export const PERSONAS = {
  senior: {
    weight: 0.35,
    label: 'Senior / Hurried Dev',
    description: 'Knows the docs already; wants the snippet and out.',
    behavior: {
      copy_checklist: { firstCall: 0.58, export: 0.46 },
      interactive_sandbox: { firstCall: 0.72, export: 0.38 },
    },
  },
  explorer: {
    weight: 0.45,
    label: 'Explorer / Evaluator',
    description: 'Wants to see the API work before reading further.',
    behavior: {
      copy_checklist: { firstCall: 0.40, export: 0.30 },
      interactive_sandbox: { firstCall: 0.74, export: 0.21 },
    },
  },
  impatient: {
    weight: 0.20,
    label: 'Impatient / Bouncer',
    description: 'Bails at the first sign of friction.',
    behavior: {
      copy_checklist: { firstCall: 0.18, export: 0.14 },
      interactive_sandbox: { firstCall: 0.42, export: 0.12 },
    },
  },
};

function pickPersona(rng) {
  const r = rng();
  let acc = 0;
  for (const [key, persona] of Object.entries(PERSONAS)) {
    acc += persona.weight;
    if (r < acc) return key;
  }
  return 'impatient';
}

async function refreshAndFetch({ apiUrl, envKey, token, experimentId, kind, waitMs }) {
  const base = apiUrl.replace(/\/+$/, '');
  const refresh = await fetch(
    `${base}/environments/${envKey}/experiments/${experimentId}/${kind}/refresh/`,
    {
      method: 'POST',
      headers: { Authorization: `Token ${token}`, 'Content-Type': 'application/json' },
      body: '{}',
    },
  );
  log(`${kind} refresh:`, refresh.status);
  await new Promise((r) => setTimeout(r, waitMs));
  const res = await fetch(
    `${base}/environments/${envKey}/experiments/${experimentId}/${kind}/`,
    { headers: { Authorization: `Token ${token}` } },
  );
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  return { status: res.status, data };
}

async function main() {
  loadEnv();
  const env = process.env;
  const token = env.FLAGSMITH_ADMIN_TOKEN;
  const envKey = env.FLAGSMITH_ENVIRONMENT_KEY;
  const apiUrl = env.FLAGSMITH_API_URL;
  const experimentId = Number(env.FLAGSMITH_AB_EXPERIMENT_ID);
  const primaryMetricId = Number(env.FLAGSMITH_PRIMARY_METRIC_ID);
  const guardrailMetricId = Number(env.FLAGSMITH_GUARDRAIL_METRIC_ID);

  if (!token || !envKey || !experimentId) {
    throw new Error('missing Flagsmith config in .env — run `npm run bootstrap` first');
  }

  log(`target=${TARGET} visitors=${TOTAL_VISITORS} seed=${SEED}`);
  const health = await fetch(`${TARGET}/api/health`).catch(() => null);
  if (!health?.ok) throw new Error(`${TARGET} is not reachable — start PulseHook first`);

  const rng = makeRng(SEED);
  const byVariant = {
    copy_checklist: { visitors: 0, firstCall: 0, export: 0, personas: {} },
    interactive_sandbox: { visitors: 0, firstCall: 0, export: 0, personas: {} },
  };

  for (let i = 0; i < TOTAL_VISITORS; i += 1) {
    const jar = new CookieJar();
    const session = await request(jar, 'GET', '/api/session');
    if (!session.ok) {
      log(`visitor ${i} session failed: ${session.status}`);
      continue;
    }
    const variant = session.data.variant === 'interactive_sandbox'
      ? 'interactive_sandbox'
      : 'copy_checklist';
    const bucket = byVariant[variant];
    bucket.visitors += 1;

    const personaKey = pickPersona(rng);
    const persona = PERSONAS[personaKey];
    bucket.personas[personaKey] = (bucket.personas[personaKey] ?? 0) + 1;
    const behavior = persona.behavior[variant];

    // 真实 HTTP：沙盒跑通一次 webhook
    if (rng() < behavior.firstCall) {
      const ping = await request(jar, 'POST', '/api/v1/sandbox/ping', {
        event: 'delivery.succeeded',
        data: { order_id: `ord_${1000 + i}` },
      });
      if (ping.ok) bucket.firstCall += 1;
    }

    // 真实 HTTP：导出真实 SDK 代码
    if (rng() < behavior.export) {
      const exp = await request(jar, 'POST', '/api/v1/sdk/export', {
        language: rng() < 0.2 ? 'python' : 'node',
      });
      if (exp.ok) bucket.export += 1;
    }

    if ((i + 1) % 150 === 0) log(`  ${i + 1}/${TOTAL_VISITORS} visitors`);
  }

  log('flushing buffered events to Flagsmith');
  await fetch(`${TARGET}/api/admin/flush`, { method: 'POST' }).catch(() => null);

  // Flagsmith 限流：refresh 每 5 分钟一次，所以只调用一轮
  log('waiting 15s for events to land before refreshing Flagsmith');
  await new Promise((r) => setTimeout(r, 15000));

  const exposures = await refreshAndFetch({
    apiUrl, envKey, token, experimentId, kind: 'exposures', waitMs: 15000,
  });
  const results = await refreshAndFetch({
    apiUrl, envKey, token, experimentId, kind: 'results', waitMs: 25000,
  });

  // ---- 从 Flagsmith 侧汇总真实数值 ----
  const resultsPayload = results.data?.results?.payload ?? null;
  const exposuresPayload = exposures.data?.exposures?.payload ?? null;

  const flagsmithExposures = {};
  for (const point of exposuresPayload?.timeseries?.points ?? []) {
    for (const [v, c] of Object.entries(point.new_identities ?? {})) {
      flagsmithExposures[v] = (flagsmithExposures[v] ?? 0) + c;
    }
  }

  const metricById = new Map();
  for (const metric of resultsPayload?.metrics ?? []) metricById.set(metric.metric_id, metric);

  const controlExp = flagsmithExposures.control ?? 0;
  const variantExp = flagsmithExposures.interactive_sandbox ?? 0;
  const srm = chiSquarePValue(controlExp, variantExp);

  const collect = (metricId) => {
    const metric = metricById.get(metricId);
    if (!metric) return null;
    const control = metric.variants?.control ?? { n: 0, sum: 0 };
    const variant = metric.variants?.interactive_sandbox ?? { n: 0, sum: 0 };
    const rates = summariseRates(
      { exposures: controlExp, conversions: Math.round(control.sum ?? 0) },
      { exposures: variantExp, conversions: Math.round(variant.sum ?? 0) },
    );
    return {
      metricId,
      control: { exposures: controlExp, conversions: Math.round(control.sum ?? 0), rate: rates.controlRate },
      variant: { exposures: variantExp, conversions: Math.round(variant.sum ?? 0), rate: rates.variantRate },
      inference: metric.inference?.interactive_sandbox ?? null,
    };
  };

  const primary = collect(primaryMetricId);
  const guardrail = collect(guardrailMetricId);

  const summary = {
    generatedAt: new Date().toISOString(),
    experiment: { id: experimentId, feature: 'quickstart_experience' },
    hypothesis:
      'Using Flagsmith multivariate flag quickstart_experience (control: copy_checklist vs variant: interactive_sandbox, 50/50), ' +
      'a pre-filled live interactive webhook sandbox increases first_api_call_succeeded by at least +15% relative lift, ' +
      'while sdk_snippet_exported (guardrail) is watched to make sure developers still take the SDK into their own repo.',
    traffic: {
      method: 'real HTTP requests, one cookie jar per visitor',
      visitors: TOTAL_VISITORS,
      seed: SEED,
      disclosure:
        'Simulated developer traffic driven by documented behavioral personas (see scripts/simulate-ab.mjs). ' +
        'This is not production traffic and the README says so. Variant assignment is real: it comes from Flagsmith.',
      personas: Object.fromEntries(
        Object.entries(PERSONAS).map(([key, p]) => [key, {
          label: p.label,
          share: p.weight,
          description: p.description,
          behavior: p.behavior,
        }]),
      ),
    },
    clientSide: {
      byVariant,
      srm: { chiSq: srm.chiSq, p: srm.p, expected: srm.expected },
    },
    flagsmith: {
      asOfExposures: exposures.data?.exposures?.as_of ?? null,
      asOfResults: results.data?.results?.as_of ?? null,
      exposures: flagsmithExposures,
      srmPValue: resultsPayload?.srm_p_value ?? null,
      primary,
      guardrail,
    },
    verdict: verdictFor({ primary, guardrail, totalExposures: controlExp + variantExp }),
  };

  const outDir = path.join(ROOT, 'docs');
  mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, 'ab-results.json');
  writeFileSync(outPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
  log('wrote', outPath);

  console.log('\n=== A/B summary (Flagsmith Bayesian) ===');
  console.log(JSON.stringify({
    exposures: { control: controlExp, interactive_sandbox: variantExp },
    srmP: summary.flagsmith.srmPValue ?? Number(srm.p.toFixed(4)),
    primary: {
      controlRate: primary ? Number(primary.control.rate.toFixed(4)) : null,
      variantRate: primary ? Number(primary.variant.rate.toFixed(4)) : null,
      lift: primary?.inference ? Number(primary.inference.lift.toFixed(4)) : null,
      ci: primary?.inference
        ? [Number(primary.inference.ci_low.toFixed(4)), Number(primary.inference.ci_high.toFixed(4))]
        : null,
      chanceToWin: primary?.inference ? Number(primary.inference.chance_to_win.toFixed(4)) : null,
    },
    guardrail: {
      controlRate: guardrail ? Number(guardrail.control.rate.toFixed(4)) : null,
      variantRate: guardrail ? Number(guardrail.variant.rate.toFixed(4)) : null,
      lift: guardrail?.inference ? Number(guardrail.inference.lift.toFixed(4)) : null,
      ci: guardrail?.inference
        ? [Number(guardrail.inference.ci_low.toFixed(4)), Number(guardrail.inference.ci_high.toFixed(4))]
        : null,
      chanceToWin: guardrail?.inference ? Number(guardrail.inference.chance_to_win.toFixed(4)) : null,
    },
    verdict: summary.verdict,
  }, null, 2));
}

const invokedDirectly =
  process.argv[1] && process.argv[1].endsWith('simulate-ab.mjs');

if (invokedDirectly) {
  main().catch((error) => {
    console.error('[ab] FAILED:', error.message);
    process.exit(1);
  });
}
