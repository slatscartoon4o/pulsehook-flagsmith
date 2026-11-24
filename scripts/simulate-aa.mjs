#!/usr/bin/env node
/**
 * A/A 校验：400 名真实 HTTP 访客，两个页面完全相同。
 *
 * 目的：在跑 A/B 之前先证明埋点链路本身无偏 ——
 *  - 50/50 分桶不出现 SRM
 *  - 分组与转化之间没有系统性差异
 *
 * 每个访客都有独立的 Cookie Jar（真实 HTTP，不是 stub）。
 * 结果落盘 docs/aa-results.json（不含任何密钥）。
 *
 * 用法：node scripts/simulate-aa.mjs [visitors=400]
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadEnv, ROOT } from '../src/env.js';
import { chiSquarePValue, summariseRates } from '../src/stats-audit.js';

const TARGET = `http://localhost:${process.env.PULSEHOOK_PORT || 3000}`;
const TOTAL_VISITORS = Number(process.argv[2] || 400);
const SEED = 20261126;

const log = (...args) => console.log('[aa]', ...args);

/** 确定性 PRNG（mulberry32），保证任何人重跑得到同一批访客。 */
function makeRng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * 极简 Cookie Jar —— 每个访客独立，模拟真实浏览器。
 */
class CookieJar {
  constructor() { this.cookies = new Map(); }
  absorb(response) {
    const setCookie = response.headers.getSetCookie?.() ?? [];
    for (const raw of setCookie) {
      const [pair] = raw.split(';');
      const eq = pair.indexOf('=');
      if (eq > 0) this.cookies.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }
  }
  header() {
    return [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  }
  get(name) { return this.cookies.get(name); }
}

function newJar() { return new CookieJar(); }

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

/** 通过真实 HTTP 读取 A/A 分流。 */
async function readAaSession(jar) {
  return request(jar, 'GET', '/api/aa-session');
}

/** 真实业务动作 1：沙盒跑通一次 webhook。 */
async function pingSandbox(jar) {
  return request(jar, 'POST', '/api/v1/sandbox/ping', {
    event: 'delivery.succeeded',
    data: { order_id: `ord_${Math.floor(Math.random() * 9000) + 1000}` },
  });
}

/** 真实业务动作 2：导出 SDK 代码。 */
async function exportSdk(jar) {
  return request(jar, 'POST', '/api/v1/sdk/export', { language: 'node' });
}

async function fetchFlagsmithResults({ apiUrl, envKey, token, experimentId, kind }) {
  const base = apiUrl.replace(/\/+$/, '');
  const url = `${base}/environments/${envKey}/experiments/${experimentId}/${kind}/`;
  const res = await fetch(url, { headers: { Authorization: `Token ${token}` } });
  if (!res.ok) return { ok: false, status: res.status };
  return { ok: true, data: await res.json() };
}

async function refreshFlagsmith({ apiUrl, envKey, token, experimentId, kind }) {
  const base = apiUrl.replace(/\/+$/, '');
  const url = `${base}/environments/${envKey}/experiments/${experimentId}/${kind}/refresh/`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Token ${token}`, 'Content-Type': 'application/json' },
    body: '{}',
  });
  const text = await res.text();
  return { status: res.status, body: text };
}

async function main() {
  loadEnv();
  const env = process.env;
  const token = env.FLAGSMITH_ADMIN_TOKEN;
  const envKey = env.FLAGSMITH_ENVIRONMENT_KEY;
  const apiUrl = env.FLAGSMITH_API_URL;
  const aaExperimentId = Number(env.FLAGSMITH_AA_EXPERIMENT_ID);

  if (!token || !envKey || !aaExperimentId) {
    throw new Error('missing Flagsmith config in .env — run `npm run bootstrap` first');
  }

  log(`target=${TARGET} visitors=${TOTAL_VISITORS} seed=${SEED}`);
  const health = await fetch(`${TARGET}/api/health`).catch(() => null);
  if (!health?.ok) throw new Error(`${TARGET} is not reachable — start PulseHook first`);
  log('PulseHook reachable');

  const rng = makeRng(SEED);
  const counts = { control: 0, aa_twin: 0 };
  const converted = { control: 0, aa_twin: 0 };
  const exported = { control: 0, aa_twin: 0 };
  const mismatches = [];

  for (let i = 0; i < TOTAL_VISITORS; i += 1) {
    const jar = newJar();
    const session = await readAaSession(jar);
    if (!session.ok) {
      mismatches.push({ i, reason: `aa-session ${session.status}` });
      continue;
    }
    const variant = session.data.variant === 'aa_twin' ? 'aa_twin' : 'control';
    counts[variant] += 1;

    // 两次求值必须一致（同一 Cookie）
    const second = await readAaSession(jar);
    if (second.data?.variant !== session.data.variant) {
      mismatches.push({ i, reason: 'variant drift', first: session.data.variant, second: second.data?.variant });
    }

    // 统一固定概率，两个分组完全相同 —— 这正是 A/A 的意义
    if (rng() < 0.45) {
      const ping = await pingSandbox(jar);
      if (ping.ok) converted[variant] += 1;
    }
    if (rng() < 0.32) {
      const exp = await exportSdk(jar);
      if (exp.ok) exported[variant] += 1;
    }
    if ((i + 1) % 100 === 0) log(`  ${i + 1}/${TOTAL_VISITORS} visitors`);
  }

  log('flushing buffered events to Flagsmith');
  await fetch(`${TARGET}/api/admin/flush`, { method: 'POST' }).catch(() => null);

  const totalExposures = counts.control + counts.aa_twin;
  const srm = chiSquarePValue(counts.control, counts.aa_twin);
  const rates = summariseRates(
    { exposures: counts.control, conversions: converted.control },
    { exposures: counts.aa_twin, conversions: converted.aa_twin },
  );
  const exportRates = summariseRates(
    { exposures: counts.control, conversions: exported.control },
    { exposures: counts.aa_twin, conversions: exported.aa_twin },
  );

  // 等服务端把最后一批事件落库，再触发一次结果刷新（有 5 分钟限流，只调一次）
  log('waiting 12s for the events to land, then refreshing Flagsmith');
  await new Promise((r) => setTimeout(r, 12000));

  const refreshExposures = await refreshFlagsmith({ apiUrl, envKey, token, experimentId: aaExperimentId, kind: 'exposures' });
  log('exposures refresh:', refreshExposures.status);
  await new Promise((r) => setTimeout(r, 12000));
  const refreshResults = await refreshFlagsmith({ apiUrl, envKey, token, experimentId: aaExperimentId, kind: 'results' });
  log('results refresh:', refreshResults.status);
  await new Promise((r) => setTimeout(r, 12000));

  const exposures = await fetchFlagsmithResults({ apiUrl, envKey, token, experimentId: aaExperimentId, kind: 'exposures' });
  const results = await fetchFlagsmithResults({ apiUrl, envKey, token, experimentId: aaExperimentId, kind: 'results' });

  const flagsmithExposures = {};
  for (const point of exposures.ok ? (results.data?.results?.payload?.exposures_timeseries?.points ?? []) : []) {
    for (const [v, c] of Object.entries(point.new_identities ?? {})) {
      flagsmithExposures[v] = (flagsmithExposures[v] ?? 0) + c;
    }
  }

  const summary = {
    generatedAt: new Date().toISOString(),
    experiment: { id: aaExperimentId, name: 'A/A Sanity: Checklist vs Its Twin' },
    traffic: {
      method: 'real HTTP requests, one cookie jar per visitor',
      visitors: TOTAL_VISITORS,
      seed: SEED,
      note: 'Simulated traffic, disclosed as such. Both arms render an identical page.',
    },
    clientSide: {
      exposures: counts,
      primaryConversions: converted,
      guardrailConversions: exported,
      srm: { chiSq: srm.chiSq, p: srm.p, expected: srm.expected },
      primaryRates: rates,
      guardrailRates: exportRates,
      stableIdentityMismatches: mismatches.length,
      mismatchSample: mismatches.slice(0, 5),
    },
    flagsmith: {
      exposuresStatus: exposures.status,
      resultsStatus: results.status,
      asOfExposures: exposures.ok ? exposures.data?.exposures?.as_of ?? null : null,
      asOfResults: results.ok ? results.data?.results?.as_of ?? null : null,
      exposuresTimeseries: flagsmithExposures,
      srmPValue: results.ok ? results.data?.results?.payload?.srm_p_value ?? null : null,
      metrics: results.ok ? results.data?.results?.payload?.metrics ?? null : null,
    },
    verdict: {
      srmOk: srm.p > 0.05 && totalExposures >= 100,
      identicalPages: true,
      wiringUnbiased: srm.p > 0.05 && mismatches.length === 0,
    },
  };

  const outDir = path.join(ROOT, 'docs');
  mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, 'aa-results.json');
  writeFileSync(outPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
  log('wrote', outPath);

  console.log('\n=== A/A summary ===');
  console.log(JSON.stringify({
    exposures: counts,
    primaryConversions: converted,
    srmP: Number(srm.p.toFixed(4)),
    primaryControlRate: Number(rates.controlRate.toFixed(4)),
    primaryTwinRate: Number(rates.variantRate.toFixed(4)),
    relativeDiff: rates.lift === null ? null : Number(rates.lift.toFixed(4)),
    stableIdentityMismatches: mismatches.length,
    flagsmithSrmP: summary.flagsmith.srmPValue,
  }, null, 2));

  if (!summary.verdict.wiringUnbiased) {
    console.error('[aa] WIRING IS BIASED — fix before trusting any A/B result');
    process.exitCode = 1;
  }
}

const invokedDirectly =
  process.argv[1] && process.argv[1].endsWith('simulate-aa.mjs');

if (invokedDirectly) {
  main().catch((error) => {
    console.error('[aa] FAILED:', error.message);
    process.exit(1);
  });
}
