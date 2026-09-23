import { app } from "../../../scripts/app.js";
import { splitPromptListPayload, queueSubmissionPlan } from "./prompt_list_queue.mjs";

const TARGET = "NanFengPromptList";
const MAX_PROMPTS = 20;
const FIXED_WIDTH = 620;
const FIXED_HEIGHT = 1050;
const WIDGET_WIDTH = 600;
const WIDGET_HEIGHT = 950;

function nativeWidget(node, name) {
  return node.widgets?.find((item) => item.name === name);
}

function writeWidget(node, name, value) {
  const item = nativeWidget(node, name);
  if (!item) return;
  item.value = value;
  item.callback?.(value);
  node.setDirtyCanvas?.(true, true);
}

function hideNativeWidget(item) {
  if (!item) return;
  item.hidden = true;
  item.computeSize = () => [0, -4];
  if (item.element) item.element.style.display = "none";
}

function installStyle() {
  if (document.getElementById("nanfeng-prompt-list-v1-style")) return;
  const style = document.createElement("style");
  style.id = "nanfeng-prompt-list-v1-style";
  style.textContent = `
.nfpl-shell{width:100%;height:100%;min-width:0;overflow:hidden}
.nfpl{container-type:inline-size;width:100%;height:100%;padding:11px;overflow-y:auto;overflow-x:hidden;scrollbar-width:thin;scrollbar-color:#9b6fca #120d1c;box-sizing:border-box;display:flex;flex-direction:column;gap:10px;color:#f6f1ff;font:12px 'Microsoft YaHei UI',sans-serif;background:radial-gradient(circle at 10% 0%,#51317166 0,transparent 34%),radial-gradient(circle at 96% 18%,#203f5f55 0,transparent 30%),linear-gradient(155deg,#24152f 0%,#120d1c 38%,#090811 72%,#191025 100%);border:1px solid #a77adc;border-radius:12px;box-shadow:inset 0 1px 0 #d5b6ff2e,inset 0 0 32px #59317a44,0 0 22px #5d358455}
.nfpl *{box-sizing:border-box;min-width:0}.nfpl-head{display:flex;align-items:center;justify-content:space-between;gap:8px;overflow:hidden;padding:11px 13px;border:1px solid #825ca0;border-radius:10px;background:linear-gradient(100deg,#704394 0%,#3d2853 48%,#193044 100%);box-shadow:inset 0 1px 0 #e5d1ff38,0 6px 18px #07040c99}.nfpl-title{min-width:0;font-size:15px;font-weight:800;color:#fff;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;text-shadow:0 2px 7px #160821}.nfpl-badge{flex:none;max-width:52%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px;color:#baffea;background:linear-gradient(135deg,#143b32,#10231f);border:1px solid #48a887;border-radius:12px;padding:4px 8px}
.nfpl-count-card,.nfpl-fold,.nfpl-prompt-card{border:1px solid #684b80;border-radius:10px;background:linear-gradient(145deg,#1b1225e8,#0d0a14e8);box-shadow:inset 0 1px 0 #d8bcff12,0 5px 14px #05030877}.nfpl-count-card{padding:10px}.nfpl-label{display:block;margin:0 0 5px 3px;color:#cfbdec;font-weight:700}.nfpl-count-row{display:grid;grid-template-columns:42px 1fr 42px;gap:8px;align-items:center}.nfpl-count-row button,.nfpl-count-value{height:34px;border:1px solid #765493;border-radius:8px;background:linear-gradient(145deg,#2b1b39,#130e1b);color:#fff;text-align:center;font-weight:800}.nfpl-count-row button{cursor:pointer;font-size:18px}.nfpl-count-row button:hover{border-color:#c28cf1;background:#56336f}.nfpl-count-note{margin-top:6px;color:#8fdcbf;font-size:10px}
.nfpl-fold>summary{list-style:none;display:flex;align-items:center;justify-content:space-between;padding:10px 12px;color:#f2e5ff;background:linear-gradient(90deg,#503267 0%,#30203e 45%,#1c1729 100%);cursor:pointer;font-weight:700}.nfpl-fold>summary::-webkit-details-marker{display:none}.nfpl-fold>summary::after{content:'▸';color:#d2adfa;transition:transform .15s}.nfpl-fold[open]>summary::after{transform:rotate(90deg)}.nfpl-shared{display:grid;grid-template-columns:1fr 1fr;gap:9px;padding:10px}.nfpl-field label{display:block;margin:0 0 4px 3px;color:#b9abc8}.nfpl textarea{display:block;width:100%;min-height:76px;padding:9px;resize:none;border:1px solid #604675;border-radius:8px;background:linear-gradient(145deg,#23172e,#110d18);color:#f8f2ff;outline:none;line-height:1.45;font:12px 'Microsoft YaHei UI',sans-serif;box-shadow:inset 0 1px 5px #05030899}.nfpl textarea:focus{border-color:#c28cf1;box-shadow:0 0 0 1px #a36ed2,0 0 11px #8e55bd66}
.nfpl-prompts{display:flex;flex-direction:column;gap:9px}.nfpl-prompt-card{padding:9px}.nfpl-prompt-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:5px}.nfpl-prompt-number{font-weight:800;color:#f2e5ff}.nfpl-prompt-state{font-size:10px;color:#75dbb8}.nfpl-prompt-card textarea{min-height:112px}.nfpl-footer{padding:8px 10px;border:1px solid #356e5d;border-radius:8px;background:#0d241d;color:#a8f2d8;line-height:1.5}
@container (max-width:420px){.nfpl-shared{grid-template-columns:1fr}}
`;
  document.head.appendChild(style);
}

function makeTextarea(node, widgetName, placeholder, promptIndex = null) {
  const area = document.createElement("textarea");
  area.value = nativeWidget(node, widgetName)?.value || "";
  area.placeholder = placeholder;
  area.dataset.widgetName = widgetName;
  if (promptIndex !== null) area.dataset.promptIndex = String(promptIndex);
  area.addEventListener("input", () => writeWidget(node, widgetName, area.value));
  return area;
}

function buildPanel(node) {
  installStyle();
  const root = document.createElement("div");
  root.className = "nfpl";

  const head = document.createElement("div");
  head.className = "nfpl-head";
  head.innerHTML = '<span class="nfpl-title">南风提示词列表</span><span class="nfpl-badge">每框独立排队 · 完整保存</span>';

  const countCard = document.createElement("div");
  countCard.className = "nfpl-count-card";
  countCard.innerHTML = '<span class="nfpl-label">提示词框数量</span>';
  const countRow = document.createElement("div");
  countRow.className = "nfpl-count-row";
  const minus = document.createElement("button");
  minus.type = "button";
  minus.textContent = "−";
  const countValue = document.createElement("div");
  countValue.className = "nfpl-count-value";
  const plus = document.createElement("button");
  plus.type = "button";
  plus.textContent = "+";
  const countNote = document.createElement("div");
  countNote.className = "nfpl-count-note";
  countNote.textContent = `可选择 1–${MAX_PROMPTS} 个独立输入框；每个非空框作为一次提示词注入。`;
  countRow.append(minus, countValue, plus);
  countCard.append(countRow, countNote);

  const shared = document.createElement("details");
  shared.className = "nfpl-fold";
  shared.innerHTML = "<summary>统一前缀与后缀（可选）</summary>";
  const sharedBody = document.createElement("div");
  sharedBody.className = "nfpl-shared";
  for (const [name, label, placeholder] of [
    ["统一前缀", "统一前缀", "自动添加在每个提示词前面"],
    ["统一后缀", "统一后缀", "自动添加在每个提示词后面"],
  ]) {
    const field = document.createElement("div");
    field.className = "nfpl-field";
    const text = document.createElement("label");
    text.textContent = label;
    field.append(text, makeTextarea(node, name, placeholder));
    sharedBody.append(field);
  }
  shared.append(sharedBody);

  const prompts = document.createElement("div");
  prompts.className = "nfpl-prompts";
  const footer = document.createElement("div");
  footer.className = "nfpl-footer";
  footer.textContent = "点击运行后，每个非空框会拆成一个独立队列任务：采样 → VAE解码 → 保存视频全部完成，再运行下一框；所有框保持工作流中的同一个种子。";

  function count() {
    return Math.max(1, Math.min(MAX_PROMPTS, Number(nativeWidget(node, "提示词框数量")?.value || 3)));
  }

  function render() {
    const current = count();
    countValue.textContent = String(current);
    prompts.replaceChildren();
    for (let index = 1; index <= current; index++) {
      const card = document.createElement("div");
      card.className = "nfpl-prompt-card";
      const title = document.createElement("div");
      title.className = "nfpl-prompt-head";
      title.innerHTML = `<span class="nfpl-prompt-number">提示词 ${index}</span><span class="nfpl-prompt-state">第 ${index} 次注入</span>`;
      card.append(title, makeTextarea(node, `提示词${index}`, `填写第 ${index} 条完整提示词`, index));
      prompts.append(card);
    }
    node.setDirtyCanvas?.(true, true);
  }

  function setCount(value) {
    writeWidget(node, "提示词框数量", Math.max(1, Math.min(MAX_PROMPTS, value)));
    render();
  }
  minus.onclick = () => setCount(count() - 1);
  plus.onclick = () => setCount(count() + 1);

  node.__nfplRender = render;
  root.append(head, countCard, shared, prompts, footer);
  render();
  return root;
}

app.registerExtension({
  name: "nanfeng.prompt.list.v3",
  async setup() {
    const previousQueuePrompt = app.queuePrompt?.bind(app);
    if (!previousQueuePrompt || app.__nfplSplitQueueInstalled) return;
    app.__nfplSplitQueueInstalled = true;

    app.queuePrompt = async function (number, batchCount) {
      if (app.__nfplSubmittingSplit) return previousQueuePrompt(number, batchCount);
      const activeLists = (app.graph?.nodes || []).filter(node =>
        node.type === TARGET && !node.muted && node.mode !== 4
      );
      if (activeLists.length !== 1) return previousQueuePrompt(number, batchCount);

      const batch = Number(batchCount ?? 1);
      if (batch > 1) {
        alert("南风提示词列表已按框独立排队，请将批次数量设为1，避免重复提交整组分镜。");
        return;
      }

      const { output, workflow } = await app.graphToPrompt();
      const payloads = splitPromptListPayload(output, workflow, MAX_PROMPTS);
      if (!payloads) return previousQueuePrompt(number, batchCount);

      app.__nfplSubmittingSplit = true;
      try {
        const responses = [];
        const queuePlan = queueSubmissionPlan(number, payloads.length);
        for (let index = 0; index < payloads.length; index++) {
          const payload = payloads[index];
          responses.push(await app.api.queuePrompt(queuePlan[index], {
            output: payload.output,
            workflow: payload.workflow,
          }));
        }
        console.info(`[南风提示词列表] 已提交 ${payloads.length} 个独立队列任务；种子保持不变。`);
        return responses;
      } finally {
        app.__nfplSubmittingSplit = false;
      }
    };
  },
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== TARGET) return;
    const originalCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      const result = originalCreated?.apply(this, arguments);
      for (const item of this.widgets || []) hideNativeWidget(item);
      this.color = "#211329";
      this.bgcolor = "#130c1b";
      this.boxcolor = "#b07add";
      this.properties ||= {};
      this.properties.nanfeng_prompt_list_layout = 1;

      const shell = document.createElement("div");
      shell.className = "nfpl-shell";
      shell.append(buildPanel(this));
      const enforceHostSize = () => {
        const host = shell.parentElement;
        if (!host) return;
        host.style.width = `${WIDGET_WIDTH}px`;
        host.style.minWidth = `${WIDGET_WIDTH}px`;
        host.style.maxWidth = `${WIDGET_WIDTH}px`;
        host.style.height = `${WIDGET_HEIGHT}px`;
        host.style.minHeight = `${WIDGET_HEIGHT}px`;
        host.style.maxHeight = `${WIDGET_HEIGHT}px`;
        shell.style.width = "100%";
        shell.style.minWidth = "100%";
        shell.style.maxWidth = "100%";
        shell.style.height = "100%";
        shell.style.minHeight = "100%";
        shell.style.maxHeight = "100%";
      };
      const panel = this.addDOMWidget("南风提示词列表面板", "nanfeng_prompt_list", shell, {
        serialize: false,
        hideOnZoom: false,
        getMinHeight: () => WIDGET_HEIGHT,
        getMaxHeight: () => WIDGET_HEIGHT,
        getHeight: () => WIDGET_HEIGHT,
        onDraw: enforceHostSize,
        beforeResize: enforceHostSize,
        afterResize: enforceHostSize,
      });
      panel.computeSize = () => [WIDGET_WIDTH, WIDGET_HEIGHT];
      panel.computedHeight = WIDGET_HEIGHT;

      let lockingSize = false;
      const lockSize = () => {
        if (lockingSize) return;
        lockingSize = true;
        try {
          panel.computedHeight = WIDGET_HEIGHT;
          if (this.size[0] !== FIXED_WIDTH) this.size[0] = FIXED_WIDTH;
          if (this.size[1] !== FIXED_HEIGHT) this.size[1] = FIXED_HEIGHT;
          enforceHostSize();
          this.setDirtyCanvas?.(true, true);
        } finally {
          lockingSize = false;
        }
      };
      this.computeSize = () => [FIXED_WIDTH, FIXED_HEIGHT];
      this.onResize = function () { lockSize(); };
      this.size = [FIXED_WIDTH, FIXED_HEIGHT];

      const oldConfigure = this.onConfigure;
      this.onConfigure = function (info) {
        oldConfigure?.call(this, info);
        lockSize();
        setTimeout(() => this.__nfplRender?.(), 0);
      };
      lockSize();
      this.setDirtyCanvas?.(true, true);
      return result;
    };
  },
});
