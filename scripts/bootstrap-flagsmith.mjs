#!/usr/bin/env node
/**
 * 一键初始化本地自托管 Flagsmith，让 PulseHook 实验可复现。
 *
 * 做十件事（全部通过真实 REST API，不直接改数据库）：
 *  1. 等 /api/v1/health/ 就绪
 *  2. 登录（或创建）管理员账号
 *  3. 建组织 / 项目 / Development 环境
 *  4. 建多变量 flag `quickstart_experience`（control=copy_checklist）
 *  5. 建带 key 的 variation `interactive_sandbox`
 *  6. 连 Flagsmith 自身数据库作为 warehouse（status 必须 connected）
 *  7. 建 Primary 与 Guardrail 两个 occurrence 指标
 *  8. 建并启动 A/B 实验（100% 覆盖，50/50 分桶）
 *  9. 建并启动 A/A 校验实验 `quickstart_aa_sanity`（两组页面完全相同）
 * 10. 把 env key / admin token 写入 gitignored 的 .env
 *
 * 用法：node scripts/bootstrap-flagsmith.mjs
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENV_PATH = path.join(ROOT, '.env');

const FLAGSMITH_PORT = process.env.FLAGSMITH_PORT || '18000';
const BASE = `http://localhost:${FLAGSMITH_PORT}`;
const API = `${BASE}/api/v1`;

const ADMIN_EMAIL = process.env.FLAGSMITH_ADMIN_EMAIL || 'admin@pulsehook.local';
// 密码必须来自环境变量（.env / FLAGSMITH_ADMIN_PASSWORD），绝不内置默认值，
// 否则密钥会以明文形式进 git 历史。见 scripts/secret-scan.mjs。
const ADMIN_PASSWORD = process.env.FLAGSMITH_ADMIN_PASSWORD;

const ORG_NAME = 'PulseHook Labs';
const PROJECT_NAME = 'PulseHook';
const ENV_NAME = 'Development';
const FEATURE_NAME = 'quickstart_experience';
const AA_FEATURE_NAME = 'quickstart_aa_sanity';

const log = (...args) => console.log('[bootstrap]', ...args);
const mask = (s) => (typeof s === 'string' && s.length > 6 ? `${s.slice(0, 6)}…(${s.length} chars)` : '<empty>');

function readDotEnv() {
  if (!existsSync(ENV_PATH)) return {};
  const out = {};
  for (const line of readFileSync(ENV_PATH, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

class Api {
  constructor(base) {
    this.base = base;
    this.token = null;
  }
  headers(extra = {}) {
    const h = { 'Content-Type': 'application/json', ...extra };
    if (this.token) h.Authorization = `Token ${this.token}`;
    return h;
  }
  async request(method, url, body) {
    const res = await fetch(`${this.base}${url}`, {
      method,
      headers: this.headers(),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    return { ok: res.ok, status: res.status, data };
  }
  get(url) { return this.request('GET', url); }
  post(url, body) { return this.request('POST', url, body ?? {}); }
  patch(url, body) { return this.request('PATCH', url, body ?? {}); }
}

async function waitForHealth(timeoutMs = 240000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const res = await fetch(`${API}/health/`);
      if (res.ok) return true;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 3000));
  }
  throw new Error('Flagsmith did not become healthy in time');
}

async function firstOrCreate(list, predicate, create) {
  const found = list.find(predicate);
  if (found) return { item: found, created: false };
  const created = await create();
  return { item: created, created: true };
}

async function main() {
  if (!ADMIN_PASSWORD) {
    throw new Error(
      'FLAGSMITH_ADMIN_PASSWORD is not set. Put it in .env (gitignored) — never hardcode it here.',
    );
  }
  const existingEnv = readDotEnv();

  log('waiting for Flagsmith at', BASE);
  await waitForHealth();
  log('health OK');

  const api = new Api(API);

  // ---- 2. 登录 ----
  let login = await api.post('/auth/login/', { email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
  if (!login.ok) {
    log('login failed; trying self-registration (local-only stack)');
    const reg = await api.post('/auth/users/', {
      email: ADMIN_EMAIL,
      password: ADMIN_PASSWORD,
      first_name: 'Pulse',
      last_name: 'Hook',
      sign_up_type: 'NO_INVITE',
      marketing_consent_given: false,
    });
    if (!reg.ok) throw new Error(`login and registration both failed: ${JSON.stringify(reg.data)}`);
    login = await api.post('/auth/login/', { email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
    if (!login.ok) throw new Error(`login after registration failed: ${JSON.stringify(login.data)}`);
  }
  api.token = login.data.key;
  log('authenticated as', ADMIN_EMAIL, 'token', mask(api.token));

  // ---- 3. 组织 / 项目 / 环境 ----
  const orgs = await api.get('/organisations/');
  const orgList = Array.isArray(orgs.data?.results) ? orgs.data.results : Array.isArray(orgs.data) ? orgs.data : [];
  let org = orgList.find((o) => o.name === ORG_NAME);
  if (!org) {
    const res = await api.post('/organisations/', { name: ORG_NAME });
    if (!res.ok) throw new Error(`create org failed: ${JSON.stringify(res.data)}`);
    org = res.data;
    log('created organisation', org.id, org.name);
  } else {
    log('reusing organisation', org.id, org.name);
  }

  const projectList = org.projects ?? [];
  let project = projectList.find((p) => p.name === PROJECT_NAME);
  if (!project) {
    const res = await api.post('/projects/', { name: PROJECT_NAME, organisation: org.id });
    if (!res.ok) throw new Error(`create project failed: ${JSON.stringify(res.data)}`);
    project = res.data;
    log('created project', project.id, project.name);
  } else {
    log('reusing project', project.id, project.name);
  }

  const envsRes = await api.get(`/environments/?project=${project.id}`);
  const envList = Array.isArray(envsRes.data?.results) ? envsRes.data.results : Array.isArray(envsRes.data) ? envsRes.data : [];
  let environment = envList.find((e) => e.name === ENV_NAME);
  if (!environment) {
    const res = await api.post('/environments/', { name: ENV_NAME, project: project.id });
    if (!res.ok) throw new Error(`create environment failed: ${JSON.stringify(res.data)}`);
    environment = res.data;
    log('created environment', environment.id, environment.name);
  } else {
    log('reusing environment', environment.id, environment.name);
  }
  const envKey = environment.api_key;
  log('environment API key', mask(envKey));

  // ---- 4/5. 多变量 flag + 带 key 的 variation ----
  async function ensureMultivariateFeature(name, controlValue, variantValue, variantKey, description) {
    const featuresRes = await api.get(`/projects/${project.id}/features/?page_size=200`);
    const features = Array.isArray(featuresRes.data?.results) ? featuresRes.data.results : [];
    let feature = features.find((f) => f.name === name);
    if (!feature) {
      const res = await api.post(`/projects/${project.id}/features/`, {
        name,
        type: 'MULTIVARIATE',
        initial_value: { type: 'string', string_value: controlValue },
        default_enabled: true,
        description,
        project: project.id,
      });
      if (!res.ok) throw new Error(`create feature ${name} failed: ${JSON.stringify(res.data)}`);
      feature = res.data;
      log('created feature', name, 'id', feature.id);
    } else {
      log('reusing feature', name, 'id', feature.id);
    }

    const detail = await api.get(`/projects/${project.id}/features/${feature.id}/`);
    const options = detail.data?.multivariate_options ?? [];
    let option = options.find((o) => o.string_value === variantValue);
    if (!option) {
      const res = await api.post(`/projects/${project.id}/features/${feature.id}/mv-options/`, {
        type: 'unicode',
        string_value: variantValue,
        key: variantKey,
        default_percentage_allocation: 50,
        feature: feature.id,
      });
      if (!res.ok) throw new Error(`create mv-option for ${name} failed: ${JSON.stringify(res.data)}`);
      option = res.data;
      log('  created variation', JSON.stringify(variantValue), 'key', option.key, 'id', option.id);
    } else {
      log('  reusing variation', JSON.stringify(variantValue), 'key', option.key, 'id', option.id);
    }

    // 硬校验：每个 variation 必须有非空 key，否则曝光无法归因
    const verify = await api.get(`/projects/${project.id}/features/${feature.id}/`);
    const bad = (verify.data?.multivariate_options ?? []).filter((o) => !o.key);
    if (bad.length > 0) {
      throw new Error(`variation without key on ${name}: ${JSON.stringify(bad)}`);
    }
    return { feature: verify.data, option };
  }

  const mainFlag = await ensureMultivariateFeature(
    FEATURE_NAME,
    'copy_checklist',
    'interactive_sandbox',
    'interactive_sandbox',
    'Quickstart experience: copy-paste checklist (control) vs live interactive sandbox (variant).',
  );
  const aaFlag = await ensureMultivariateFeature(
    AA_FEATURE_NAME,
    'copy_checklist',
    'copy_checklist',
    'aa_twin',
    'A/A sanity twin: both variations render the identical checklist page.',
  );

  // ---- 6. Warehouse 连接 ----
  const whRes = await api.get(`/environments/${envKey}/warehouse-connections/`);
  const whList = Array.isArray(whRes.data) ? whRes.data : Array.isArray(whRes.data?.results) ? whRes.data.results : [];
  let conn = whList.find((c) => c.config?.source === 'flagsmith_database');
  if (!conn) {
    const res = await api.post(`/environments/${envKey}/warehouse-connections/`, {
      warehouse_type: 'postgres',
      config: { source: 'flagsmith_database' },
    });
    if (!res.ok) throw new Error(`warehouse connection failed: ${JSON.stringify(res.data)}`);
    conn = res.data;
    log('created warehouse connection id', conn.id);
  } else {
    log('reusing warehouse connection id', conn.id);
  }
  if (conn.status !== 'connected') {
    throw new Error(`warehouse connection is "${conn.status}" (expected "connected"): ${conn.status_detail ?? ''}`);
  }
  log('warehouse status:', conn.status);

  // ---- 7. 指标 ----
  async function ensureMetric(name, event, description, aggregation = 'occurrence') {
    const res = await api.get(`/environments/${envKey}/experiment-metrics/?page_size=200`);
    const list = Array.isArray(res.data?.results) ? res.data.results : Array.isArray(res.data) ? res.data : [];
    let metric = list.find((m) => m.definition?.event === event);
    if (!metric) {
      const created = await api.post(`/environments/${envKey}/experiment-metrics/`, {
        name,
        description,
        aggregation,
        direction: 'up',
        definition: { version: 1, event },
      });
      if (!created.ok) throw new Error(`create metric ${event} failed: ${JSON.stringify(created.data)}`);
      metric = created.data;
      log('created metric', name, '->', event, 'id', metric.id);
    } else {
      log('reusing metric', name, '->', event, 'id', metric.id);
    }
    return metric;
  }

  const primaryMetric = await ensureMetric(
    'First API Call Succeeded',
    'first_api_call_succeeded',
    'Primary: visitor made a real successful POST /api/v1/sandbox/ping',
  );
  const guardrailMetric = await ensureMetric(
    'SDK Snippet Exported (Guardrail)',
    'sdk_snippet_exported',
    'Guardrail: visitor exported real SDK code to their own repo',
  );

  // ---- 8/9. 实验 ----
  async function ensureExperiment({ feature, name, hypothesis, metrics, controlValue, variation }) {
    const res = await api.get(`/environments/${envKey}/experiments/?page_size=200`);
    const list = Array.isArray(res.data?.results) ? res.data.results : Array.isArray(res.data) ? res.data : [];
    const featureId = feature.id;
    const existing = list.find((e) => e.feature === featureId || e.feature?.id === featureId);
    if (existing) {
      log('reusing experiment', existing.id, existing.name, 'status', existing.status);
      return existing;
    }
    const created = await api.post(`/environments/${envKey}/experiments/`, {
      feature: featureId,
      name,
      hypothesis,
      metrics: metrics.map((m) => ({ metric: m.id, expected_direction: m.expected_direction })),
      experiment_rollout: {
        enabled: true,
        rollout_percentage: 100,
        feature_state_value: { type: 'string', value: controlValue },
        multivariate_feature_state_values: [
          { multivariate_feature_option: variation.id, percentage_allocation: 50 },
        ],
      },
    });
    if (!created.ok) throw new Error(`create experiment ${name} failed: ${JSON.stringify(created.data)}`);
    const started = await api.post(`/environments/${envKey}/experiments/${created.data.id}/start/`);
    if (!started.ok) throw new Error(`start experiment ${name} failed: ${JSON.stringify(started.data)}`);
    if (started.data?.status !== 'running') {
      throw new Error(`experiment ${name} is "${started.data?.status}" after start, expected "running"`);
    }
    log('created + started experiment', created.data.id, name, 'status', started.data.status);
    return started.data;
  }

  const abExperiment = await ensureExperiment({
    feature: mainFlag.feature,
    name: 'Quickstart: Checklist vs Live Sandbox',
    hypothesis:
      'Giving developers a pre-filled live interactive webhook sandbox increases first_api_call_succeeded by at least 15% relative, without collapsing sdk_snippet_exported.',
    metrics: [
      { ...primaryMetric, expected_direction: 'increase' },
      { ...guardrailMetric, expected_direction: 'not_decrease' },
    ],
    controlValue: 'copy_checklist',
    variation: mainFlag.option,
  });

  const aaExperiment = await ensureExperiment({
    feature: aaFlag.feature,
    name: 'A/A Sanity: Checklist vs Its Twin',
    hypothesis:
      'Two identical checklist pages split 50/50 must show no systematic difference in first_api_call_succeeded; any lift outside the credible interval means the wiring is biased.',
    metrics: [{ ...primaryMetric, expected_direction: 'increase' }],
    controlValue: 'copy_checklist',
    variation: aaFlag.option,
  });

  // ---- 10. 写 .env ----
  const nextEnv = {
    ...existingEnv,
    FLAGSMITH_API_URL: `${BASE}/api/v1/`,
    FLAGSMITH_EVENTS_URL: `${BASE}/api/`,
    FLAGSMITH_ENVIRONMENT_KEY: envKey,
    FLAGSMITH_ENVIRONMENT_API_KEY: envKey,
    FLAGSMITH_ADMIN_EMAIL: ADMIN_EMAIL,
    FLAGSMITH_ADMIN_PASSWORD: ADMIN_PASSWORD,
    FLAGSMITH_ADMIN_TOKEN: api.token,
    FLAGSMITH_ORGANISATION_ID: String(org.id),
    FLAGSMITH_PROJECT_ID: String(project.id),
    FLAGSMITH_ENVIRONMENT_ID: String(environment.id),
    FLAGSMITH_FEATURE_ID: String(mainFlag.feature.id),
    FLAGSMITH_AA_FEATURE_ID: String(aaFlag.feature.id),
    FLAGSMITH_AB_EXPERIMENT_ID: String(abExperiment.id),
    FLAGSMITH_AA_EXPERIMENT_ID: String(aaExperiment.id),
    FLAGSMITH_PRIMARY_METRIC_ID: String(primaryMetric.id),
    FLAGSMITH_GUARDRAIL_METRIC_ID: String(guardrailMetric.id),
    PORT: existingEnv.PORT || '3000',
  };
  const content = Object.entries(nextEnv)
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
  writeFileSync(ENV_PATH, `${content}\n`, 'utf8');
  writeFileSync(
    path.join(ROOT, 'flagsmith.env'),
    `${content}\n`,
    'utf8',
  );

  log('wrote .env and flagsmith.env');
  console.log('\n=== bootstrap summary ===');
  console.log(JSON.stringify({
    environmentKey: mask(envKey),
    abExperimentId: abExperiment.id,
    aaExperimentId: aaExperiment.id,
    primaryMetricId: primaryMetric.id,
    guardrailMetricId: guardrailMetric.id,
  }, null, 2));
}

main().catch((error) => {
  console.error('[bootstrap] FAILED:', error.message);
  process.exit(1);
});
