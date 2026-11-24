#!/usr/bin/env node
/**
 * Playwright 截图与演示录制。
 *
 * 纪律：
 *  - 绝不用 Read 工具读 PNG；布局是否正确一律通过 DOM 断言判断
 *    （零横向溢出、零文字截断、元素高度合理）。
 *  - 截图 1440x900，保存到 docs/screenshots/。
 *  - 演示视频录到 artifacts/tmp，若有 ffmpeg 则转 H.264 存 docs/demo/。
 *
 * 用法：node scripts/capture-demo.mjs
 */
import { mkdirSync, existsSync, renameSync, rmSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { chromium } from 'playwright';

import { loadEnv, ROOT } from '../src/env.js';

const TARGET = `http://localhost:${process.env.PULSEHOOK_PORT || 3000}`;
const FLAGSMITH = process.env.FLAGSMITH_PORT || '18000';
const SHOTS = path.join(ROOT, 'docs', 'screenshots');
const DEMO = path.join(ROOT, 'docs', 'demo');
const TMP = path.join(ROOT, 'artifacts', 'tmp');

const log = (...args) => console.log('[capture]', ...args);

/**
 * 布局断言：零横向溢出、零截断、关键元素高度合理。
 * 任何一条不满足直接抛错，不生成"看起来还行"的截图。
 */
async function assertLayout(page, label) {
  const report = await page.evaluate(() => {
    const doc = document.documentElement;
    const overflow = doc.scrollWidth - doc.clientWidth;

    const clipped = [];
    const walker = document.querySelectorAll(
      'h1, h2, h3, p, li, td, th, span, strong, code, pre, button, a, label',
    );
    for (const el of walker) {
      const style = getComputedStyle(el);
      if (style.overflow === 'hidden' && style.textOverflow === 'ellipsis') continue;
      if (style.display === 'none' || style.visibility === 'hidden') continue;
      // sr-only 元素是刻意隐藏的，不参与可见性判定
      if (el.classList.contains('sr-only')) continue;
      if (style.position === 'absolute' && el.getBoundingClientRect().width <= 1) continue;
      const box = el.getBoundingClientRect();
      if (box.width === 0 || box.height === 0) continue;
      // 文字溢出：scroll 尺寸明显大于 client 尺寸，且没有滚动容器
      const overflowsX = el.scrollWidth - el.clientWidth > 2;
      const overflowsY = el.scrollHeight - el.clientHeight > 2;
      const scrollable = /auto|scroll/.test(style.overflowX + style.overflowY) ||
        el.closest('pre, .output__body, .response__json, #sandbox-payload') !== null;
      if ((overflowsX || overflowsY) && !scrollable && el.children.length === 0) {
        clipped.push({
          tag: el.tagName.toLowerCase(),
          text: (el.textContent || '').trim().slice(0, 40),
          dx: el.scrollWidth - el.clientWidth,
          dy: el.scrollHeight - el.clientHeight,
        });
      }
    }

    const main = document.querySelector('main');
    const footer = document.querySelector('.bottombar');
    return {
      overflow,
      clipped: clipped.slice(0, 5),
      clippedCount: clipped.length,
      mainHeight: main?.getBoundingClientRect().height ?? 0,
      footerHeight: footer?.getBoundingClientRect().height ?? 0,
      viewportLines: document.body.innerText.split('\n').filter((l) => l.trim()).length,
      variant: document.body.dataset.renderedVariant ?? null,
      drift: document.body.dataset.variantDrift ?? 'unknown',
    };
  });

  const problems = [];
  if (report.overflow > 1) problems.push(`horizontal overflow ${report.overflow}px`);
  if (report.clippedCount > 0) problems.push(`${report.clippedCount} clipped element(s): ${JSON.stringify(report.clipped)}`);
  if (report.mainHeight < 400) problems.push(`main too short (${report.mainHeight}px)`);
  if (report.footerHeight < 30) problems.push(`footer too short (${report.footerHeight}px)`);
  if (report.viewportLines < 12) problems.push(`too little visible text (${report.viewportLines} lines)`);

  if (problems.length > 0) {
    throw new Error(`${label}: layout check failed -> ${problems.join(' | ')}`);
  }
  log(`  layout OK (${label}): no overflow, no clipping, ${report.viewportLines} text lines`);
  return report;
}

/** 反复开新上下文，直到拿到想要的变体（Cookie 隔离，模拟不同访客）。 */async function contextWithVariant(browser, wanted, maxTries = 24) {
  for (let i = 0; i < maxTries; i += 1) {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();
    await page.goto(TARGET, { waitUntil: 'networkidle' });
    const rendered = await page.evaluate(() => document.body.dataset.renderedVariant);
    if (rendered === wanted) return { ctx, page };
    await ctx.close();
  }
  throw new Error(`could not get variant "${wanted}" in ${maxTries} tries`);
}

/**
 * fullPage 截图前必须先回到顶部再等一帧。
 * 否则 position:sticky 的 .topbar 会停在页面中段，把统计条盖住
 * （Chromium 的 beyondViewport 截图按当前滚动位置渲染 sticky 元素）。
 *
 * 判据是几何而非像素：截图瞬间 window.scrollY 必须为 0，
 * 且 .topbar 的 bounding rect top 必须为 0——这样顶栏在整页截图里只会在文档顶部出现一次。
 */
async function shootFull(page, filepath) {
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
  await page.waitForTimeout(250);

  const probe = await page.evaluate(() => {
    const bar = document.querySelector('.topbar');
    return {
      scrollY: window.scrollY,
      top: bar ? Math.round(bar.getBoundingClientRect().top) : 0,
    };
  });
  if (probe.scrollY !== 0) {
    throw new Error(`page is scrolled to ${probe.scrollY}px before a fullPage screenshot`);
  }
  if (probe.top !== 0) {
    throw new Error(`sticky topbar is not pinned to the top (top=${probe.top}px)`);
  }
  await page.screenshot({ path: filepath, fullPage: true });
}

async function shotControl(browser) {
  log('1/5 control variant');
  const { ctx, page } = await contextWithVariant(browser, 'copy_checklist');
  try {
    await page.waitForSelector('#checklist-view.is-active');
    await assertLayout(page, 'control');
    await shootFull(page, path.join(SHOTS, '1-control-checklist.png'));
    log('  saved 1-control-checklist.png');
  } finally {
    await ctx.close();
  }
}

async function shotVariant(browser) {
  log('2/5 variant sandbox (with a live 200 response)');
  const { ctx, page } = await contextWithVariant(browser, 'interactive_sandbox');
  try {
    await page.waitForSelector('#sandbox-view.is-active');
    await page.click('#sandbox-run');
    await page.waitForSelector('#response-body:not([hidden])', { timeout: 15000 });
    const status = await page.textContent('#response-status');
    if (!status?.includes('200')) throw new Error(`sandbox run did not return 200: ${status}`);
    // 出响应后空状态必须真的不可见（display:none 生效，而不是只设了 hidden 属性）
    const emptyVisible = await page.evaluate(() => {
      const empty = document.querySelector('.response__empty');
      if (!empty) return false;
      const box = empty.getBoundingClientRect();
      return getComputedStyle(empty).display !== 'none' && box.width > 0 && box.height > 0;
    });
    if (emptyVisible) throw new Error('empty-state placeholder still visible next to the 200 response');
    // toast 是 position:fixed 的，fullPage 截图里会浮在 JSON 上遮住 echoed_event 行。
    // 截图前等它自然淡出并确认不可见（视频里 toast 弹出是正常的，那一处不处理）。
    await page.waitForFunction(() => {
      const toast = document.getElementById('toast');
      if (!toast) return true;
      const style = getComputedStyle(toast);
      return toast.hidden || style.opacity === '0' || style.display === 'none';
    }, null, { timeout: 12000 });
    await page.waitForTimeout(300);
    const toastVisible = await page.evaluate(() => {
      const toast = document.getElementById('toast');
      if (!toast || toast.hidden) return false;
      const style = getComputedStyle(toast);
      return style.display !== 'none' && Number(style.opacity) > 0.05
        && toast.getBoundingClientRect().width > 0;
    });
    if (toastVisible) throw new Error('toast is still visible and would overlay the response JSON');
    await assertLayout(page, 'variant');
    await shootFull(page, path.join(SHOTS, '2-variant-sandbox.png'));
    log('  saved 2-variant-sandbox.png');
  } finally {
    await ctx.close();
  }
}

async function shotAudit(browser) {
  log('3/5 audit dashboard');
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  try {
    await page.goto(`${TARGET}/audit`, { waitUntil: 'networkidle' });
    await page.waitForFunction(() => Boolean(window.__AUDIT__), null, { timeout: 25000 });
    const states = await page.$$eval('.check', (els) =>
      els.map((el) => ({ id: el.dataset.check, state: el.dataset.state })));
    const failing = states.filter((s) => s.state === 'fail');
    if (failing.length > 0) throw new Error(`audit has failing checks: ${JSON.stringify(failing)}`);
    await assertLayout(page, 'audit');
    await shootFull(page, path.join(SHOTS, '3-audit-dashboard.png'));
    log('  saved 3-audit-dashboard.png');
  } finally {
    await ctx.close();
  }
}

/**
 * 登录 Flagsmith 后台并截真实实验页。
 */
async function loginFlagsmith(page, attempts = 3) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    await page.goto(`http://localhost:${FLAGSMITH}/`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    const emailInput = page.locator('#email, input[type="email"], input[name="email"]');
    if (await emailInput.count() === 0) {
      // 已登录且 SPA 会话已建立
      try {
        await page.waitForFunction(() => Boolean(localStorage.getItem('user')), null, { timeout: 15000 });
        return;
      } catch { /* fall through and log in explicitly */ }
    }
    if (await emailInput.count() > 0) {
      await emailInput.first().fill(process.env.FLAGSMITH_ADMIN_EMAIL);
      await page.locator('#password, input[type="password"]').first().fill(process.env.FLAGSMITH_ADMIN_PASSWORD);
      await page.locator('button[type="submit"]').first().click();
    }
    try {
      // 真正的就绪判据：localStorage.user 写入（密码框消失得太早，SPA reducer 还没 hydrate）
      await page.waitForFunction(
        () => Boolean(localStorage.getItem('user')),
        null,
        { timeout: 25000 },
      );
      await page.waitForTimeout(1500);
      return;
    } catch {
      log(`  login attempt ${attempt}: localStorage.user never appeared, retrying`);
    }
  }
  throw new Error('could not sign in to the Flagsmith dashboard');
}

/** 登录后导航到实验页；SPA 偶发重渲染登录页时重新认证并重试。 */
async function gotoExperiment(page, url, attempts = 4) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    let text = '';
    for (let i = 0; i < 25; i += 1) {
      await page.waitForTimeout(1000);
      text = await page.evaluate(() => document.body.innerText);
      const onLogin = /Sign in to Flagsmith|Log in to your account/i.test(text);
      const loaded = /Chance to be best|Users enrolled|Lift vs control|Primary Metric/i.test(text);
      if (loaded && !onLogin) return text;
      if (onLogin && i > 3) break;
    }
    log(`  experiment page attempt ${attempt} fell back to sign-in, re-authenticating`);
    await loginFlagsmith(page);
  }
  throw new Error('could not reach the experiment page after re-authenticating');
}

async function shotFlagsmithExperiment(browser, { experimentId, filename, label }) {
  log(label);
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  try {
    await loginFlagsmith(page);
    // Flagsmith 前端的 environment 路由段要的是环境 API key，不是数字 id
    const url = `http://localhost:${FLAGSMITH}/project/${process.env.FLAGSMITH_PROJECT_ID}/environment/${process.env.FLAGSMITH_ENVIRONMENT_KEY}/experiments/${experimentId}`;
    const text = await gotoExperiment(page, url);
    await page.waitForTimeout(1500);
    await shootFull(page, path.join(SHOTS, filename));
    log(`  saved ${filename}`);
    return text.slice(0, 400);
  } finally {
    await ctx.close();
  }
}

/**
 * 定位 ffmpeg：优先系统 PATH，其次 Playwright 自带的构建。
 */
function findFfmpeg() {
  const candidates = [];
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'pipe' });
    candidates.push('ffmpeg');
  } catch { /* not on PATH */ }

  // 显式覆盖（例如用户装了一个带 libx264 的完整版）：只认 FFMPEG_PATH 环境变量，
  // 不内置任何绝对路径，避免把某台机器的目录结构带进仓库。
  if (process.env.FFMPEG_PATH && existsSync(process.env.FFMPEG_PATH)) {
    candidates.unshift(process.env.FFMPEG_PATH);
  }
  // 只探测"相对于可执行文件目录"与"PATH 上"的 ffmpeg，不写死盘符。
  for (const guess of ['ffmpeg.exe', 'ffmpeg']) {
    try {
      const full = path.join(path.dirname(process.execPath), guess);
      if (existsSync(full)) candidates.push(full);
    } catch { /* skip malformed guess */ }
  }

  const base = process.env.LOCALAPPDATA
    ? path.join(process.env.LOCALAPPDATA, 'ms-playwright')
    : null;
  if (base && existsSync(base)) {
    const dirs = readdirSync(base).filter((d) => d.startsWith('ffmpeg-')).sort().reverse();
    for (const dir of dirs) {
      for (const exe of ['ffmpeg-win64.exe', 'ffmpeg.exe', 'ffmpeg-linux', 'ffmpeg-mac']) {
        const full = path.join(base, dir, exe);
        if (existsSync(full)) candidates.push(full);
      }
    }
  }

  // 必须真的能编 H.264 —— Playwright 自带的精简版只有 VP9
  for (const candidate of candidates) {
    try {
      const encoders = execFileSync(candidate, ['-encoders'], { stdio: 'pipe' }).toString();
      if (encoders.includes('libx264')) return candidate;
    } catch { /* try the next one */ }
  }
  log("  no ffmpeg with libx264 found (Playwright's build only ships VP9)");
  return null;
}

/**
 * 录制演示：2 分 15 秒 – 2 分 45 秒。
 */
async function recordDemo() {
  log('5/5 demo recording (target 2:15 - 2:45)');
  const videoDir = path.join(TMP, 'demo-video');
  rmSync(videoDir, { recursive: true, force: true });
  mkdirSync(videoDir, { recursive: true });

  const browser = await chromium.launch();
  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    recordVideo: { dir: videoDir, size: { width: 1280, height: 720 } },
  });
  const page = await ctx.newPage();
  const pause = (ms) => page.waitForTimeout(ms);
  const startedAt = Date.now();
  const elapsed = () => Math.round((Date.now() - startedAt) / 1000);

  try {
    // ---- 0:00-0:20 开场：痛点与单句假设 ----
    log(`  [${elapsed()}s] opener`);
    await page.goto(TARGET, { waitUntil: 'networkidle' });
    await pause(6000);
    await page.evaluate(() => window.scrollTo({ top: 260, behavior: 'smooth' }));
    await pause(6000);
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'smooth' }));
    await pause(5000);

    // ---- 0:20-1:05 控制组：复制粘贴清单 ----
    log(`  [${elapsed()}s] control variant walkthrough`);
    const controlCtx = await contextWithVariant(browser, 'copy_checklist');
    const controlPage = controlCtx.page;
    await controlPage.setViewportSize({ width: 1280, height: 720 });
    await pause(2500);
    await controlPage.evaluate(() => window.scrollTo({ top: 420, behavior: 'smooth' }));
    await pause(5000);
    await controlPage.click('[data-copy-target="step1"]');
    await pause(4000);
    await controlPage.click('[data-copy-target="step2"]');
    await pause(4000);
    await controlPage.click('#checklist-export');
    await pause(6000);
    await controlPage.evaluate(() => window.scrollTo({ top: 0, behavior: 'smooth' }));
    await pause(3000);
    await controlCtx.ctx.close();

    // ---- 1:05-1:50 变体：交互式沙盒实跑 ----
    log(`  [${elapsed()}s] sandbox variant walkthrough`);
    const sandboxCtx = await contextWithVariant(browser, 'interactive_sandbox');
    const sandboxPage = sandboxCtx.page;
    await sandboxPage.setViewportSize({ width: 1280, height: 720 });
    await pause(2500);
    await sandboxPage.evaluate(() => window.scrollTo({ top: 380, behavior: 'smooth' }));
    await pause(5000);
    await sandboxPage.click('#sandbox-run');
    await sandboxPage.waitForSelector('#response-body:not([hidden])', { timeout: 15000 });
    await pause(8000);
    await sandboxPage.click('#sandbox-export');
    await pause(6000);
    await sandboxPage.evaluate(() => window.scrollTo({ top: 0, behavior: 'smooth' }));
    await pause(3000);
    await sandboxCtx.ctx.close();

    // ---- 1:50-2:35 Flagsmith 官方后台：多变量 flag、指标、A/A、A/B ----
    log(`  [${elapsed()}s] Flagsmith dashboard`);
    const fsCtx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const fsPage = await fsCtx.newPage();
    await loginFlagsmith(fsPage);
    const base = `http://localhost:${FLAGSMITH}/project/${process.env.FLAGSMITH_PROJECT_ID}/environment/${process.env.FLAGSMITH_ENVIRONMENT_KEY}`;
    await gotoExperiment(fsPage, `${base}/experiments/${process.env.FLAGSMITH_AB_EXPERIMENT_ID}`);
    await pause(6000);
    await fsPage.evaluate(() => window.scrollTo({ top: 300, behavior: 'smooth' }));
    await pause(7000);
    await fsPage.evaluate(() => window.scrollTo({ top: 720, behavior: 'smooth' }));
    await pause(7000);
    await gotoExperiment(fsPage, `${base}/experiments/${process.env.FLAGSMITH_AA_EXPERIMENT_ID}`);
    await pause(5000);
    await fsPage.evaluate(() => window.scrollTo({ top: 300, behavior: 'smooth' }));
    await pause(4000);
    await fsCtx.close();

    // ---- 2:35-2:50 回到审计面板：诚实结论 ----
    log(`  [${elapsed()}s] audit panel + honest decision`);
    await page.goto(`${TARGET}/audit`, { waitUntil: 'networkidle' });
    await page.waitForFunction(() => Boolean(window.__AUDIT__), null, { timeout: 25000 });
    await pause(6000);
    await page.evaluate(() => {
      const card = document.getElementById('decision-card');
      card?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
    await pause(9000);
    log(`  [${elapsed()}s] recording finished`);
  } finally {
    await ctx.close();
    await browser.close();
  }

  const files = readdirSync(videoDir).filter((f) => f.endsWith('.webm'));
  if (files.length === 0) throw new Error('no video was recorded');
  const src = path.join(videoDir, files[0]);
  const size = statSync(src).size;
  log(`  recorded ${(size / 1024 / 1024).toFixed(1)} MB webm`);

  mkdirSync(DEMO, { recursive: true });
  const mp4 = path.join(DEMO, 'toggle-wars-demo.mp4');
  const ffmpeg = findFfmpeg();
  if (!ffmpeg) {
    log('  no ffmpeg with libx264 found; keeping the webm');
    rmSync(path.join(DEMO, 'toggle-wars-demo.webm'), { force: true });
    renameSync(src, path.join(DEMO, 'toggle-wars-demo.webm'));
    return null;
  }
  try {
    execFileSync(ffmpeg, [
      '-y', '-i', src,
      '-c:v', 'libx264', '-preset', 'medium', '-crf', '23',
      '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
      mp4,
    ], { stdio: 'pipe' });
    const mp4Size = statSync(mp4).size;
    log(`  transcoded to H.264 mp4: ${(mp4Size / 1024 / 1024).toFixed(1)} MB`);
    if (mp4Size > 25 * 1024 * 1024) {
      const alt = path.join(TMP, 'toggle-wars-demo.mp4');
      renameSync(mp4, alt);
      log(`  >25MB, moved out of git to ${alt}`);
      return alt;
    }
    return mp4;
  } catch (error) {
    log('  ffmpeg failed (' + error.message.split(String.fromCharCode(10))[0] + '); keeping the webm');
    renameSync(src, path.join(DEMO, 'toggle-wars-demo.webm'));
    return null;
  }
}

async function main() {
  loadEnv();
  mkdirSync(SHOTS, { recursive: true });
  mkdirSync(TMP, { recursive: true });

  const browser = await chromium.launch();
  try {
    await shotControl(browser);
    await shotVariant(browser);
    await shotAudit(browser);
    await shotFlagsmithExperiment(browser, {
      experimentId: process.env.FLAGSMITH_AB_EXPERIMENT_ID,
      filename: '4-flagsmith-ab-results.png',
      label: '4/5 Flagsmith A/B results page',
    });
    await shotFlagsmithExperiment(browser, {
      experimentId: process.env.FLAGSMITH_AA_EXPERIMENT_ID,
      filename: '5-flagsmith-aa-sanity.png',
      label: '   Flagsmith A/A sanity page',
    });
  } finally {
    await browser.close();
  }

  await recordDemo();
  log('done');
}

main().catch((error) => {
  console.error('[capture] FAILED:', error.message);
  process.exit(1);
});
