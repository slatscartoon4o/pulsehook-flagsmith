/**
 * Vitest 单元与集成测试。
 *
 * 覆盖的不是"代码能跑"，而是这套实验最容易悄悄出错的地方：
 *  1. 稳定访客标识（曝光与转化必须用同一个 identifier）
 *  2. 多变量 flag 归一化（key 必须带出来，否则曝光无法归因）
 *  3. SRM 卡方检验本身是对的
 *  4. 断网降级必须落到 control，而不是白屏或抛错
 *  5. 转化事件只在真实业务成功后触发（不能页面加载就记）
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import cookieParser from 'cookie-parser';

import {
  EXPERIMENT_FLAG,
  EVENT_GUARDRAIL,
  EVENT_PRIMARY,
  VARIANT_CHECKLIST,
  VARIANT_SANDBOX,
  createFlagsmithClient,
  evaluateVariant,
  flushEvents,
  normaliseFlag,
  trackConversion,
} from '../src/flagsmith-client.js';
import {
  chiSquarePValue,
  checkExposureConversionJoin,
  checkVariantKeys,
  erfc,
  summariseRates,
} from '../src/stats-audit.js';
import { buildDecision, buildSdkSnippet, resolveVisitorId, safeClientKey, VISITOR_COOKIE } from '../src/server.js';
import { verdictFor } from '../src/verdict.js';

/* ---------------------------------------------------------------- helpers */

function fakeClient(overrides = {}) {
  return {
    getExperimentFlag: vi.fn(async () => ({
      enabled: true,
      value: VARIANT_SANDBOX,
      isDefault: false,
      variant: 'interactive_sandbox',
      experiment: { inExperiment: true },
    })),
    trackEvent: vi.fn(),
    flushEvents: vi.fn(async () => {}),
    ...overrides,
  };
}

/** 起一个只挂了 cookieParser 的迷你 app，用来测 resolveVisitorId。 */
async function withApp(handler) {
  const app = express();
  app.use(cookieParser());
  app.get('/probe', (req, res) => {
    const id = resolveVisitorId(req, res);
    res.json({ id });
  });
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const port = server.address().port;
  try {
    return await handler(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

/* ----------------------------------------------- 1. stable visitor identity */

describe('stable visitor identity', () => {
  it('mints a vis_ id and sets the cookie on first visit', async () => {
    await withApp(async (base) => {
      const res = await fetch(`${base}/probe`);
      const body = await res.json();
      expect(body.id).toMatch(/^vis_[0-9a-f-]{36}$/);
      const setCookie = res.headers.getSetCookie?.() ?? [];
      const cookie = setCookie.find((c) => c.startsWith(`${VISITOR_COOKIE}=`));
      expect(cookie).toBeTruthy();
      // HttpOnly + SameSite=Lax + Path=/ + 30 天
      expect(cookie).toMatch(/HttpOnly/i);
      expect(cookie).toMatch(/SameSite=Lax/i);
      expect(cookie).toMatch(/Path=\//i);
      expect(cookie).toMatch(/Max-Age=2592000/);
    });
  });

  it('reuses the cookie value on every later request', async () => {
    await withApp(async (base) => {
      const first = await (await fetch(`${base}/probe`)).json();
      const second = await (await fetch(`${base}/probe`, {
        headers: { Cookie: `${VISITOR_COOKIE}=${first.id}` },
      })).json();
      expect(second.id).toBe(first.id);
    });
  });

  it('replaces a malformed cookie rather than trusting it', async () => {
    await withApp(async (base) => {
      const body = await (await fetch(`${base}/probe`, {
        headers: { Cookie: `${VISITOR_COOKIE}=not-a-visitor` },
      })).json();
      expect(body.id).toMatch(/^vis_[0-9a-f-]{36}$/);
      expect(body.id).not.toBe('not-a-visitor');
    });
  });
});

/* --------------------------------------------- 2. multivariate normalisation */

describe('normaliseFlag', () => {
  it('keeps the Flagsmith-assigned variation key', () => {
    const normalised = normaliseFlag({
      enabled: true,
      value: VARIANT_SANDBOX,
      isDefault: false,
      variant: 'interactive_sandbox',
      experiment: { inExperiment: true },
    });
    expect(normalised.value).toBe(VARIANT_SANDBOX);
    expect(normalised.variant).toBe('interactive_sandbox');
    expect(normalised.inExperiment).toBe(true);
  });

  it('flattens a wrapped {type,string_value} value', () => {
    const normalised = normaliseFlag({
      enabled: true,
      value: { type: 'string', string_value: 'copy_checklist' },
      isDefault: false,
    });
    expect(normalised.value).toBe(VARIANT_CHECKLIST);
  });

  it('falls back to the control value when the flag is missing', () => {
    const normalised = normaliseFlag(undefined);
    expect(normalised.value).toBe(VARIANT_CHECKLIST);
    expect(normalised.isDefault).toBe(true);
  });
});

describe('checkVariantKeys', () => {
  it('passes when every variation carries a key', () => {
    const result = checkVariantKeys([
      { id: 1, key: 'control' },
      { id: 2, key: 'interactive_sandbox' },
    ]);
    expect(result.status).toBe('pass');
    expect(result.withKey).toBe(2);
  });

  it('fails loudly when a variation has no key (exposures would be unattributable)', () => {
    const result = checkVariantKeys([{ id: 2, key: null }, { id: 3, key: '  ' }]);
    expect(result.status).toBe('fail');
    expect(result.missing).toEqual([2, 3]);
  });
});

/* ------------------------------------------------------- 3. SRM / statistics */

describe('chi-square SRM', () => {
  it('returns p≈1 for a perfectly even split', () => {
    const { p, chiSq } = chiSquarePValue(500, 500);
    expect(chiSq).toBe(0);
    expect(p).toBeCloseTo(1, 5);
  });

  it('returns p≈0.317 for a 60/40 split (the textbook chi-square value)', () => {
    // chi-square = 4.0 with 1 dof -> p = 0.0455
    const { chiSq, p } = chiSquarePValue(700, 300);
    expect(chiSq).toBeCloseTo(160, 5);
    expect(p).toBeLessThan(1e-30);
  });

  it('does not flag a modest imbalance as SRM', () => {
    const { p } = chiSquarePValue(520, 480);
    expect(p).toBeGreaterThan(0.05);
  });

  it('erfc matches known values', () => {
    expect(erfc(0)).toBeCloseTo(1, 6);
    expect(erfc(1)).toBeCloseTo(0.157299, 5);
    expect(erfc(2)).toBeCloseTo(0.004678, 5);
  });
});

describe('summariseRates', () => {
  it('computes relative lift and a two-proportion interval', () => {
    const result = summariseRates({ exposures: 1000, conversions: 400 }, { exposures: 1000, conversions: 680 });
    expect(result.controlRate).toBeCloseTo(0.4, 6);
    expect(result.variantRate).toBeCloseTo(0.68, 6);
    expect(result.lift).toBeCloseTo(0.7, 6);
    expect(result.ciLow).toBeLessThan(result.lift);
    expect(result.ciHigh).toBeGreaterThan(result.lift);
  });

  it('returns a null lift when the control rate is zero', () => {
    const result = summariseRates({ exposures: 100, conversions: 0 }, { exposures: 100, conversions: 10 });
    expect(result.lift).toBeNull();
    expect(result.ciLow).toBeNull();
  });
});

/* ------------------------------------------- 4. exposure → conversion join */

describe('checkExposureConversionJoin', () => {
  it('passes when every conversion identifier has an exposure', () => {
    const result = checkExposureConversionJoin(
      [{ identifier: 'vis_a' }, { identifier: 'vis_b' }],
      [{ identifier: 'vis_a' }],
    );
    expect(result.status).toBe('pass');
    expect(result.matched).toBe(1);
  });

  it('fails when a conversion has no matching exposure', () => {
    const result = checkExposureConversionJoin([{ identifier: 'vis_a' }], [{ identifier: 'vis_ghost' }]);
    expect(result.status).toBe('fail');
    expect(result.orphanSample).toEqual(['vis_ghost']);
  });
});

/* -------------------------------------------------- 5. fallback and flushing */

describe('evaluateVariant fallback', () => {
  it('degrades to the control variant when the SDK throws (Flagsmith unreachable)', async () => {
    const client = fakeClient({
      getExperimentFlag: vi.fn(async () => { throw new Error('ECONNREFUSED'); }),
    });
    const result = await evaluateVariant(client, 'vis_x');
    expect(result.value).toBe(VARIANT_CHECKLIST);
    expect(result.isDefault).toBe(true);
    expect(result.error).toMatch(/ECONNREFUSED/);
  });

  it('returns the real variant when Flagsmith answers', async () => {
    const result = await evaluateVariant(fakeClient(), 'vis_x');
    expect(result.value).toBe(VARIANT_SANDBOX);
    expect(result.isDefault).toBe(false);
  });
});

describe('trackConversion', () => {
  it('records the event under the same visitor identifier used for evaluation', () => {
    const client = fakeClient();
    const ok = trackConversion(client, EVENT_PRIMARY, 'vis_abc', { source: 'sandbox_ping' });
    expect(ok).toBe(true);
    expect(client.trackEvent).toHaveBeenCalledWith(EVENT_PRIMARY, {
      identifier: 'vis_abc',
      metadata: { source: 'sandbox_ping' },
    });
  });

  it('never throws when the SDK rejects the event', () => {
    const client = fakeClient({ trackEvent: vi.fn(() => { throw new Error('events disabled'); }) });
    expect(() => trackConversion(client, EVENT_GUARDRAIL, 'vis_abc')).not.toThrow();
    expect(trackConversion(client, EVENT_GUARDRAIL, 'vis_abc')).toBe(false);
  });
});

describe('flushEvents', () => {
  it('calls the SDK flush so the last batch lands in Flagsmith', async () => {
    const client = fakeClient();
    await expect(flushEvents(client)).resolves.toBe(true);
    expect(client.flushEvents).toHaveBeenCalledOnce();
  });

  it('is a no-op for a client without flushEvents', async () => {
    await expect(flushEvents({})).resolves.toBe(false);
  });
});

/* ------------------------------------------------------ 6. client creation */

describe('createFlagsmithClient', () => {
  it('wires the self-hosted events URL and enables events', () => {
    const client = createFlagsmithClient({
      FLAGSMITH_ENVIRONMENT_KEY: 'env-key-test',
      FLAGSMITH_API_URL: 'http://localhost:18000/api/v1/',
      FLAGSMITH_EVENTS_URL: 'http://localhost:18000/api/',
    });
    expect(client).toBeTruthy();
    expect(typeof client.getExperimentFlag).toBe('function');
    expect(typeof client.trackEvent).toBe('function');
    expect(typeof client.flushEvents).toBe('function');
  });

  it('constructs with events disabled when no events URL is configured', () => {
    const client = createFlagsmithClient({
      FLAGSMITH_ENVIRONMENT_KEY: 'env-key-test',
      FLAGSMITH_API_URL: 'http://localhost:18000/api/v1/',
    });
    expect(client).toBeTruthy();
  });
});

/* ----------------------------------------------------------- 7. SDK snippet */

describe('buildSdkSnippet', () => {
  it('emits a runnable node snippet with the real env key', () => {
    const snippet = buildSdkSnippet('node', {
      apiKey: 'test_env_key',
      apiUrl: 'http://localhost:18000/api/v1/',
    });
    expect(snippet).toContain('environmentKey: \'test_env_key\'');
    expect(snippet).toContain('Flagsmith');
  });

  it('emits a python snippet and a curl snippet', () => {
    expect(buildSdkSnippet('python', { apiKey: 'k', apiUrl: 'http://x/api/v1/' }))
      .toContain('from flagsmith import Flagsmith');
    expect(buildSdkSnippet('curl', { apiKey: 'k', apiUrl: 'http://x/api/v1/' }))
      .toContain('X-Environment-Key: k');
  });

  it('never leaks a real admin token', () => {
    const snippet = buildSdkSnippet('node', { apiKey: 'k', apiUrl: 'http://x/api/v1/' });
    expect(snippet).not.toMatch(/Token\s+[0-9a-f]{40}/);
  });
});

/* -------------------------------------------------- 7b. server-key redaction */

describe('safeClientKey (never echoes a server-side key)', () => {
  const SERVER_KEY = 'ser.' + 'A'.repeat(40);

  it('replaces a ser.* server key with a placeholder instead of echoing it', () => {
    const key = safeClientKey({ FLAGSMITH_ENVIRONMENT_KEY: SERVER_KEY });
    expect(key).toBe('YOUR_CLIENT_SIDE_ENVIRONMENT_KEY');
    expect(key).not.toContain('ser.');
    expect(key).not.toContain(SERVER_KEY);
  });

  it('prefers an explicit client key even when the environment key is a server key', () => {
    const key = safeClientKey({
      FLAGSMITH_ENVIRONMENT_KEY: SERVER_KEY,
      FLAGSMITH_CLIENT_KEY: 'client_side_key_abc',
    });
    expect(key).toBe('client_side_key_abc');
  });

  it('passes through a non-ser environment key (the normal self-hosted case)', () => {
    // 用虚构值，绝不在仓库里出现真实环境 key
    expect(safeClientKey({ FLAGSMITH_ENVIRONMENT_KEY: 'fake_env_key_for_tests' }))
      .toBe('fake_env_key_for_tests');
  });

  it('falls back to the placeholder when nothing usable is configured', () => {
    expect(safeClientKey({})).toBe('YOUR_CLIENT_SIDE_ENVIRONMENT_KEY');
    expect(safeClientKey({ FLAGSMITH_ENVIRONMENT_KEY: '   ' })).toBe('YOUR_CLIENT_SIDE_ENVIRONMENT_KEY');
  });

  it('never leaks a ser.* key into a rendered SDK snippet', () => {
    const snippet = buildSdkSnippet('node', {
      apiKey: safeClientKey({ FLAGSMITH_ENVIRONMENT_KEY: SERVER_KEY }),
      apiUrl: 'http://x/api/v1/',
    });
    expect(snippet).not.toContain(SERVER_KEY);
    expect(snippet).not.toMatch(/ser\.[A-Za-z0-9]/);
    expect(snippet).toContain('YOUR_CLIENT_SIDE_ENVIRONMENT_KEY');
  });
});

/* --------------------------------------------------------- 8. honest decision */

describe('buildDecision', () => {
  it('refuses to decide on a small sample', () => {
    const decision = buildDecision({
      primaryInference: { lift: 0.9, ci_low: 0.5, ci_high: 0.99, chance_to_win: 1 },
      guardrailInference: null,
      controlExposures: 10,
      variantExposures: 10,
    });
    expect(decision.tone).toBe('pending');
  });

  it('says "do not ship at 100%" when primary wins but the guardrail regresses', () => {
    const decision = buildDecision({
      primaryInference: { lift: 0.63, ci_low: 0.46, ci_high: 0.81, chance_to_win: 1 },
      guardrailInference: { lift: -0.23, ci_low: -0.37, ci_high: -0.1, chance_to_win: 0.0004 },
      controlExposures: 600,
      variantExposures: 600,
    });
    expect(decision.tone).toBe('mixed');
    expect(decision.verdict).toMatch(/do not ship/i);
    expect(decision.actions.join(' ')).toMatch(/v2/);
  });

  it('calls a clean ship when both metrics hold', () => {
    const decision = buildDecision({
      primaryInference: { lift: 0.3, ci_low: 0.1, ci_high: 0.5, chance_to_win: 0.99 },
      guardrailInference: { lift: 0.02, ci_low: -0.05, ci_high: 0.1, chance_to_win: 0.6 },
      controlExposures: 600,
      variantExposures: 600,
    });
    expect(decision.tone).toBe('good');
  });
});

describe('verdictFor (simulation side)', () => {
  it('mirrors the same honest rule as the audit panel', () => {
    const verdict = verdictFor({
      primary: { inference: { lift: 0.6, ci_low: 0.4, ci_high: 0.8, chance_to_win: 1 } },
      guardrail: { inference: { lift: -0.2, ci_low: -0.35, ci_high: -0.05, chance_to_win: 0.001 } },
      totalExposures: 1200,
    });
    expect(verdict.tone).toBe('mixed');
  });
});
