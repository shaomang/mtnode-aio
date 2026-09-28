#!/usr/bin/env node
/**
 * bench/fake-gateway.mjs — MTNode 网关本地协议的**离线桩**，只用来自测 run-bench.mjs。
 *
 * 它不 import dsh、不打任何真实服务商 API：收到 {method:'run'} 后按同一套帧格式
 * 回 accepted，再补发 usage / text / question / done 事件，数字由 preset 决定
 * （lean 刻意比 standard 小），这样评测器侧的采集、续跑、超时、交互兜底都能在
 * 零 token 的条件下跑通。产品行为契约见 dsh/DESIGN.md 与 gateway.mjs。
 *
 * 用法（一般由 run-bench.mjs 拉起）：
 *   node scripts/bench/run-bench.mjs --gateway scripts/bench/fake-gateway.mjs --limit 3 --dry-run
 *
 * 可调环境变量：
 *   FAKE_HANG=1      每 5 题挂起一题（用来验证单题超时与 cancel 帧）
 *   FAKE_FAIL=1      每 4 题报一次 error（用来验证重试与续跑）
 *   FAKE_ASK=1       发一次 question 帧（用来验证宿主兜底回答不会死卡）
 *   FAKE_STEP_MS=N   每步之间的等待毫秒（默认 20）
 */

import { createInterface } from 'node:readline';

const out = (m) => process.stdout.write(JSON.stringify(m) + '\n');
const diag = (m) => process.stderr.write('[fake-gw] ' + m + '\n');

const HANG = process.env.FAKE_HANG === '1';
const FAIL = process.env.FAKE_FAIL === '1';
const ASK = process.env.FAKE_ASK === '1';
const STEP_MS = Number(process.env.FAKE_STEP_MS || 20);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let runCount = 0;

function fakeNumbers(preset, n) {
  /* lean 臂刻意更小，用来确认「两臂差异会被如实记进 jsonl」而不是被写死 */
  const k = preset === 'lean' ? 0.35 : 1;
  const base = (x) => Math.max(1, Math.round(x * k));
  return {
    inputTokens: base(1200 + n * 7),
    outputTokens: base(420 + n * 3),
    reasoningTokens: base(900 + n * 5),
    cacheReadTokens: base(preset === 'lean' ? 40 : 160),
    cacheWriteTokens: 0,
  };
}

async function simulateRun(p) {
  const n = ++runCount;
  const { reqId, preset } = p;
  const emit = (type, data) => out({ event: { reqId, type, data } });
  const u = fakeNumbers(preset, n);
  emit('status', { state: 'running' });
  await sleep(STEP_MS);
  emit('usage', Object.assign({}, u, { provider: 'fake', model: 'fake-model', at: Date.now() }));
  emit('tool', { callId: 'c1', turn: 1, step: 1, name: 'read', args: null });
  emit('tool-result', { callId: 'c1', content: [{ type: 'text', text: 'ok' }] });
  if (ASK && n % 3 === 0) {
    /* 模型中途提问：宿主（评测器）必须回话，否则这一轮就死等了 */
    emit('question', {
      id: 'q-' + reqId,
      sessionId: 'session-fake',
      questions: [{ id: 'q1', question: '要选哪个方案？', options: [{ label: 'A' }, { label: 'B' }] }],
    });
    await sleep(STEP_MS);
  }
  emit('reasoning', { text: 'GOAL=… APPROACH=… ', turn: 1, step: 2, index: 0 });
  emit('text', { text: '#### 42', turn: 1, step: 2, index: 1 });
  await sleep(STEP_MS);
  emit('usage', Object.assign({}, u, { provider: 'fake', model: 'fake-model', at: Date.now() }));
  if (FAIL && n % 4 === 0) {
    emit('error', { message: 'fake provider error: 配额耗尽' });
    emit('done', { finalResponse: '', metrics: null });
    return;
  }
  if (HANG && n % 5 === 0) {
    /* 永不收尾的一题：由评测器的单题超时 + cancel 帧兜住（见 run-bench.mjs 超时分支） */
    diag('故意挂起这一题 reqId=' + reqId);
    return;
  }
  emit('done', {
    finalResponse: 'Step by step …\n#### 42',
    metrics: {
      turns: 1,
      steps: 2,
      llmMs: STEP_MS * 2,
      toolMs: STEP_MS,
      firstTokenAvgMs: STEP_MS,
      tokPerSec: 120,
      cacheHitPct: 12.5,
      inputTokens: u.inputTokens * 2,
      outputTokens: u.outputTokens * 2,
      cacheReadTokens: u.cacheReadTokens * 2,
      cacheWriteTokens: 0,
      reasoningTokens: u.reasoningTokens * 2,
      subagents: 0,
      jobs: 0,
      tools: [{ name: 'read', at: Date.now() }],
      contextWindow: 1000000,
      wallMs: STEP_MS * 4,
      startedAt: Date.now() - STEP_MS * 4,
      endedAt: Date.now(),
      models: [{ provider: 'fake', model: 'fake-model', inputTokens: u.inputTokens * 2, outputTokens: u.outputTokens * 2, calls: 2 }],
    },
  });
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
  const t = line.trim();
  if (!t) return;
  let msg;
  try { msg = JSON.parse(t); } catch { return; }
  if (msg.id === undefined || typeof msg.method !== 'string') return;
  const reply = (result, error) => out({ id: msg.id, ok: !error, result, error });
  switch (msg.method) {
    case 'status':
      reply({ gateway: 'fake-0.1.0', node: process.version, runtimes: 0, runtimeBin: 'fake', configPath: 'fake' });
      break;
    case 'run':
      reply({ accepted: true });
      void simulateRun(msg.params || {}).catch((e) => diag('run 异常 ' + e.message));
      break;
    case 'cancel':
      diag('收到 cancel 帧 ' + JSON.stringify(msg.params || {}));
      reply({ ok: true, closed: true });
      break;
    case 'interact':
      diag('收到 interact 帧 kind=' + (msg.params || {}).kind + ' id=' + (msg.params || {}).id);
      reply({ ok: true });
      break;
    case 'shutdown':
      reply({ ok: true });
      setTimeout(() => process.exit(0), 50);
      break;
    default:
      reply(undefined, 'fake: unknown method ' + msg.method);
  }
});
process.stdin.on('end', () => process.exit(0));
diag('离线桩已就绪');
