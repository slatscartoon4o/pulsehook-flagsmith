#!/usr/bin/env node
/**
 * 零密钥泄露扫描：对"将被 git 跟踪的文件"逐一搜真实密钥与绝对路径。
 *
 * 检索目标：
 *  1. 真实 Flagsmith environment key（来自 .env，逐字节精确匹配）
 *  2. 真实 admin password（逐字节精确匹配）
 *  3. 真实 admin token（逐字节精确匹配 + 通用 40-hex token 形态）
 *  4. 通用密钥形态（sk- / Bearer / Token 40hex / X-Environment-Key 带真值）
 *  5. 本机绝对路径（盘符: 开头的路径、用户主目录等机器特定前缀）
 *
 * 用法：node scripts/secret-scan.mjs   （退出码非 0 即有泄露）
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { ROOT, loadEnv } from '../src/env.js';

loadEnv();

/** 会被 git 跟踪的文件白名单（.gitignore 之外的源文件）。 */
const TRACKED_DIRS = ['src', 'scripts', 'tests', 'docs'];
const TRACKED_ROOT_FILES = [
  '.env.example', '.gitignore', 'docker-compose.yml',
  'package.json', 'package-lock.json', 'README.md',
];
const TEXT_EXT = /\.(mjs|js|json|md|html|css|txt|yml|yaml|example|gitignore)$/;

function collectFiles(dir, out) {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === 'node_modules' || name === 'tmp') continue;
      collectFiles(full, out);
    } else if (TEXT_EXT.test(name)) {
      out.push(full);
    }
  }
  return out;
}

const files = [...TRACKED_ROOT_FILES.map((f) => path.join(ROOT, f))];
for (const dir of TRACKED_DIRS) {
  const dirPath = path.join(ROOT, dir);
  if (statSync(dirPath).isDirectory() && dir !== 'docs') collectFiles(dirPath, files);
}
// docs：只扫 json/md（截图与视频是二进制，不进文本扫描，且截图里不含密钥值）
collectFiles(path.join(ROOT, 'docs'), files);
const docBinaries = readdirSync(path.join(ROOT, 'docs', 'screenshots')).map(
  (f) => path.join(ROOT, 'docs', 'screenshots', f),
);

/** 逐字节的真值匹配（防止正则元字符意外逃逸）。 */
function buildLiteralNeedles(env) {
  const needles = [];
  const push = (label, value) => {
    if (value && String(value).length >= 8) needles.push({ label, value: String(value) });
  };
  push('FLAGSMITH_ENVIRONMENT_KEY (real value)', env.FLAGSMITH_ENVIRONMENT_KEY);
  push('FLAGSMITH_ENVIRONMENT_API_KEY (real value)', env.FLAGSMITH_ENVIRONMENT_API_KEY);
  push('FLAGSMITH_ADMIN_PASSWORD (real value)', env.FLAGSMITH_ADMIN_PASSWORD);
  push('FLAGSMITH_ADMIN_TOKEN (real value)', env.FLAGSMITH_ADMIN_TOKEN);
  push('FLAGSMITH_ADMIN_EMAIL (real value)', env.FLAGSMITH_ADMIN_EMAIL);
  return needles;
}

const PATTERNS = [
  { label: 'generic 40-hex token after "Token "', re: /Token\s+[0-9a-f]{40}\b/gi },
  { label: 'Bearer credential', re: /Bearer\s+[0-9A-Za-z._-]{20,}\b/g },
  { label: 'OpenAI-style key', re: /sk-[0-9A-Za-z]{20,}/g },
  { label: 'postgres password literal', re: /POSTGRES_PASSWORD\s*=\s*(?!change_me)\S+/gi },
  { label: 'Django secret literal', re: /SECRET_KEY\s*=\s*(?!change_me)\S+/gi },
  // 机器特定路径：任何盘符都在此列，不绑定具体机器
  { label: 'Windows absolute path (any drive)', re: /\b[A-Za-z]:\\+[A-Za-z0-9_.\-]/g },
  { label: 'drive-prefixed posix path (any drive)', re: /\b[A-Za-z]:\/+[A-Za-z0-9_.\-]/g },
  { label: 'user home path (posix)', re: /\/Users\/[A-Za-z]/g },
  { label: 'user home path (unix /home)', re: /\/home\/[A-Za-z]/g },
];

const allow = [
  // .env.example 的占位符与文档中的示意路径是刻意的
  /change_me_local_only/i,
  // 本地虚构占位邮箱（.env.example 的默认值），不是真实身份信息
  /admin@pulsehook\.local/i,
  // C:\Users\ 出现在注释里说明"不提交个人路径"这类警示语时放行
  /不提交|never hardcode|个人目录|avoid.*git/i,
];

let totalHits = 0;
const report = [];

for (const file of files) {
  // 扫描器自身的正则文本天然包含这些形态，自匹配无意义
  if (file.endsWith(path.join('secret-scan.mjs'))) continue;
  let text;
  try { text = readFileSync(file, 'utf8'); } catch { continue; }
  const rel = path.relative(ROOT, file).split(path.sep).join('/');
  const hits = [];

  for (const { label, value } of buildLiteralNeedles(process.env)) {
    if (allow.some((a) => a.test(value))) continue;
    let idx = text.indexOf(value);
    while (idx !== -1) {
      const line = text.slice(0, idx).split(String.fromCharCode(10)).length;
      hits.push(`${rel}:${line}: literal ${label} [${value.slice(0, 3)}***]`);
      idx = text.indexOf(value, idx + 1);
    }
  }
  for (const { label, re } of PATTERNS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
      if (allow.some((a) => a.test(m[0]))) continue;
      const line = text.slice(0, m.index).split(String.fromCharCode(10)).length;
      hits.push(`${rel}:${line}: ${label} "${m[0].slice(0, 24)}"`);
    }
  }
  if (hits.length > 0) {
    totalHits += hits.length;
    report.push(...hits);
  }
}

// 二进制制品只确认存在与非空（读 PNG 是被禁止的，不解析内容）
console.log(`scanned ${files.length} text files + ${docBinaries.length} binary artifacts`);
for (const bin of docBinaries) {
  if (!statSync(bin).size) { totalHits += 1; report.push(`${path.relative(ROOT, bin)}: EMPTY artifact`); }
}

if (totalHits > 0) {
  console.error(`\nSECRET SCAN FAILED: ${totalHits} hit(s)`);
  for (const r of report) console.error(`  - ${r}`);
  process.exit(1);
}
console.log('\nSECRET SCAN PASSED: 0 hits in git-tracked files');
