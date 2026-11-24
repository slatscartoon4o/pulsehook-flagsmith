/**
 * 极简 .env 加载器（Node 22 未内置 --env-file 跨版本一致性保证时使用）。
 * 不引入 dotenv 依赖，避免多余供应链面。
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function loadEnv(file = path.join(ROOT, '.env')) {
  if (!existsSync(file)) return {};
  const loaded = {};
  for (const raw of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    loaded[key] = value;
    if (process.env[key] === undefined) process.env[key] = value;
  }
  return loaded;
}
