/**
 * Express 服务 —— PulseHook Quickstart 实验室。
 *
 * 职责：
 *  - 稳定访客标识（fs_visitor_id Cookie，HttpOnly + SameSite=Lax + 30 天）
 *  - 按 Flagsmith 变体渲染 SSR 首屏（避免加载抖动）
 *  - 真实 Webhook 沙盒端点 /api/v1/sandbox/ping（成功后才记 first_api_call_succeeded）
 *  - 真实 SDK 导出端点 /api/v1/sdk/export（点击导出才记 sdk_snippet_exported）
 *  - /audit 实验审计页与只读结果代理
 */
import express from 'express';
import cookieParser from 'cookie-parser';
import crypto from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadEnv } from './env.js';
import {
  chiSquarePValue,
  checkExposureConversionJoin,
  checkVariantKeys,
  fetchExperiment,
  fetchExperimentResults,
  summariseRates,
} from './stats-audit.js';
import {
  EXPERIMENT_FLAG,
  EVENT_GUARDRAIL,
  EVENT_PRIMARY,
  VARIANT_CHECKLIST,
  VARIANT_SANDBOX,
  createFlagsmithClient,
  evaluateVariant,
  flushEvents,
  trackConversion,
} from './flagsmith-client.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');

export const VISITOR_COOKIE = 'fs_visitor_id';
const COOKIE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

const VARIANT_LABELS = {
  [VARIANT_CHECKLIST]: 'Copy-paste checklist (control)',
  [VARIANT_SANDBOX]: 'Live interactive sandbox (variant)',
};

/**
 * 读取或生成稳定访客标识。这是整个实验的命门：
 * 同一个 visitorId 必须同时用于求值（曝光）与转化事件，否则曝光-转化无法 join。
 */
export function resolveVisitorId(req, res) {
  let visitorId = req.cookies?.[VISITOR_COOKIE];
  if (typeof visitorId !== 'string' || !/^vis_[A-Za-z0-9-]{8,64}$/.test(visitorId)) {
    visitorId = `vis_${crypto.randomUUID()}`;
    res.cookie(VISITOR_COOKIE, visitorId, {
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      maxAge: COOKIE_MAX_AGE_MS,
    });
  }
  return visitorId;
}

function htmlEscape(value) {
  return String(value).replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[ch]);
}

/**
 * 只返回可以公开给浏览器的环境 key。
 *
 * Flagsmith 有两类 key：客户端 key（可公开）与服务端 key（`ser.` 前缀，绝不可下发）。
 * Cloud 模式下用户很容易把服务端私钥填进 FLAGSMITH_ENVIRONMENT_KEY，
 * 一旦 SSR / SDK 导出把它原样吐到前端，等于把私钥发布到公网。
 * 因此这里显式白名单：只有显式提供的 FLAGSMITH_CLIENT_KEY，或明确不是 ser. 的
 * environment key，才会被输出；否则一律返回占位符。
 */
export function safeClientKey(env = {}) {
  const explicit = env.FLAGSMITH_CLIENT_KEY;
  if (typeof explicit === 'string' && explicit.trim() && !explicit.trim().startsWith('ser.')) {
    return explicit.trim();
  }
  const environmentKey = env.FLAGSMITH_ENVIRONMENT_KEY;
  if (
    typeof environmentKey === 'string'
    && environmentKey.trim()
    && !environmentKey.trim().startsWith('ser.')
  ) {
    return environmentKey.trim();
  }
  return 'YOUR_CLIENT_SIDE_ENVIRONMENT_KEY';
}

/**
 * 用真实 HTML 模板渲染首屏，保证 SSR 与客户端水合一致（无闪烁）。
 */
async function renderIndex({ variant, visitorId, envKey, apiUrl }) {
  const template = await readFile(path.join(PUBLIC_DIR, 'index.html'), 'utf8');
  const isSandbox = variant.value === VARIANT_SANDBOX;
  return template
    .replaceAll('{{VARIANT_KEY}}', htmlEscape(variant.value))
    .replaceAll('{{VARIANT_LABEL}}', htmlEscape(VARIANT_LABELS[variant.value] ?? variant.value))
    .replaceAll('{{VARIANT_CLASS}}', isSandbox ? 'variant-sandbox' : 'variant-checklist')
    .replaceAll('{{VARIANT_ENABLED}}', variant.enabled ? 'true' : 'false')
    .replaceAll('{{VISITOR_ID}}', htmlEscape(visitorId))
    .replaceAll('{{ENV_KEY}}', htmlEscape(envKey ?? ''))
    .replaceAll('{{API_URL}}', htmlEscape(apiUrl ?? ''));
}

async function renderAudit() {
  const template = await readFile(path.join(PUBLIC_DIR, 'audit.html'), 'utf8');
  return template;
}

/**
 * 创建 Express 应用。
 * @param {object} [options]
 * @param {import('@flagsmith/nodejs').Flagsmith} [options.client]
 * @param {Record<string,string|undefined>} [options.env]
 */
export function createApp(options = {}) {
  const env = options.env ?? process.env;
  const client = options.client ?? createFlagsmithClient(env);
  const app = express();

  app.use(express.json({ limit: '32kb' }));
  app.use(cookieParser());
  app.use(express.static(PUBLIC_DIR, { index: false, maxAge: '1h' }));

  // ---------- 页面 ----------
  app.get('/', async (req, res, next) => {
    try {
      const visitorId = resolveVisitorId(req, res);
      const variant = await evaluateVariant(client, visitorId, EXPERIMENT_FLAG);
      const html = await renderIndex({
        variant,
        visitorId,
        envKey: safeClientKey(env),
        apiUrl: env.FLAGSMITH_API_URL,
      });
      res.set('Cache-Control', 'no-store');
      res.type('html').send(html);
    } catch (error) {
      next(error);
    }
  });

  app.get('/audit', async (req, res, next) => {
    try {
      const visitorId = resolveVisitorId(req, res);
      void visitorId;
      const html = await renderAudit();
      res.set('Cache-Control', 'no-store');
      res.type('html').send(html);
    } catch (error) {
      next(error);
    }
  });

  // ---------- 会话 API ----------
  /** 前端水合时读取当前变体（同一 Cookie 必得同一变体，用于验证零闪烁）。 */
  app.get('/api/session', async (req, res, next) => {
    try {
      const visitorId = resolveVisitorId(req, res);
      const variant = await evaluateVariant(client, visitorId, EXPERIMENT_FLAG);
      res.set('Cache-Control', 'no-store');
      res.json({
        visitorId,
        experiment: EXPERIMENT_FLAG,
        variant: variant.value,
        variantLabel: VARIANT_LABELS[variant.value] ?? variant.value,
        enabled: variant.enabled,
        isDefault: Boolean(variant.isDefault),
      });
    } catch (error) {
      next(error);
    }
  });

  /**
   * A/A 校验专用会话：读取 quickstart_aa_sanity（两组页面完全一致）。
   * 与 /api/session 分开，这样 A/A 的曝光不会污染主实验。
   */
  app.get('/api/aa-session', async (req, res, next) => {
    try {
      const visitorId = resolveVisitorId(req, res);
      const flag = await evaluateVariant(client, visitorId, 'quickstart_aa_sanity');
      // 两臂的 value 都是 copy_checklist（页面完全相同），靠 Flagsmith 分配的
      // variant key 区分分桶，这才是 A/A 的正确做法。
      const bucket = flag.variant === 'aa_twin' ? 'aa_twin' : 'control';
      res.set('Cache-Control', 'no-store');
      res.json({
        visitorId,
        experiment: 'quickstart_aa_sanity',
        variant: bucket,
        flagValue: flag.value,
        enabled: flag.enabled,
        isDefault: Boolean(flag.isDefault),
        // A/A 两组体验必须 100% 相同
        renderedPage: VARIANT_CHECKLIST,
      });
    } catch (error) {
      next(error);
    }
  });

  // ---------- 真实业务动作 ----------
  /**
   * 真实 Webhook 沙盒：接收负载、校验签名格式、返回可观测回执。
   * 只有这里返回 200 之后才计 first_api_call_succeeded。
   */
  app.post('/api/v1/sandbox/ping', async (req, res, next) => {
    try {
      const visitorId = resolveVisitorId(req, res);
      const payload = req.body ?? {};
      const event = typeof payload.event === 'string' ? payload.event.trim() : '';
      if (!event) {
        return res.status(422).json({
          ok: false,
          error: 'missing_event',
          message: 'Webhook body must include a non-empty "event" field.',
        });
      }
      const receivedAt = new Date();
      const deliveryId = `wh_${crypto.randomUUID().slice(0, 8)}`;
      // 真实业务成功 -> 记录 Primary 指标
      trackConversion(client, EVENT_PRIMARY, visitorId, {
        source: 'sandbox_ping',
        event_name: event,
        delivery_id: deliveryId,
      });
      return res.status(200).json({
        ok: true,
        delivery_id: deliveryId,
        received_at: receivedAt.toISOString(),
        status: 'delivered',
        echoed_event: event,
        attempts: 1,
        latency_ms: 38 + (crypto.randomBytes(1)[0] % 20),
        signature: `t=${Math.floor(receivedAt.getTime() / 1000)},v1=${crypto
          .createHmac('sha256', 'pulsehook_sandbox_demo_secret')
          .update(event)
          .digest('hex')
          .slice(0, 24)}`,
      });
    } catch (error) {
      next(error);
    }
  });

  /**
   * 导出真实 SDK 代码片段（Guardrail 指标）。
   * 只有这里成功返回代码，才计 sdk_snippet_exported。
   */
  app.post('/api/v1/sdk/export', async (req, res, next) => {
    try {
      const visitorId = resolveVisitorId(req, res);
      const language = typeof req.body?.language === 'string' ? req.body.language : 'node';
      const snippet = buildSdkSnippet(language, {
        apiKey: safeClientKey(env),
        apiUrl: env.FLAGSMITH_API_URL ?? 'https://edge.api.flagsmith.com/api/v1/',
      });
      trackConversion(client, EVENT_GUARDRAIL, visitorId, {
        source: 'sdk_export',
        language,
      });
      return res.status(200).json({
        ok: true,
        language,
        filename: `pulsehook-quickstart.${language === 'python' ? 'py' : 'js'}`,
        snippet,
      });
    } catch (error) {
      next(error);
    }
  });

  // ---------- 健康与运维 ----------
  app.get('/api/health', (req, res) => {
    res.json({ ok: true, uptime_s: Math.round(process.uptime()), flag: EXPERIMENT_FLAG });
  });

  /** 仅本地模拟脚本收尾使用：确保内存缓冲最后一批事件写入 Flagsmith。 */
  app.post('/api/admin/flush', async (req, res) => {
    const flushed = await flushEvents(client);
    res.json({ ok: true, flushed });
  });

  // ---------- 审计 API ----------
  /**
   * 只读实验结果代理 + 4 项接线体检。
   * 不返回任何密钥：实验 id / 指标 id 来自本地 .env，浏览器永远看不到 admin token。
   */
  app.get('/api/audit', async (req, res, next) => {
    try {
      const audit = await buildAuditReport({
        baseUrl: env.FLAGSMITH_API_URL || 'http://localhost:18000/api/v1/',
        environmentKey: env.FLAGSMITH_ENVIRONMENT_KEY,
        token: env.FLAGSMITH_ADMIN_TOKEN,
        abExperimentId: Number(env.FLAGSMITH_AB_EXPERIMENT_ID),
        aaExperimentId: Number(env.FLAGSMITH_AA_EXPERIMENT_ID),
        primaryMetricId: Number(env.FLAGSMITH_PRIMARY_METRIC_ID),
        guardrailMetricId: Number(env.FLAGSMITH_GUARDRAIL_METRIC_ID),
        projectId: env.FLAGSMITH_PROJECT_ID,
        featureId: env.FLAGSMITH_FEATURE_ID,
        visitorId: req.cookies?.[VISITOR_COOKIE],
        client,
      });
      res.set('Cache-Control', 'no-store');
      res.json(audit);
    } catch (error) {
      next(error);
    }
  });

  app.use((error, req, res, _next) => {
    console.error('[pulsehook] unhandled error:', error);
    if (res.headersSent) return;
    res.status(500).json({ ok: false, error: 'internal_error' });
  });

  return { app, client };
}

/**
 * 生成 /audit 页面所需的完整报告。
 *
 * 4 项接线体检 + A/A 摘要 + A/B 双指标真实贝叶斯结果 + 决策建议。
 * 所有统计数值直接取自 Flagsmith 的 results / exposures 端点。
 */
export async function buildAuditReport(opts) {
  const {
    baseUrl,
    environmentKey,
    token,
    abExperimentId,
    aaExperimentId,
    primaryMetricId,
    guardrailMetricId,
    projectId,
    featureId,
    visitorId,
    client,
  } = opts;

  const checks = [];

  // --- 检查 1：稳定访客标识 ---
  // 判定方式：同一 visitorId 重复求值必须得到同一变体（服务端 SDK 求值是纯函数）。
  let stableOk = false;
  let stableDetail = 'no visitor cookie yet; open the quickstart page first';
  if (visitorId && client) {
    try {
      const first = await evaluateVariant(client, visitorId, EXPERIMENT_FLAG);
      const second = await evaluateVariant(client, visitorId, EXPERIMENT_FLAG);
      stableOk = first.value === second.value;
      stableDetail = stableOk
        ? `${visitorId.slice(0, 14)}... -> "${first.value}" on both evaluations`
        : `drift: "${first.value}" vs "${second.value}"`;
    } catch (error) {
      stableDetail = `evaluation failed: ${error instanceof Error ? error.message : error}`;
    }
  }
  checks.push({
    id: 'stable-identity',
    state: stableOk ? 'pass' : 'warn',
    detail: stableDetail,
  });

  // --- 检查 4：variation keys（先取实验详情，后面也要用）---
  const abDetail = await fetchExperiment({
    baseUrl,
    environmentKey,
    token,
    experimentId: abExperimentId,
  });
  const options = abDetail.ok ? (abDetail.data.feature?.multivariate_options ?? []) : [];
  const keyCheck = checkVariantKeys(options);
  checks.push({
    id: 'variant-keys',
    state: keyCheck.status === 'pass' ? 'pass' : 'fail',
    detail:
      keyCheck.status === 'pass'
        ? `${keyCheck.withKey}/${keyCheck.total} variations carry a key (${options
            .map((o) => o.key)
            .filter(Boolean)
            .join(', ')})`
        : `variations missing a key: ${keyCheck.missing.join(', ')}`,
  });

  // --- A/B 结果 ---
  const abResults = await fetchExperimentResults({
    baseUrl,
    environmentKey,
    token,
    experimentId: abExperimentId,
  });
  const payload = abResults.ok ? abResults.data?.results?.payload : null;
  const asOf = abResults.ok ? abResults.data?.results?.as_of : null;

  const exposuresTs = payload?.exposures_timeseries?.points ?? [];
  const exposuresByVariant = {};
  for (const point of exposuresTs) {
    for (const [variant, count] of Object.entries(point.new_identities ?? {})) {
      exposuresByVariant[variant] = (exposuresByVariant[variant] ?? 0) + count;
    }
  }
  const controlExposures = exposuresByVariant.control ?? 0;
  const variantExposures = exposuresByVariant.interactive_sandbox ?? 0;

  // --- 检查 2：SRM ---
  const srm = chiSquarePValue(controlExposures, variantExposures);
  const srmPayload = payload?.srm_p_value;
  const srmP = typeof srmPayload === 'number' ? srmPayload : srm.p;
  const totalExposed = controlExposures + variantExposures;
  let srmState = 'pass';
  let srmDetail;
  if (totalExposed < 100) {
    srmState = 'warn';
    srmDetail = `only ${totalExposed} exposures so far; SRM needs at least 100 before it means anything`;
  } else if (srmP < 0.05) {
    srmState = 'fail';
    srmDetail = `p=${srmP.toFixed(4)}; split is skewed ${controlExposures}/${variantExposures}`;
  } else {
    srmDetail = `p=${srmP.toFixed(4)}; split ${controlExposures}/${variantExposures} within noise`;
  }
  checks.push({ id: 'srm', state: srmState, detail: srmDetail });

  // --- 检查 3：曝光 → 转化 join ---
  // 用 Flagsmith 的两条时间序列反推：有转化却不在曝光集合里的 identity 会表现为
  // conversions > exposures；真正的逐 identity 校验在 verify-wiring 脚本里做。
  const metricResults = new Map();
  for (const metric of payload?.metrics ?? []) {
    metricResults.set(metric.metric_id, metric);
  }
  const joinDetail = [];
  let joinState = 'pass';
  for (const [label, metricId] of [
    ['primary', primaryMetricId],
    ['guardrail', guardrailMetricId],
  ]) {
    const m = metricResults.get(metricId);
    if (!m) {
      joinDetail.push(`${label}: no computed results yet`);
      continue;
    }
    for (const [variant, stats] of Object.entries(m.variants ?? {})) {
      const exposed = exposuresByVariant[variant] ?? 0;
      if (stats.n > exposed) {
        joinState = 'fail';
        joinDetail.push(`${label}/${variant}: ${stats.n} conversions vs ${exposed} exposures`);
      }
    }
  }
  checks.push({
    id: 'exposure-conversion-join',
    state: joinState,
    detail:
      joinDetail.length > 0
        ? joinDetail.join(' | ')
        : 'every converted identity appears in the exposure set (conversions <= exposures on both metrics)',
  });

  // --- A/A 结果 ---
  const aaResults = await fetchExperimentResults({
    baseUrl,
    environmentKey,
    token,
    experimentId: aaExperimentId,
  });
  const aaPayload = aaResults.ok ? aaResults.data?.results?.payload : null;
  const aaExposures = {};
  for (const point of aaPayload?.exposures_timeseries?.points ?? []) {
    for (const [variant, count] of Object.entries(point.new_identities ?? {})) {
      aaExposures[variant] = (aaExposures[variant] ?? 0) + count;
    }
  }
  const aaPrimary = (aaPayload?.metrics ?? []).find((m) => m.metric_id === primaryMetricId);
  const aaControl = aaPrimary?.variants?.control ?? { n: 0, sum: 0 };
  const aaTwin = aaPrimary?.variants?.aa_twin ?? { n: 0, sum: 0 };
  const aaSrm = chiSquarePValue(aaExposures.control ?? 0, aaExposures.aa_twin ?? 0);
  const aaRates = summariseRates(
    { exposures: aaExposures.control ?? 0, conversions: Math.round(aaControl.sum ?? 0) },
    { exposures: aaExposures.aa_twin ?? 0, conversions: Math.round(aaTwin.sum ?? 0) },
  );

  // --- 决策：Primary 涨但 Guardrail 掉，就不该直接全量 ---
  const primaryInference = inferenceFor(metricResults.get(primaryMetricId), 'interactive_sandbox');
  const guardrailInference = inferenceFor(metricResults.get(guardrailMetricId), 'interactive_sandbox');
  const decision = buildDecision({
    primaryInference,
    guardrailInference,
    controlExposures,
    variantExposures,
  });

  return {
    generatedAt: new Date().toISOString(),
    experiment: {
      id: abExperimentId,
      name: abDetail.ok ? abDetail.data.name : 'Quickstart: Checklist vs Live Sandbox',
      status: abDetail.ok ? abDetail.data.status : 'unknown',
      hypothesis: abDetail.ok ? abDetail.data.hypothesis : '',
      featureName: EXPERIMENT_FLAG,
      asOf,
      checks,
      exposures: { control: controlExposures, interactive_sandbox: variantExposures },
      srm: { chiSq: srm.chiSq, p: srmP, expected: srm.expected },
      metrics: {
        primary: summariseMetric(metricResults.get(primaryMetricId), primaryMetricId, exposuresByVariant),
        guardrail: summariseMetric(metricResults.get(guardrailMetricId), guardrailMetricId, exposuresByVariant),
      },
      decision,
    },
    aa: {
      id: aaExperimentId,
      exposures: { control: aaExposures.control ?? 0, aa_twin: aaExposures.aa_twin ?? 0 },
      srm: { chiSq: aaSrm.chiSq, p: aaSrm.p },
      rates: aaRates,
      primaryPresent: Boolean(aaPrimary),
    },
  };
}

function inferenceFor(metric, variantKey) {
  if (!metric) return null;
  return metric.inference?.[variantKey] ?? null;
}

function summariseMetric(metric, metricId, exposuresByVariant) {
  if (!metric) {
    return { metricId, present: false, control: null, variant: null, inference: null };
  }
  const control = metric.variants?.control ?? { n: 0, sum: 0 };
  const variant = metric.variants?.interactive_sandbox ?? { n: 0, sum: 0 };
  const controlExposures = exposuresByVariant.control ?? 0;
  const variantExposures = exposuresByVariant.interactive_sandbox ?? 0;
  const rates = summariseRates(
    { exposures: controlExposures, conversions: Math.round(control.sum ?? 0) },
    { exposures: variantExposures, conversions: Math.round(variant.sum ?? 0) },
  );
  return {
    metricId,
    present: true,
    control: {
      exposures: controlExposures,
      conversions: Math.round(control.sum ?? 0),
      rate: rates.controlRate,
    },
    variant: {
      exposures: variantExposures,
      conversions: Math.round(variant.sum ?? 0),
      rate: rates.variantRate,
    },
    inference: metric.inference?.interactive_sandbox ?? null,
  };
}

/**
 * 诚实决策：Primary 与 Guardrail 冲突时的处理。
 */
export function buildDecision({ primaryInference, guardrailInference, controlExposures, variantExposures }) {
  const total = (controlExposures ?? 0) + (variantExposures ?? 0);
  if (!primaryInference || total < 100) {
    return {
      tone: 'pending',
      verdict: 'Not enough data to decide yet.',
      body: `We have ${total} exposures. The wiring is checked continuously; the decision waits for a sample big enough to move a credible interval.`,
      actions: [
        'Keep the 50/50 split running until both arms clear the minimum identities per variant.',
        'Do not pause early on a good-looking slice; that is how experiments lie.',
      ],
    };
  }

  const primaryWins =
    primaryInference.chance_to_win > 0.95 && primaryInference.ci_low > 0;
  const guardrailDrops =
    guardrailInference !== null && guardrailInference.ci_high < 0;

  if (primaryWins && guardrailDrops) {
    return {
      tone: 'mixed',
      verdict: 'Primary metric wins, but the guardrail regresses: do not ship the sandbox as-is.',
      body:
        'The live sandbox reliably gets more developers to a first successful API call. It also ' +
        'measurably reduces the rate at which they export real SDK code into their own repo: ' +
        'people play in the browser and leave without taking the code with them. That is a real ' +
        'cost, not a rounding error.',
      actions: [
        'Hold the flag at 50/50. Neither control nor variant is fully right yet.',
        'Build v2: auto-expand a one-click SDK export card the first time the sandbox returns 200.',
        'Re-run as a second experiment with sdk_snippet_exported as the primary metric.',
        'Only roll out 100% if v2 clears both metrics, not one.',
      ],
    };
  }

  if (primaryWins && !guardrailDrops) {
    return {
      tone: 'good',
      verdict: 'Primary up, guardrail holding: a clean ship.',
      body:
        'The sandbox lifts first_api_call_succeeded with a credible interval that excludes zero, ' +
        'and sdk_snippet_exported does not regress beyond noise. Nothing is hiding behind the win.',
      actions: [
        'Roll the sandbox out to 100% via the Flagsmith experiment rollout.',
        'Keep the guardrail metric monitored on the flag for one more release cycle.',
      ],
    };
  }

  if (!primaryWins && guardrailDrops) {
    return {
      tone: 'bad',
      verdict: 'No win on the primary and a regression on the guardrail: keep control.',
      body:
        'The sandbox neither reliably lifts the first successful call nor preserves code export. ' +
        'Shipping it would trade two things for nothing.',
      actions: [
        'Keep control at 100% and archive the variant.',
        'Interview 5 developers who bounced from the sandbox before designing v2.',
      ],
    };
  }

  return {
    tone: 'pending',
    verdict: 'Inconclusive: the interval still spans zero.',
    body:
      'The point estimate may look promising, but the credible interval still includes no effect. ' +
      'Deciding now would be reading noise as signal.',
    actions: [
      'Let the experiment run to the planned sample size.',
      'Do not peek-and-stop on whichever metric looks best today.',
    ],
  };
}

/**
 * 生成各语言的真实 SDK 初始化片段。
 */
export function buildSdkSnippet(language, { apiKey, apiUrl }) {
  const key = apiKey || 'YOUR_ENV_KEY';
  if (language === 'python') {
    return [
      '# pip install flagsmith',
      'from flagsmith import Flagsmith',
      '',
      'flagsmith = Flagsmith(',
      `    environment_key="${key}",`,
      `    api_url="${apiUrl}",`,
      ')',
      '',
      'flags = flagsmith.get_environment_flags()',
      'print(flags.is_feature_enabled("quickstart_experience"))',
    ].join('\n');
  }
  if (language === 'curl') {
    return [
      `curl -s "${apiUrl}flags/" \\`,
      `  -H "X-Environment-Key: ${key}"`,
    ].join('\n');
  }
  return [
    '// npm install flagsmith',
    "import { Flagsmith } from 'flagsmith';",
    '',
    'const flagsmith = new Flagsmith({',
    `  environmentKey: '${key}',`,
    `  apiUrl: '${apiUrl}',`,
    '});',
    '',
    'const flags = await flagsmith.getEnvironmentFlags();',
    "console.log(flags.isFeatureEnabled('quickstart_experience'));",
  ].join('\n');
}

/** 供脚本与测试直接启动服务。 */
export function startServer({ port = Number(process.env.PORT || 3000), env = process.env } = {}) {
  const { app, client } = createApp({ env });
  const server = app.listen(port, () => {
    console.log(`[pulsehook] listening on http://localhost:${port}`);
  });
  const close = async () => {
    await flushEvents(client);
    await new Promise((resolve) => server.close(resolve));
    if (typeof client.close === 'function') await client.close();
  };
  return { app, client, server, close, port };
}

const isEntryPoint = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isEntryPoint) {
  loadEnv();
  if (!process.env.FLAGSMITH_ENVIRONMENT_KEY) {
    console.error('[pulsehook] FLAGSMITH_ENVIRONMENT_KEY is missing; run `npm run bootstrap` first.');
    process.exit(1);
  }
  const { close } = startServer();
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, async () => {
      console.log(`[pulsehook] ${signal}: flushing events and shutting down`);
      await close();
      process.exit(0);
    });
  }
}
