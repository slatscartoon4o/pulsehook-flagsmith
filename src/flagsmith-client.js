/**
 * Flagsmith SDK 封装。
 *
 * 设计目标（严格对齐 Toggle Wars Track 01 的 4 大致命接线要求）：
 *  1. 稳定访客标识 —— 由调用方传入 visitorId（来自 Cookie），本模块不生成。
 *  2. 多变量 flag 求值 —— 使用 getExperimentFlag()，SDK 会自动上报 $flag_exposure 曝光事件。
 *  3. 转化事件 —— trackEvent() 只在真实业务动作成功后调用（不页面加载即上报）。
 *  4. 事件落库 —— enableEvents + 自托管 eventsApiUrl，close() 前 flushEvents()。
 *
 * 自托管时：
 *   apiUrl       = http://localhost:18000/api/v1/
 *   eventsApiUrl = http://localhost:18000/api/      （SDK 自动拼 v1/events）
 */
import { Flagsmith } from '@flagsmith/nodejs';

export const EXPERIMENT_FLAG = 'quickstart_experience';
export const AA_FLAG = 'quickstart_aa_sanity';

export const VARIANT_CHECKLIST = 'copy_checklist';
export const VARIANT_SANDBOX = 'interactive_sandbox';
export const VARIANT_AA_TWIN = 'aa_twin';

export const EVENT_PRIMARY = 'first_api_call_succeeded';
export const EVENT_GUARDRAIL = 'sdk_snippet_exported';

const DEFAULT_FLAG_VALUE = VARIANT_CHECKLIST;

/**
 * 把 flag 求值结果归一化成前端可用的形态。
 *
 * `variant` 是 Flagsmith 分配的 variation key（身份求值才有），A/A 校验依赖它
 * 区分两个页面完全相同、但分桶不同的臂。
 * @param {import('@flagsmith/nodejs').Flag | import('@flagsmith/nodejs').DefaultFlag | undefined} flag
 * @param {string} fallback
 */
export function normaliseFlag(flag, fallback = DEFAULT_FLAG_VALUE) {
  if (!flag) {
    return { enabled: false, value: fallback, isDefault: true, variant: null, inExperiment: false };
  }
  const raw = flag.value;
  let value = raw;
  if (raw && typeof raw === 'object') {
    value = raw.string_value ?? raw.value ?? fallback;
  }
  if (typeof value !== 'string' || value.length === 0) {
    value = fallback;
  }
  return {
    enabled: Boolean(flag.enabled),
    value,
    isDefault: Boolean(flag.isDefault),
    variant: typeof flag.variant === 'string' ? flag.variant : null,
    inExperiment: Boolean(flag.experiment?.inExperiment),
  };
}

/**
 * 创建一个已配置好的 Flagsmith 客户端。
 * @param {Record<string, string|undefined>} env
 */
export function createFlagsmithClient(env = process.env) {
  const environmentKey = env.FLAGSMITH_ENVIRONMENT_KEY;
  const apiUrl = env.FLAGSMITH_API_URL || undefined;
  const eventsUrl = env.FLAGSMITH_EVENTS_URL || undefined;

  const options = {
    environmentKey,
    enableEvents: Boolean(eventsUrl),
    // 断网/上游宕机时的降级：始终返回 control，保证页面可渲染
    defaultFlagHandler: () => ({
      enabled: true,
      value: DEFAULT_FLAG_VALUE,
      isDefault: true,
    }),
  };
  if (apiUrl) options.apiUrl = apiUrl;
  if (eventsUrl) {
    options.eventProcessorConfig = {
      eventsApiUrl: eventsUrl,
      // 本地模拟流量密集，缩短自动 flush 间隔；脚本收尾还会显式 flush
      flushInterval: 5000,
      maxBuffer: 5000,
    };
  }
  return new Flagsmith(options);
}

/**
 * 求值一个访客的实验变体。会触发 SDK 自动上报曝光事件。
 * @param {import('@flagsmith/nodejs').Flagsmith} client
 * @param {string} visitorId
 * @param {string} [flagName]
 */
export async function evaluateVariant(client, visitorId, flagName = EXPERIMENT_FLAG) {
  try {
    const flag = await client.getExperimentFlag(flagName, visitorId);
    return normaliseFlag(flag);
  } catch (error) {
    // 断网 / SDK 未启用事件 / 上游不可用 —— 一律降级到 control
    return {
      enabled: false,
      value: DEFAULT_FLAG_VALUE,
      isDefault: true,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * 记录一个转化事件。只有真实业务动作成功后才调用。
 * @param {import('@flagsmith/nodejs').Flagsmith} client
 * @param {string} eventName
 * @param {string} visitorId
 * @param {Record<string, unknown>} [metadata]
 */
export function trackConversion(client, eventName, visitorId, metadata) {
  try {
    const opts = { identifier: visitorId };
    if (metadata) opts.metadata = metadata;
    client.trackEvent(eventName, opts);
    return true;
  } catch (error) {
    // 降级：事件上报失败不影响用户体验
    return false;
  }
}

/**
 * 把内存缓冲的事件全部刷到 Flagsmith。必须在进程退出前调用。
 * @param {import('@flagsmith/nodejs').Flagsmith} client
 */
export async function flushEvents(client) {
  if (typeof client.flushEvents !== 'function') return false;
  try {
    await client.flushEvents();
    return true;
  } catch {
    return false;
  }
}
