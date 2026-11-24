/**
 * 本地实验审计工具：SRM 卡方检验、曝光-转化 Join 检查、多变量 key 校验，
 * 以及一个只读的 Flagsmith Results API 代理。
 *
 * 这个模块是"4 项接线体检"的实现，被 /audit 页面与 verify-wiring.mjs 共用。
 */
import crypto from 'node:crypto';

export const WIRING_CHECKS = [
  { id: 'stable-identity', title: 'Stable visitor identity', detail: 'Cookie fs_visitor_id survives reload and is used for both exposure and conversion.' },
  { id: 'srm', title: 'Sample ratio (SRM)', detail: 'Observed split matches the 50/50 allocation; chi-square p > 0.05.' },
  { id: 'exposure-conversion-join', title: 'Exposure → conversion join', detail: 'Every conversion identifier has a matching exposure with the same variant.' },
  { id: 'variant-keys', title: 'Multivariate variation keys', detail: 'Every variation carries a non-empty key, so exposures are attributable.' },
];

/**
 * 卡方检验（单自由度），返回 p 值。用于 SRM 判定。
 * @param {number} observedA
 * @param {number} observedB
 */
export function chiSquarePValue(observedA, observedB) {
  const total = observedA + observedB;
  if (total <= 0) return { chiSq: 0, p: 1, expected: 0 };
  const expected = total / 2;
  const chiSq = ((observedA - expected) ** 2) / expected + ((observedB - expected) ** 2) / expected;
  // 单自由度卡方 -> p = erfc(sqrt(chiSq / 2))
  const p = erfc(Math.sqrt(chiSq / 2));
  return { chiSq, p, expected };
}

/** 互补误差函数（Numerical Recipes 近似，精度 1.2e-7）。 */
export function erfc(x) {
  const z = Math.abs(x);
  const t = 2 / (2 + z);
  const ty = 4 * t - 2;
  const cof = [-1.3026537197817094, 6.4196979235649026e-1, 1.9476473204185836e-2,
    -9.561514786808631e-3, -9.46595344482036e-4, 3.66839497852761e-4,
    4.2523324806907e-5, -2.0278578112534e-5, -1.624290004647e-6,
    1.303655835580e-6, 1.5626441722e-8, -8.5238095915e-8,
    6.529054439e-9, 5.059343495e-9, -9.91364156e-10,
    -2.27365122e-10, 9.6467911e-11, 2.394038e-12,
    -6.886027e-12, 8.94487e-13, 3.13092e-13,
    -1.12708e-13, 3.81e-16, 7.106e-15];
  let d = 0;
  let dd = 0;
  for (let j = cof.length - 1; j > 0; j--) {
    const tmp = d;
    d = ty * d - dd + cof[j];
    dd = tmp;
  }
  const ans = t * Math.exp(-z * z + 0.5 * (cof[0] + ty * d) - dd);
  return x >= 0 ? ans : 2 - ans;
}

/**
 * 生成稳定访客标识（与 server.js 的格式一致）。
 */
export function newVisitorId() {
  return `vis_${crypto.randomUUID()}`;
}

/**
 * 检查曝光与转化的 join 完整性。
 * @param {Array<{identifier: string, value?: string, variant?: string}>} exposures
 * @param {Array<{identifier: string}>} conversions
 */
export function checkExposureConversionJoin(exposures, conversions) {
  const exposureById = new Map();
  for (const e of exposures) {
    if (!exposureById.has(e.identifier)) exposureById.set(e.identifier, e);
  }
  const orphans = [];
  let matched = 0;
  for (const c of conversions) {
    const match = exposureById.get(c.identifier);
    if (match) matched += 1;
    else orphans.push(c.identifier);
  }
  return {
    status: orphans.length === 0 ? 'pass' : 'fail',
    exposures: exposures.length,
    uniqueExposures: exposureById.size,
    conversions: conversions.length,
    matched,
    orphanConversions: orphans.length,
    orphanSample: orphans.slice(0, 5),
  };
}

/**
 * 检查每个 variation 是否有非空 key。
 */
export function checkVariantKeys(multivariateOptions) {
  const invalid = (multivariateOptions ?? []).filter(
    (opt) => typeof opt.key !== 'string' || opt.key.trim().length === 0,
  );
  return {
    status: invalid.length === 0 ? 'pass' : 'fail',
    total: (multivariateOptions ?? []).length,
    withKey: (multivariateOptions ?? []).length - invalid.length,
    missing: invalid.map((opt) => opt.id ?? opt.uuid ?? '?'),
  };
}

/**
 * 由 counts 统计出转化率、相对 lift 与 95% 区间（Wald，双比例）。
 * 仅用于本地审计展示；正式数值必须来自 Flagsmith 的结果 API。
 * @param {{exposures:number, conversions:number}} control
 * @param {{exposures:number, conversions:number}} variant
 */
export function summariseRates(control, variant) {
  const pC = control.exposures > 0 ? control.conversions / control.exposures : 0;
  const pV = variant.exposures > 0 ? variant.conversions / variant.exposures : 0;
  const lift = pC > 0 ? (pV - pC) / pC : null;
  let ciLow = null;
  let ciHigh = null;
  if (control.exposures > 0 && variant.exposures > 0 && pC > 0) {
    const se = Math.sqrt(
      (pV * (1 - pV)) / variant.exposures + (pC * (1 - pC)) / control.exposures,
    );
    const seLift = se / pC;
    ciLow = lift - 1.96 * seLift;
    ciHigh = lift + 1.96 * seLift;
  }
  return { controlRate: pC, variantRate: pV, lift, ciLow, ciHigh };
}

/**
 * 把基础地址归一化成 `http://host:port/api/v1`（不带尾斜杠）。
 * 传入的值可能是 `http://host:port`、`http://host:port/`、`http://host:port/api/v1/` 任一形态。
 */
export function normaliseApiBase(baseUrl) {
  const trimmed = String(baseUrl ?? '').trim().replace(/\/+$/, '');
  return trimmed.endsWith('/api/v1') ? trimmed : `${trimmed.replace(/\/api\/v1\/?$/, '')}/api/v1`;
}

/**
 * 从 Flagsmith 实验 results 端点拉取真实贝叶斯统计（只读代理）。
 * @param {{baseUrl:string, environmentKey:string, token:string, experimentId:number}} opts
 */
export async function fetchExperimentResults({ baseUrl, environmentKey, token, experimentId }) {
  const base = `${normaliseApiBase(baseUrl)}/environments/${environmentKey}`;
  const resultsUrl = `${base}/experiments/${experimentId}/results/`;
  const res = await fetch(resultsUrl, {
    headers: token ? { Authorization: `Token ${token}` } : {},
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  if (!res.ok || data === null) {
    return { ok: false, status: res.status, error: `results ${res.status}` };
  }
  return { ok: true, status: res.status, data };
}

/**
 * 从 Flagsmith 拉取实验详情（含 metrics 定义）。
 */
export async function fetchExperiment({ baseUrl, environmentKey, token, experimentId }) {
  const base = `${normaliseApiBase(baseUrl)}/environments/${environmentKey}`;
  const res = await fetch(`${base}/experiments/${experimentId}/`, {
    headers: token ? { Authorization: `Token ${token}` } : {},
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  if (!res.ok || data === null) return { ok: false, status: res.status };
  return { ok: true, data };
}
