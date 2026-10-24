/* ============================================================================
 * speech-ready.mjs — 「本地 SenseVoice 自动就绪」的唯一策略（单一真源）
 * ----------------------------------------------------------------------------
 * 需求（用户现场）：画布工具「音频转字幕（时间轴）」/ Agent 工具 audio_subtitle 一跑起来，
 * SenseVoice 就该**自己起来**（运行时按需拉起 → 自动 prepare 下载权重 → 等就绪），
 * 不该让用户先去手动「启用」什么，也不该在识别器还没注册好时抛一句「请先确认语音输入可用」。
 *
 * 三处事实（查证过，改之前先复核）：
 *   · 语音运行时由网关 `handleSpeech` 按需拉起（gateway.mjs：不在池里就 getRuntime，幂等）；
 *     `speech-to-text-sensevoice` 在运行时里注册识别器 —— 网桥 socket 先建连、提供者
 *     后注册，所以**头一两帧 state 可能 providers 为空**，这属于启动竞态，不是「用户没启用」。
 *   · 首次使用要下权重（int8 约 239MB）：phase 停在 unprepared / failed / cancelled 时
 *     调 prepare 即可，进度由官方 provider 自己推（UI 那一枚话筒订阅同一份状态）。
 *   · 纯净模式不禁用语音（cordis.yml 只按 MTNODE_CHAT_ISOLATE 门控），桌宠 / BongoChat
 *     隔离态才整档不加载 —— 那种情况下重试也没用，只能如实报错（但仍不该让用户去「启用」）。
 *
 * 调用方只给一个适配器，两处调用点（主进程 media-subtitle.js 经 RPC、网关 media-plugin.mjs
 * 直接持有 ctx.speechToText）行为完全一致：
 *   adapter = { snapshot(): 快照（{providers,selection}；允许同步 / 异步 / 抛错 / {ok:false}）,
 *               prepare(providerId): 触发准备（同步 / 异步） }
 *   ensureSpeechProvider(adapter, { waitProviderMs, deadlineMs, pollMs, sleep, now })
 *     → { providerId, snap }                     识别器就绪（ready / standby）
 *     → 抛错（消息即用户可见文案，不含「请手动启用」这类指路）
 *
 * 只做编排、不碰 IO：sleep / now 可注入，测试不会真等。
 * ==========================================================================*/

/** 就绪相位：这两种都算「可以转写」。 */
const READY_PHASES = new Set(['ready', 'standby']);
/** 这些相位值得发一次 prepare（其余相位 = 已经在准备，等就行）。 */
const PREPARABLE_PHASES = new Set(['unprepared', 'failed', 'cancelled']);

/** 默认时序（真实链路：识别器注册等 20s、权重下载最多等 10min、轮询 700ms）。 */
export const SPEECH_WAIT_PROVIDER_MS = 20000;
export const SPEECH_PREPARE_DEADLINE_MS = 10 * 60 * 1000;
export const SPEECH_POLL_MS = 700;

/** 相位归一（缺省 / 非法一律 unprepared）。 */
export function speechPhaseOf(provider) {
  const ph = String((provider && provider.preparation && provider.preparation.phase) || 'unprepared');
  return ph || 'unprepared';
}

/**
 * 从快照里挑识别器：先按选中项，再按名字认 sensevoice，最后退回第一个。
 * @param {object} snap { providers, selection }
 * @returns {object|null}
 */
export function pickSpeechProvider(snap) {
  const providers = Array.isArray(snap && snap.providers) ? snap.providers : [];
  const selection = (snap && snap.selection) || {};
  return (
    providers.find((p) => p && p.id === selection.providerId) ||
    providers.find((p) => p && /sensevoice/i.test(String(p.id))) ||
    providers[0] ||
    null
  );
}

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 等到识别器就绪；需要时**自动**触发权重准备（下载）再等。
 *
 * @param {{snapshot:Function, prepare:Function}} adapter 见文件头
 * @param {object} [opts]
 *   waitProviderMs 等识别器注册出现的最长时间（启动竞态，默认 20s）
 *   deadlineMs     触发 prepare 后等权重就绪的最长时间（默认 10min）
 *   pollMs         轮询间隔（默认 700ms）
 *   sleep / now    时序注入（测试用）
 * @returns {Promise<{providerId:string, snap:object}>}
 */
export async function ensureSpeechProvider(adapter, opts = {}) {
  const a = adapter && typeof adapter === "object" ? adapter : {};
  const waitProviderMs = Math.max(0, Number(opts.waitProviderMs ?? SPEECH_WAIT_PROVIDER_MS) || 0);
  const deadlineMs = Math.max(0, Number(opts.deadlineMs ?? SPEECH_PREPARE_DEADLINE_MS) || 0);
  const pollMs = Math.max(1, Number(opts.pollMs ?? SPEECH_POLL_MS) || SPEECH_POLL_MS);
  const sleep = typeof opts.sleep === "function" ? opts.sleep : defaultSleep;
  const now = typeof opts.now === "function" ? opts.now : () => Date.now();

  /** 最近一次快照读失败的原因（readSnap 自己吞掉的）：没识别器时报错要能带上它。 */
  let lastError = "";

  async function readSnap() {
    if (typeof a.snapshot !== "function") return { providers: [], selection: {} };
    try {
      const snap = await a.snapshot();
      if (snap && snap.ok === false) {
        lastError = String(snap.error || "");
        return { providers: [], selection: {} };
      }
      return snap && typeof snap === "object" ? snap : {};
    } catch (err) {
      lastError = String((err && err.message) || err);
      return { providers: [], selection: {} };
    }
  }

  async function firePrepare(providerId) {
    if (typeof a.prepare !== "function") return;
    try {
      await a.prepare(providerId);
    } catch (err) {
      /* 「已有准备任务」这类拒绝不算失败：下面照旧轮询状态。
         其它错误也先咽下 —— 真失败会在 phase=failed 上体现，报错口径统一走那里。 */
      lastError = String((err && err.message) || err);
    }
  }

  /* ① 等识别器出现（语音运行时可能刚被拉起，插件的提供者注册晚于 socket 建连）。
        这一步是「自动启用」的关键：竞态期不抛错、不要求用户做任何动作。 */
  const providerDeadline = now() + waitProviderMs;
  let snap = await readSnap();
  let view = pickSpeechProvider(snap);
  while (!view && now() < providerDeadline) {
    await sleep(pollMs);
    snap = await readSnap();
    view = pickSpeechProvider(snap);
  }
  if (!view) {
    const waitSec =
      waitProviderMs >= 1000 ? Math.round(waitProviderMs / 1000) + " 秒" : Math.round(waitProviderMs) + " 毫秒";
    throw new Error(
      "本地语音识别（SenseVoice）没有可用的识别器：语音服务还没就绪（运行时刚起来时要等几秒装载语音插件）。" +
        "已自动等待 " + waitSec + "并会随下一次运行自动重试；" +
        "只有纯净模式 / 桌宠隔离态这种整档不加载语音服务的会话才起不来。" +
        (lastError ? "（最近一次状态读取：" + lastError + "）" : "") +
        "不要另装 whisper / 在线 ASR。",
    );
  }

  /* ② 已就绪就直接用；unprepared / failed / cancelled 则**自动**触发 download。 */
  let providerId = String(view.id || "");
  let phase = speechPhaseOf(view);
  let prepared = 0;
  if (READY_PHASES.has(phase)) return { providerId, snap };
  if (PREPARABLE_PHASES.has(phase)) {
    await firePrepare(providerId);
    prepared++;
  }

  /* ③ 等权重就绪：failed 会自动再 prepare 一次（下载中断 / 上一次失败留下的相位）。 */
  const started = now();
  const deadline = started + deadlineMs;
  let lastPhase = phase;
  while (now() < deadline) {
    await sleep(pollMs);
    snap = await readSnap();
    view = pickSpeechProvider(snap);
    if (!view) continue;
    providerId = String(view.id || "") || providerId;
    phase = speechPhaseOf(view);
    lastPhase = phase;
    if (READY_PHASES.has(phase)) return { providerId, snap };
    if (phase === "failed") {
      /* 自动续一次：下载失败 / 被取消后 prepare 可以重来，用户不用去点任何按钮。 */
      if (prepared < 2) {
        await firePrepare(providerId);
        prepared++;
        continue;
      }
      const msg = (view.preparation && view.preparation.message) || lastError || "";
      throw new Error(
        "SenseVoice 模型准备失败" + (msg ? "：" + msg : "") +
          "（已自动重试，仍未就绪；稍后重试会自动续传，不要另装其它 ASR）",
      );
    }
  }
  throw new Error(
    "SenseVoice 模型准备超时（首次使用要下载约 239MB 权重，慢网会久一点；当前相位 " + lastPhase + "）。" +
      "下载已自动触发、支持断点续传：稍后重试会自动接着下，不要另装其它 ASR。",
  );
}

/**
 * 这句失败是不是「语音服务 / 权重还没就绪」（值得自动重新就绪 + 重试，而不是直接报给用户）。
 * 官方 provider 的文案不统一（Prepare the local speech provider before recording /
 * Speech provider is unavailable / 下载中断 …），所以按关键词认，宁可多重试一次。
 */
export function isSpeechNotReadyError(message) {
  return /prepare|not\s*ready|unavailable|unprepared|not\s*prepared|loading|download|就绪|准备|下载/i.test(
    String(message || ""),
  );
}

export default { ensureSpeechProvider, pickSpeechProvider, speechPhaseOf, isSpeechNotReadyError };
