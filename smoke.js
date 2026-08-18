'use strict';
const path = require('path');
const fs = require('fs');
const http = require('http');
process.env.MTNODE_DATA_DIR = path.join(process.env.TEMP || '.', 'mtnode_smoke_data');
require('./main.js');

/* 本地假 API：响应延迟 500ms，请求计数写入临时文件（供渲染层读取）。
   请求体带 stream:true → SSE 流式（含 reasoning_content 思考内容）；否则普通 JSON */
const mockCountFile = path.join(process.env.TEMP || '.', 'mtnode_mock_count.txt');
try { fs.unlinkSync(mockCountFile); } catch {}
const mockServer = http.createServer((req, res) => {
  fs.appendFileSync(mockCountFile, 'x');
  const n = fs.readFileSync(mockCountFile, 'utf8').length; // 请求到达时即计数（并行请求各自独立）
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    setTimeout(() => {
      if (body.includes('"stream":true')) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write('data: {"choices":[{"delta":{"role":"assistant","reasoning_content":"推理A"}}]}\n\n');
        res.write('data: {"choices":[{"delta":{"reasoning_content":"-推理B"}}]}\n\n');
        res.write('data: {"choices":[{"delta":{"content":"答案-' + n + '"}}]}\n\n');
        res.write('data: [DONE]\n\n');
        res.end();
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { content: '答案-' + n } }] }));
      }
    }, 500);
  });
});
mockServer.listen(0, '127.0.0.1', () => {
  const MOCK_PORT = mockServer.address().port;
  const { app, BrowserWindow, clipboard } = require('electron');
  clipboard.writeText('粘贴标题A: 粘贴内容A\n粘贴标题B: |\n  第一行\n  第二行');

  /* 简易 GIF89a 解码器：返回 { width, height, transparentIndex, frames:[{index:[]}] } */
  function decodeGif(buf) {
    const width = buf.readUInt16LE(6), height = buf.readUInt16LE(8);
    const packed = buf[10];
    let p = 13;
    if (packed & 0x80) p += 3 * (2 << (packed & 7));
    let transparentIndex = -1;
    const frames = [];
    while (p < buf.length) {
      const block = buf[p];
      if (block === 0x3b) break;
      if (block === 0x21) {
        p += 2;
        if (buf[p - 1] === 0xf9) {
          const packed2 = buf[p + 1];
          transparentIndex = packed2 & 1 ? buf[p + 3] : -1;
        }
        while (buf[p] !== 0) p += buf[p] + 1;
        p++;
        continue;
      }
      if (block === 0x2c) {
        p += 10;
        if (buf[p - 1] & 0x80) p += 3 * (2 << (buf[p - 1] & 7));
        const minCode = buf[p]; p++;
        const data = [];
        while (true) {
          const sz = buf[p];
          if (sz === 0) { p++; break; }
          for (let i = 0; i < sz; i++) data.push(buf[p + 1 + i]);
          p += sz + 1;
        }
        const clearCode = 1 << minCode, eoiCode = clearCode + 1;
        let codeSize = minCode + 1, next = eoiCode + 1;
        let dict = [], prev = null, out = [], bitPos = 0;
        const readCode = () => {
          let v = 0;
          for (let i = 0; i < codeSize; i++) {
            const byte = data[bitPos >> 3] || 0;
            v |= ((byte >> (bitPos & 7)) & 1) << i;
            bitPos++;
          }
          return v;
        };
        while (out.length < width * height) {
          const code = readCode();
          if (code === clearCode) { codeSize = minCode + 1; next = eoiCode + 1; dict = []; prev = null; continue; }
          if (code === eoiCode) break;
          let entry;
          if (code < clearCode) entry = [code];
          else if (code - (eoiCode + 1) < dict.length) entry = dict[code - (eoiCode + 1)];
          else if (code === next && prev) entry = prev.concat(prev[0]);
          else break;
          for (const c of entry) out.push(c);
          if (prev) {
            dict.push(prev.concat(entry[0]));
            next++;
            if (next > (1 << codeSize) && codeSize < 12) codeSize++;
          }
          prev = entry;
        }
        frames.push({ index: out });
        continue;
      }
      p++;
    }
    return { width, height, transparentIndex, frames };
  }

  app.whenReady().then(() => {
  setTimeout(() => {
    const win = BrowserWindow.getAllWindows()[0];
    if (!win) { console.log('[fail] no window'); app.exit(1); return; }
    win.webContents.on('console-message', (e, level, message) => {
      console.log(`[console:${level}] ${message}`);
    });
    const script = `
    (async () => {
      const log = (x) => console.log('[wf:' + x + ']');
      // —— 端口居中：单输入应在节点垂直中间；多输入间隔居中 ——
      addNode('proc_text', 400, 100);
      const p1 = S.wf.nodes[S.wf.nodes.length - 1];
      p1.h = 200;
      log('in1 centerY(200h)=' + inPortY(p1, 0, 1) + ' expect 100');
      log('in3 centered=' + inPortY(p1, 0, 3) + ',' + inPortY(p1, 1, 3) + ',' + inPortY(p1, 2, 3) + ' expect 74,100,126');

      // —— 所有节点应有标题 + 自动编号 ——
      addNode('input_text', 100, 100);
      const n1 = S.wf.nodes[S.wf.nodes.length - 1];
      addNode('input_text', 100, 260);
      const n1b = S.wf.nodes[S.wf.nodes.length - 1];
      log('titles=' + n1.title + ' / ' + n1b.title + ' expect 文本节点 / 文本节点 2');

      // —— @ 引用（仅已连接节点 + 结构化消息 + @ 去除） ——
      n1.title = '设计需求'; n1.text = '赛博朋克基地';
      addNode('proc_text', 420, 220);
      const n2 = S.wf.nodes[S.wf.nodes.length - 1];
      n2.prompt = '根据 @设计需求 写一句宣传语';
      const rr0 = resolveRefs(n2.prompt, n2, 0);
      log('unconnected ref blocked=' + (rr0.unresolved.length === 1) + ' sources=' + rr0.textSources.length);
      const rr2 = resolveRefs('引用 @不存在节点', n2, 0);
      log('unresolved keeps token=' + (rr2.prompt.includes('@不存在节点')) + ' count=' + rr2.unresolved.length);
      const prov0 = S.config.providers.find((p) => p.type === 'text_openai');

      // —— 批量文本节点：条目 + YAML 导入 + 下游传播 ——
      n1.batch = true;
      n1.entries = [{ id: 'e1', title: '产品A', content: '内容A' }, { id: 'e2', title: '产品B', content: '内容B' }];
      connect(n1.id, n2.id, 0);
      const rr = resolveRefs(n2.prompt, n2, 0);
      log('connected ref stripped=' + (!rr.prompt.includes('@设计需求') && rr.prompt.includes('设计需求')) + ' sources=' + rr.textSources.length + ' src0=' + rr.textSources[0].title + ':' + rr.textSources[0].text);
      const specA = buildSpec(n2, prov0, 0);
      log('assemble bg=' + specA.prompt.startsWith('【背景信息】') + ' content=' + specA.prompt.includes('【内容】') + ' hasItemField=' + specA.prompt.includes('### 产品A'));
      log('assemble full=' + specA.prompt.replace(/\\n/g, '|'));
      log('isBatch(n2)=' + isBatch(n2) + ' expect true');
      log('batchTitles(n2)=' + batchTitles(n2).join(',') + ' expect 产品A,产品B');
      log('valueForInput(n1,0)=' + valueForInput(n1, 0).text + ' / idx1=' + valueForInput(n1, 1).text);

      // 链式传播：n2 -> 保存节点
      addNode('save_text', 700, 300);
      const n3 = S.wf.nodes[S.wf.nodes.length - 1];
      n3.savePath = 'C:/Users/shaom/AppData/Local/Temp/opencode/pcl_batch.yaml';
      connect(n2.id, n3.id, 0);
      log('isBatch(n3)=' + isBatch(n3) + ' expect true');
      log('batchOutPath=' + batchOutPath('C:/out/result.yaml', '产品A') + ' expect C:/out/result_产品A.yaml');
      log('safeFile=' + safeFile('a/b:c*?') + ' expect a_b_c_');

      // 手动设置 n2 的批量输出，然后测试保存节点批量写盘
      n2.batchOutputs = [
        { title: '产品A', ok: true, output: { kind: 'text', text: '宣传语A' } },
        { title: '产品B', ok: true, output: { kind: 'text', text: '宣传语B' } },
      ];
      const ok1 = await saveTextOnce(n3, true);
      const fA = 'C:/Users/shaom/AppData/Local/Temp/opencode/pcl_batch_产品A.yaml';
      const fB = 'C:/Users/shaom/AppData/Local/Temp/opencode/pcl_batch_产品B.yaml';
      const rdA = await window.api.fileReadText(fA);
      const rdB = await window.api.fileReadText(fB);
      log('batch save ok=' + ok1 + ' A exists=' + rdA.exists + ' B exists=' + rdB.exists);
      log('A content key=item field=' + (rdA.content.indexOf('产品A: 宣传语A') >= 0) + ' notNodeTitle=' + (rdA.content.indexOf('文本处理节点') < 0));

      // —— 保存节点 聚合/批量 切换：聚合=合并一个 YAML ——
      n3.batchMode = 'agg';
      const aggPath = 'C:/Users/shaom/AppData/Local/Temp/opencode/pcl_agg.yaml';
      n3.savePath = aggPath;
      const okAgg = await saveTextOnce(n3, true);
      const rdAgg = await window.api.fileReadText(aggPath);
      log('save agg ok=' + okAgg + ' hasA=' + (rdAgg.content.indexOf('产品A: 宣传语A') >= 0) + ' hasB=' + (rdAgg.content.indexOf('产品B: 宣传语B') >= 0) + ' singleFile=' + (n3.savedPaths.length === 1));
      n3.batchMode = 'batch';

      // —— 保存路径：相对工作目录（改目录统一切换） ——
      const ws1 = ${JSON.stringify(path.join(process.env.TEMP || '.', 'mtnode_save_ws1').replace(/\\/g, '/'))};
      const ws2 = ${JSON.stringify(path.join(process.env.TEMP || '.', 'mtnode_save_ws2').replace(/\\/g, '/'))};
      S.wf.workspace = ws1;
      addNode('save_text', 700, 520);
      const nRel = S.wf.nodes[S.wf.nodes.length - 1];
      log('save defaultRel=' + (!isAbsPath(nRel.savePath) && !!nRel.savePath) + ' path=' + nRel.savePath);
      nRel.savePath = 'rel_out.yaml';
      connect(n2.id, nRel.id, 0);
      nRel.batchMode = 'agg';
      const okRel1 = await saveTextOnce(nRel, true);
      const abs1 = resolveSavePath(nRel.savePath).path;
      const rdRel1 = await window.api.fileReadText(abs1);
      const abs1n = String(abs1).replace(/\\\\/g, '/');
      log('save rel ws1 ok=' + okRel1 + ' absEnds=' + abs1n.endsWith('/rel_out.yaml') + ' exists=' + rdRel1.exists);
      log('preferRel=' + (preferRelativeSavePath(window.api.pathJoin(ws1, 'sub', 'a.yaml')) === 'sub/a.yaml'));
      S.wf.workspace = ws2;
      const okRel2 = await saveTextOnce(nRel, true);
      const abs2 = resolveSavePath(nRel.savePath).path;
      const rdRel2 = await window.api.fileReadText(abs2);
      const abs2n = String(abs2).replace(/\\\\/g, '/');
      log('save rel ws2 ok=' + okRel2 + ' switched=' + (abs2n.endsWith('/rel_out.yaml') && abs2 !== abs1) + ' exists=' + rdRel2.exists);
      S.wf.workspace = '';

      // —— YAML 导入解析 ——
      const parsed = parseSimpleYaml('设计需求: 赛博朋克\\n产品A: |\\n  第一行\\n  第二行\\n产品B: 普通值');
      log('yaml parse n=' + parsed.length + ' k0=' + parsed[0].title + ':' + parsed[0].content);
      log('yaml parse k1=' + parsed[1].title + ' content=' + parsed[1].content.replace(/\\n/g, '|'));

      // —— 图像批量 ——
      addNode('input_image', 100, 440);
      const n5 = S.wf.nodes[S.wf.nodes.length - 1];
      n5.batch = true;
      n5.entries = [{ id: 'ie1', title: '图1', path: '' }];
      log('isBatch(n5)=' + isBatch(n5));
      const b = bentryImageRow(n5, n5.entries[0]);
      log('image entry row ok=' + (b.className.indexOf('n-bentry') >= 0));

      // —— 迁移：旧数据补齐字段 ——
      const old = { nodes: [{ id: 'x', kind: 'input_text', title: '', text: 'hi' }, { id: 'y', kind: 'save_text', title: 's', savedPath: 'a.yaml' }], wires: [] };
      migrateWf(old);
      log('migrate title=' + old.nodes[0].title + ' batch=' + old.nodes[0].batch + ' entries=' + Array.isArray(old.nodes[0].entries) + ' savedPaths=' + old.nodes[1].savedPaths.length);

      // —— 端子在 DOM 上必须有 top 样式（修复连线错位） ——
      renderCanvas();
      const els = document.querySelectorAll('.wf-node');
      const anyPort = document.querySelector('.port.in');
      log('port inline top set=' + (!!anyPort && anyPort.style.top.indexOf('px') > 0));

      // —— 默认服务商：DeepSeek v4 / GPT Image 2（无默认地址，仅 gpt-image-2） ——
      ensureDefaultProviders();
      const t1 = S.config.providers.find((p) => p.type === 'text_openai');
      const i1 = S.config.providers.find((p) => p.type.startsWith('image_'));
      log('first text provider=' + t1.id + ':' + t1.name + ' models=' + t1.models.join(','));
      log('first image provider=' + i1.id + ':' + i1.name + ' models=' + i1.models.join(',') + ' baseUrlEmpty=' + (i1.baseUrl === ''));
      log('stability/mj removed=' + !S.config.providers.some((p) => p.id === 'stability' || p.id === 'mj'));

      // —— 请求预览 ——
      const n2b = S.wf.nodes.find((x) => x.kind === 'proc_text');
      const prov = S.config.providers.find((p) => p.id === n2b.providerId);
      n2b.providerId = prov.id; n2b.model = 'deepseek-v4-flash';
      prov.apiKey = 'sk-test-123';
      const spec0 = buildSpec(n2b, prov, 0);
      log('spec temperature=' + spec0.temperature);
      const pv = await window.api.apiPreview(spec0);
      log('preview ok=' + pv.ok + ' url=' + (pv.request && pv.request.url) + ' method=' + (pv.request && pv.request.method));
      log('preview body model=' + (pv.request && pv.request.body.model) + ' temp=' + (pv.request && pv.request.body.temperature) + ' hasAuth=' + ((pv.request.headers.Authorization || '').indexOf('Bearer sk-test') === 0));

      // —— 批量按钮在头部 + API toggle 面板 ——
      renderCanvas();
      log('batch toggle btn=' + (document.querySelectorAll('.n-batch-toggle').length > 0));
      S.uiOpenNode = n2b.id;
      renderCanvas();
      const panel = document.querySelector('.n-api-panel');
      log('api panel open=' + (panel && panel.style.display !== 'none') + ' hasSelect=' + (panel && !!panel.querySelector('select')) + ' hasModel=' + (panel && !!panel.querySelector('input[type=text]')));

      // —— 设置栏 persistent（点击外部不关闭） ——
      openSettings();
      log('settings persistent flag=' + overlayPersistent + ' overlayVisible=' + ($('#overlay').style.display === 'flex'));
      closeOverlay();

      // —— 输出面板宽度（不再 560，默认 210 可调） + 删除按钮 + 工具栏 ——
      renderCanvas();
      const w = S.wf.nodes.find((x) => x.id === n2.id);
      const hadOut = w.batchOutputs && w.batchOutputs.length;
      log('n2 width compact=' + w.w + ' (hadOut=' + hadOut + ') expect <560');
      log('del btn=' + (document.querySelectorAll('.n-del').length > 0));
      log('toolbar btns=' + ['btnUndo', 'btnRedo', 'btnDup'].every((id) => !!document.getElementById(id)));
      log('title inline edit fn=' + (typeof startTitleEdit === 'function'));

      // —— 递归自动执行上游（未处理过的处理节点） ——
      S.config.providers.push({ id: 'nokey_prov', name: 'NoKey', type: 'text_openai', baseUrl: 'https://x.example', apiKey: '', models: ['m'], vision: false });
      addNode('input_text', 100, 700);
      const ta = S.wf.nodes[S.wf.nodes.length - 1];
      ta.text = '素材';
      addNode('proc_text', 360, 700);
      const pa = S.wf.nodes[S.wf.nodes.length - 1];
      pa.title = '上游A'; pa.providerId = 'nokey_prov';
      addNode('proc_text', 620, 700);
      const pb = S.wf.nodes[S.wf.nodes.length - 1];
      pb.title = '下游B'; pb.providerId = 'nokey_prov';
      connect(ta.id, pa.id, 0);
      connect(pa.id, pb.id, 0);
      await playNode(pb, false);
      log('auto-run upstream executed=' + (pa.error && pa.error.indexOf('API Key') >= 0));
      log('downstream executed too=' + (pb.error && pb.error.indexOf('API Key') >= 0));
      pa.output = { kind: 'text', text: '已有结果' }; pa.error = null; pa.ranAt = 1;
      const ran = [];
      await ensureProcessed(pa, ran);
      log('processed skip rerun=' + (ran.length === 0) + ' output kept=' + (pa.output.text === '已有结果'));

      // —— 第二个节点速度回归：本地假 API（500ms/请求），验证链路 ~1s 完成而非挂起 ——
      S.config.providers.push({ id: 'local', name: 'Local', type: 'text_openai', baseUrl: 'http://127.0.0.1:' + ${MOCK_PORT}, apiKey: 'k', models: ['m'], vision: false });
      addNode('input_text', 100, 950);
      const lt = S.wf.nodes[S.wf.nodes.length - 1];
      lt.text = '素材';
      addNode('proc_text', 360, 950);
      const la = S.wf.nodes[S.wf.nodes.length - 1];
      la.title = '链A'; la.providerId = 'local'; la.model = 'm';
      addNode('proc_text', 620, 950);
      const lb = S.wf.nodes[S.wf.nodes.length - 1];
      lb.title = '链B'; lb.providerId = 'local'; lb.model = 'm';
      connect(lt.id, la.id, 0);
      connect(la.id, lb.id, 0);
      const t0 = Date.now();
      await playNode(lb, false);
      const tChain = Date.now() - t0;
      const tReplay0 = Date.now();
      await playNode(lb, false);
      const tReplay = Date.now() - tReplay0;
      const rc = await window.api.fileReadText(${JSON.stringify(mockCountFile)});
      const reqCount = rc.exists ? rc.content.length : 0;
      log('chain elapsed=' + tChain + 'ms (expect ~1100) outputs=' + (la.output && la.output.text) + '|' + (lb.output && lb.output.text));
      log('replay elapsed=' + tReplay + 'ms (expect ~550) A kept=' + (la.output.text === '答案-1') + ' B=' + (lb.output.text === '答案-3') + ' totalReq=' + reqCount);
      const saveOk = await window.api.wfSave(S.wf.id, JSON.parse(JSON.stringify(S.wf)));
      log('save after play ok=' + saveOk.ok + ' (runPromise must not break clone)');

      // —— 处理节点输出必须写入存档并可从磁盘恢复 ——
      await new Promise((r) => setTimeout(r, 800)); // 等自动 persist 落盘
      const rl = await window.api.wfLoad(S.wf.id);
      const rla = rl.data.nodes.find((x) => x.id === la.id);
      const rlb = rl.data.nodes.find((x) => x.id === lb.id);
      log('output persisted in save: A=' + (rla.output && rla.output.text === '答案-1') + ' B=' + (rlb.output && rlb.output.text === '答案-3') + ' ranAt=' + (!!rla.ranAt));

      // —— 模拟重启：从磁盘重新加载 → 输出恢复到 UI ——
      const reload = await window.api.wfLoad(S.wf.id);
      S.wf = reload.data;
      S.wf.id = reload.data.id;
      migrateWf(S.wf);
      renderCanvas();
      const stEl = document.querySelector('#st-' + lb.id);
      const outEl = document.querySelector('.wf-node[data-nid="' + lb.id + '"] .n-out .md');
      log('restart restore: status=' + (stEl && stEl.textContent.indexOf('已处理') >= 0) + ' output=' + (outEl && outEl.textContent.indexOf('答案-3') >= 0));

      // —— 粘贴 YAML（剪贴板 → 批量文本节点条目） ——
      addNode('input_text', 700, 950);
      const py = S.wf.nodes[S.wf.nodes.length - 1];
      py.batch = true;
      py.entries = [];
      await pasteYaml(py);
      log('paste yaml entries=' + py.entries.length + ' k0=' + py.entries[0].title + ':' + py.entries[0].content + ' k1=' + py.entries[1].title + ':' + py.entries[1].content.replace(/\\n/g, '|'));
      const pasteBtns = [...document.querySelectorAll('.bentry-ops .mini')].filter((b) => b.textContent === '粘贴 YAML');
      log('paste btn present=' + (pasteBtns.length > 0));

      // —— YAML 缩进感知：嵌套结构不产生垃圾条目；列表项支持 ——
      const nested = parseSimpleYaml('root:\\n  child1: a\\n  child2: b\\nitem: x');
      log('yaml indent guarded: n=' + nested.length + ' expect 2, rootContent=' + nested[0].content.replace(/\\n/g, '|') + ' item=' + nested[1].title + ':' + nested[1].content);
      const listy = parseSimpleYaml('- 标题1: 内容1\\n- 标题2: 内容2');
      log('yaml list form: n=' + listy.length + ' t1=' + listy[0].title + ':' + listy[0].content + ' t2=' + listy[1].title);

      // —— 输入节点也允许输入：只读继承 / YAML 自动转批量 ——
      addNode('input_text', 100, 1150);
      const inA = S.wf.nodes[S.wf.nodes.length - 1];
      inA.text = '素材内容';
      addNode('input_text', 360, 1150);
      const inB = S.wf.nodes[S.wf.nodes.length - 1];
      inB.title = '继承节点';
      connect(inA.id, inB.id, 0);
      log('input node ports=' + inputCount(inB) + ' expect 2');
      log('inherit value=' + (valueForInput(inB, 0) && valueForInput(inB, 0).text) + ' expect 素材内容');
      log('inherit not batch=' + !isBatchInput(inB));
      renderCanvas();
      const roTa = document.querySelector('.wf-node[data-nid="' + inB.id + '"] .n-text');
      log('inherit readonly=' + (roTa && roTa.readOnly && roTa.value === '素材内容'));
      addNode('input_text', 100, 1300);
      const inC = S.wf.nodes[S.wf.nodes.length - 1];
      inC.text = '标题1: 内容1\\n标题2: 内容2';
      addNode('input_text', 360, 1300);
      const inD = S.wf.nodes[S.wf.nodes.length - 1];
      inD.title = 'YAML继承';
      connect(inC.id, inD.id, 0);
      log('yaml-inherit batch=' + isBatchInput(inD) + ' titles=' + batchTitles(inD).join(','));
      log('yaml-inherit item1=' + (valueForInput(inD, 1) && valueForInput(inD, 1).text) + ' expect 内容2');
      addNode('proc_text', 620, 1300);
      const inE = S.wf.nodes[S.wf.nodes.length - 1];
      inE.providerId = 'nokey_prov';
      connect(inD.id, inE.id, 0);
      log('downstream batch via inherit=' + isBatch(inE) + ' titles=' + batchTitles(inE).join(','));

      // —— 输出框高度与外框一致 ——
      const pEl = document.querySelector('.wf-node[data-nid="' + lb.id + '"]');
      const outEl2 = pEl.querySelector('.n-out');
      const rowEl = pEl.querySelector('.n-proc-row');
      log('n-out height matches row: out=' + outEl2.offsetHeight + ' row=' + rowEl.offsetHeight + ' diff=' + Math.abs(outEl2.offsetHeight - rowEl.offsetHeight) + ' md=' + pEl.querySelector('.n-out .md').offsetHeight);

      // —— 批量输入的两种模式：批量 / 聚合 ——
      addNode('input_text', 100, 1480);
      const ag1 = S.wf.nodes[S.wf.nodes.length - 1];
      ag1.batch = true;
      ag1.entries = [{ id: 'e', title: '条目X', content: '内容X' }, { id: 'e2', title: '条目Y', content: '内容Y' }];
      addNode('proc_text', 360, 1480);
      const ag2 = S.wf.nodes[S.wf.nodes.length - 1];
      ag2.title = '聚合节点'; ag2.providerId = 'local'; ag2.model = 'm';
      connect(ag1.id, ag2.id, 0);
      log('agg default mode=' + (ag2.batchMode || 'batch'));
      ag2.batchMode = 'agg';
      ag2.prompt = '比较 @条目X 与 @条目Y 的差异';
      const aggSpec = buildSpecAgg(ag2, S.config.providers.find((p) => p.id === 'local'));
      log('agg spec blocks=' + (aggSpec.prompt.indexOf('### 条目X') >= 0 && aggSpec.prompt.indexOf('### 条目Y') >= 0) + ' hasContent=' + aggSpec.prompt.includes('内容X'));
      log('agg @item refs=' + (aggSpec.prompt.indexOf('@') < 0) + ' promptHas=' + aggSpec.prompt.includes('比较 条目X 与 条目Y 的差异'));
      const aggUn = resolveRefsAgg('引用 @条目X 与 @不存在条目', ag2);
      log('agg @unresolved=' + (aggUn.unresolved.length === 1 && aggUn.prompt.includes('@不存在条目')));
      const candTitles = aggCandidates(ag2).map((c) => c.title).join(',');
      log('agg virtual inputs=' + candTitles + ' expect 条目X,条目Y');
      log('agg node isBatch=' + isBatch(ag2));
      addNode('proc_text', 620, 1480);
      const ag3 = S.wf.nodes[S.wf.nodes.length - 1];
      ag3.title = '下游'; ag3.providerId = 'local'; ag3.model = 'm';
      connect(ag2.id, ag3.id, 0);
      log('agg downstream not batch=' + !isBatch(ag3));
      const rcA = await window.api.fileReadText(${JSON.stringify(mockCountFile)});
      const cntBefore = rcA.exists ? rcA.content.length : 0;
      await playNode(ag2, false);
      const rcB = await window.api.fileReadText(${JSON.stringify(mockCountFile)});
      log('agg single run: reqs=' + (rcB.content.length - cntBefore) + ' expect 1, output=' + (ag2.output && ag2.output.kind === 'text') + ' batchOut=null=' + (ag2.batchOutputs === null));
      ag2.batchMode = 'batch';
      renderCanvas();
      log('mode toggle btn=' + (document.querySelectorAll('.n-mode-toggle').length > 0));

      // —— YAML 继承节点 → 聚合：条目展开（全部项） + @条目标题 ——
      addNode('input_text', 100, 1600);
      const ysrc = S.wf.nodes[S.wf.nodes.length - 1];
      ysrc.title = 'YAML源';
      ysrc.text = '标题A: 内容A\\n标题B: 内容B';
      addNode('input_text', 360, 1600);
      const yinh = S.wf.nodes[S.wf.nodes.length - 1];
      yinh.title = 'YAML继承节点';
      connect(ysrc.id, yinh.id, 0);
      const yItems = allTextItems(yinh);
      log('agg yaml-inherit items=' + yItems.map((i) => i.title).join(',') + ' expect 标题A,标题B');
      addNode('proc_text', 620, 1600);
      const yagg = S.wf.nodes[S.wf.nodes.length - 1];
      yagg.title = 'YAML聚合'; yagg.providerId = 'local'; yagg.model = 'm';
      yagg.batchMode = 'agg';
      connect(yinh.id, yagg.id, 0);
      const yspec = buildSpecAgg(yagg, S.config.providers.find((p) => p.id === 'local'));
      log('agg yaml all blocks=' + (yspec.prompt.indexOf('### 标题A') >= 0 && yspec.prompt.indexOf('### 标题B') >= 0) + ' notNodeTitle=' + (yspec.prompt.indexOf('### YAML继承节点') < 0));
      log('agg yaml candidates=' + aggCandidates(yagg).map((c) => c.title).join(',') + ' expect 标题A,标题B');
      const taTest = document.createElement('textarea');
      taTest.value = '前文 @';
      taTest.setSelectionRange(4, 4);
      document.body.appendChild(taTest);
      refTick(taTest, yagg);
      const menuTxt = $('#refMenu').textContent;
      log('agg dropdown items=' + (menuTxt.indexOf('标题A') >= 0 && menuTxt.indexOf('标题B') >= 0 && menuTxt.indexOf('YAML继承节点') < 0));
      closeRefMenu();
      taTest.remove();

      // —— 拆分 / 合并节点 ——
      inA.title = '节点甲';
      addNode('merge', 100, 1750);
      const mg = S.wf.nodes[S.wf.nodes.length - 1];
      mg.title = '合并器';
      connect(inA.id, mg.id, 0);
      connect(inD.id, mg.id, 1); // inD = YAML 继承批量 → 展开为 2 项
      log('merge items=' + mergeItems(mg).map((i) => i.title).join(',') + ' expect 节点甲,标题1,标题2');
      log('merge value idx1=' + (valueForInput(mg, 1) && valueForInput(mg, 1).text) + ' expect 内容1');
      log('merge value idx2=' + (valueForInput(mg, 2) && valueForInput(mg, 2).text) + ' expect 内容2');
      addNode('proc_text', 400, 1750);
      const mgp = S.wf.nodes[S.wf.nodes.length - 1];
      mgp.title = '合并下游'; mgp.providerId = 'local'; mgp.model = 'm';
      connect(mg.id, mgp.id, 0);
      const ob = originBatchInput(mgp);
      log('merge origin=' + (ob ? ob.kind + ':' + ob.title : 'null') + ' items=' + mergeItems(mg).length + ' mgTitles=' + batchTitles(mg).join(','));
      log('merge downstream batch=' + isBatch(mgp) + ' titles=' + batchTitles(mgp).join(',') + ' expect 节点甲,标题1,标题2');
      addNode('split', 700, 1750);
      const sp = S.wf.nodes[S.wf.nodes.length - 1];
      sp.title = '拆分器';
      connect(ag1.id, sp.id, 0);
      log('split items=' + splitItems(sp).map((i) => i.title).join(',') + ' expect 条目X,条目Y');
      log('split hasOutput=' + hasOutput(sp) + ' inputCount=' + inputCount(sp));
      sp.splitItemTitle = '条目X';
      log('split value=' + (valueForInput(sp, 0) && valueForInput(sp, 0).text) + ' expect 内容X');
      log('split isBatch(src batch)=' + isBatch(sp));
      addNode('proc_text', 980, 1750);
      const spd = S.wf.nodes[S.wf.nodes.length - 1];
      spd.providerId = 'local'; spd.model = 'm'; spd.title = '拆分下游';
      connect(sp.id, spd.id, 0);
      log('split downstream not batch=' + !isBatch(spd));
      ag1.entries = [{ id: 'z', title: '条目Z', content: '内容Z' }];
      log('split missing item empty=' + (valueForInput(sp, 0) === null) + ' selected=' + (splitSelected(sp) === null));
      ag1.entries = [{ id: 'e', title: '条目X', content: '内容X改' }, { id: 'e2', title: '条目Y', content: '内容Y' }];
      log('split live update=' + (valueForInput(sp, 0) && valueForInput(sp, 0).text === '内容X改'));

      // —— 清空输出 / 一键居中 / 缩放清晰度 / 条目高度 ——
      const clearNode = S.wf.nodes.find((x) => x.id === la.id);
      clearNode.output = { kind: 'text', text: 'x' };
      clearNode.ranAt = Date.now();
      clearOutput(clearNode);
      log('clear output=' + (clearNode.output === null && clearNode.ranAt === 0));
      fitCanvas();
      const cv = $('#canvas');
      const fitOk = S.wf.nodes.every((n) => {
        const sx = n.x * S.cam.z + S.cam.x, sy = n.y * S.cam.z + S.cam.y;
        return sx >= -50 && sy >= -50 && sx <= cv.clientWidth + 50 && sy <= cv.clientHeight + 50;
      });
      log('fit covers all nodes=' + fitOk + ' zoom=' + S.cam.z.toFixed(2) + ' zoomReadback=' + JSON.stringify($('#stage').style.zoom) + ' zoomIsSet=' + ($('#stage').style.zoom !== ''));
      ag1.entries[0].h = 120;
      renderCanvas();
      const bh = document.querySelector('.wf-node[data-nid="' + ag1.id + '"] .bentry-text[data-eid="' + ag1.entries[0].id + '"]');
      log('entry height applied=' + (bh && bh.style.height === '120px'));

      // —— gpt-image-2-vip 文生图 / 图片编辑参数 ——
      S.config.providers.push({ id: 'imgvip', name: 'ImageVIP', type: 'image_openai', baseUrl: 'http://127.0.0.1:9', apiKey: 'k', models: ['gpt-image-2-vip'] });
      addNode('proc_image', 360, 1950);
      const ip = S.wf.nodes[S.wf.nodes.length - 1];
      ip.providerId = 'imgvip'; ip.model = 'gpt-image-2-vip';
      const ispec = buildSpec(ip, S.config.providers.find((p) => p.id === 'imgvip'), 0);
      log('img size default=' + ispec.size + ' expect 2048x1360');
      const pvG = await window.api.apiPreview(ispec);
      log('img gen preview=' + (pvG.request.url.indexOf('/images/generations') >= 0) + ' size=' + pvG.request.body.size + ' noN=' + (pvG.request.body.n === undefined) + ' model=' + pvG.request.body.model);
      ispec.images = ['C:/fake/ref1.png', 'C:/fake/ref2.png'];
      const pvE = await window.api.apiPreview(ispec);
      log('img edit preview=' + (pvE.request.url.indexOf('/images/edits') >= 0) + ' multipart=' + JSON.stringify(pvE.request.body).includes('__multipart') + ' refs=' + (pvE.request.body.__multipart.image.length === 2));

      // —— zoom 坐标映射诊断（连线末端是否在鼠标上） ——
      S.cam = { x: 200, y: 150, z: 1.7 };
      applyTransform();
      const cr2 = $('#canvas').getBoundingClientRect();
      const sx0 = 500, sy0 = 400;
      const cx0 = cr2.left + S.cam.x + sx0 * S.cam.z;
      const cy0 = cr2.top + S.cam.y + sy0 * S.cam.z;
      const back0 = toStage(cx0, cy0);
      log('zoom mapping roundtrip=' + (Math.abs(back0.x - sx0) < 1 && Math.abs(back0.y - sy0) < 1) + ' back=' + back0.x.toFixed(1) + ',' + back0.y.toFixed(1) + ' expect ' + sx0 + ',' + sy0);

      // —— 合成拖线：末端是否跟随鼠标 ——
      S.cam = { x: 90, y: 80, z: 1.5 };
      applyTransform();
      renderCanvas();
      const portOut = document.querySelector('.wf-node[data-nid="' + inA.id + '"] .port.out');
      const pr = portOut.getBoundingClientRect();
      const mdX = pr.left + pr.width / 2, mdY = pr.top + pr.height / 2;
      portOut.dispatchEvent(new MouseEvent('mousedown', { clientX: mdX, clientY: mdY, bubbles: true }));
      log('drag after mousedown=' + (S.drag ? S.drag.mode : 'null') + ' ports=' + document.querySelectorAll('.port.out').length);
      const mvX = mdX + 300, mvY = mdY + 200;
      window.dispatchEvent(new MouseEvent('mousemove', { clientX: mvX, clientY: mvY, buttons: 1, bubbles: true }));
      const temp = document.querySelector('#wireTemp');
      log('temp exists=' + (!!temp) + ' dragMode=' + (S.drag && S.drag.mode) + ' mx=' + (S.drag && S.drag.mx) + ' d=' + JSON.stringify(temp && temp.getAttribute('d')));
      const dAttr = temp.getAttribute('d');
      const nums = dAttr.match(/[\\d.]+/g).map(Number);
      const endX = nums[nums.length - 2], endY = nums[nums.length - 1];
      const want = toStage(mvX, mvY);
      log('wire end follows mouse=' + (Math.abs(endX - want.x) < 1 && Math.abs(endY - want.y) < 1) + ' end=' + endX.toFixed(0) + ',' + endY.toFixed(0) + ' want=' + want.x.toFixed(0) + ',' + want.y.toFixed(0));
      window.dispatchEvent(new MouseEvent('mouseup', { clientX: mvX, clientY: mvY, bubbles: true }));

      // —— 打字不保存，失焦才保存 ——
      const lastSave1 = S.lastSaved;
      const taT = document.querySelector('.wf-node[data-nid="' + inA.id + '"] .n-text');
      taT.value = '新内容';
      taT.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 400));
      log('typing no save=' + (S.lastSaved === lastSave1));
      taT.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 400));
      log('blur saves=' + (S.lastSaved !== lastSave1) + ' text=' + inA.text);

      // —— 任务节点：脚手架 / 控制流成功终点 ——
      const tk = addNode('task', 100, 2200);
      tk.title = '总计划';
      tk.goal = '验证控制流';
      const start = S.wf.nodes.find((n) => n.parentTaskId === tk.id && n.ctrlRole === 'start');
      const endOk = S.wf.nodes.find((n) => n.parentTaskId === tk.id && n.ctrlRole === 'endSuccess');
      const endFail = S.wf.nodes.find((n) => n.parentTaskId === tk.id && n.ctrlRole === 'endFail');
      log('task scaffold=' + !!(start && endOk && endFail && start.ctrlPinned && endOk.ctrlPinned));
      addWire(start.id, endOk.id, 0, { fromIndex: 0, notify: false, save: false });
      await playTaskNode(tk, true);
      log('task play success=' + (tk.taskStatus === 'done'));
      const nBeforePin = S.wf.nodes.length;
      deleteNodes([start.id], true);
      log('task pin undeletable=' + (S.wf.nodes.length === nBeforePin && !!nodeById(start.id)));
      addInnerTask(tk);
      log('task inner child=' + (taskChildTasksOf(tk.id).length >= 1));
      const jg = addNode('judge', 400, 2200);
      log('judge ports=' + (outputCount(jg) === 2 && inputCount(jg) >= 1));
      setTaskFocus('');
      log('task top visible=' + visibleWfNodes().some((n) => n.id === tk.id) + ' inner hidden=' + !visibleWfNodes().some((n) => n.parentTaskId === tk.id));
      log('task value=' + (valueForInput(tk, 0) && valueForInput(tk, 0).kind));

      // —— 控制流到达失败终点 ——
      const tkFail = addNode('task', 100, 2600);
      tkFail.title = '失败任务';
      const stF = S.wf.nodes.find((n) => n.parentTaskId === tkFail.id && n.ctrlRole === 'start');
      const endF = S.wf.nodes.find((n) => n.parentTaskId === tkFail.id && n.ctrlRole === 'endFail');
      addWire(stF.id, endF.id, 0, { fromIndex: 0, notify: false, save: false });
      await playTaskNode(tkFail, true);
      log('task play fail=' + (tkFail.taskStatus === 'failed'));
      renderCanvas();
      const failEl = document.querySelector('.wf-node[data-nid="' + tkFail.id + '"]');
      log('task empty grid hidden=' + !!(failEl && !failEl.querySelector('.task-grid')));
      const tkOpen = addNode('task', 100, 2800);
      await playTaskNode(tkOpen, true);
      log('task play open fail=' + (tkOpen.taskStatus === 'failed'));

      // —— 定时触发器：cron / 下次时间 ——
      const tm = addNode('timer', 100, 2900);
      tm.timerMode = 'cron';
      tm.timerCron = '0 * * * *';
      const nextT = computeTimerNextAt(tm, Date.now());
      log('timer cron next=' + (nextT > Date.now() && nextT < Date.now() + 3660 * 1000));
      tm.timerMode = 'interval';
      tm.timerEverySec = 60;
      tm.timerLastAt = 0;
      const nextI = computeTimerNextAt(tm, Date.now());
      log('timer interval next=' + (nextI > Date.now() && nextI <= Date.now() + 61000));
      log('timer no input=' + (inputCount(tm) === 0 && hasOutput(tm)));

      // —— 进入任务时自动整理内部排版 ——
      const tkLay = addNode('task', 100, 3000);
      tkLay.title = '排版父任务';
      const cA = makeNode('task', 900, 3100);
      cA.title = uniqueNodeTitle('排版子A');
      cA.parentTaskId = tkLay.id;
      const cB = makeNode('task', 200, 3400);
      cB.title = uniqueNodeTitle('排版子B');
      cB.parentTaskId = tkLay.id;
      S.wf.nodes.push(cA, cB);
      enterTask(tkLay, { toast: false });
      const moved = cA.x !== 900 || cB.x !== 200 || cA.y !== 3100 || cB.y !== 3400;
      log('task enter layout=' + (S.taskFocus === tkLay.id && moved));
      setTaskFocus('');

      // —— 画布资产图像：超过 1080p 自动降采样 ——
      const cvBig = document.createElement('canvas');
      cvBig.width = 1920; cvBig.height = 1200;
      const cBig = cvBig.getContext('2d');
      cBig.fillStyle = '#336699'; cBig.fillRect(0, 0, 1920, 1200);
      const bigB64 = cvBig.toDataURL('image/png').split(',')[1];
      const bigAsset = await window.api.assetWriteBase64(S.wf.id, 'cap_1080', bigB64, 'png');
      const bigSz = await new Promise((resolve) => {
        const im = new Image();
        im.onload = () => resolve({ w: im.naturalWidth, h: im.naturalHeight });
        im.onerror = () => resolve({ w: 0, h: 0 });
        im.src = window.api.toFileUrl(bigAsset.path);
      });
      log('asset cap1080=' + (bigSz.w <= 1080 && bigSz.h <= 1080 && bigSz.w > 0) + ' size=' + bigSz.w + 'x' + bigSz.h + ' expect<=1080');
      const cvOk = document.createElement('canvas');
      cvOk.width = 800; cvOk.height = 600;
      cvOk.getContext('2d').fillRect(0, 0, 800, 600);
      const okAsset = await window.api.assetWriteBase64(S.wf.id, 'keep_800', cvOk.toDataURL('image/png').split(',')[1], 'png');
      const okSz = await new Promise((resolve) => {
        const im = new Image();
        im.onload = () => resolve({ w: im.naturalWidth, h: im.naturalHeight });
        im.onerror = () => resolve({ w: 0, h: 0 });
        im.src = window.api.toFileUrl(okAsset.path);
      });
      log('asset keepUnder=' + (okSz.w === 800 && okSz.h === 600) + ' size=' + okSz.w + 'x' + okSz.h);

      // —— 实际渲染位置 vs 坐标公式（scale 生效验证） ——
      S.cam = { x: 300, y: 250, z: 2 };
      applyTransform();
      const cn = document.querySelector('.wf-node[data-nid="' + inA.id + '"]');
      const cnr = cn.getBoundingClientRect();
      const cr3 = $('#canvas').getBoundingClientRect();
      const expectX = cr3.left + S.cam.x + inA.x * S.cam.z;
      const expectY = cr3.top + S.cam.y + inA.y * S.cam.z;
      log('zoom actually scales=' + ($('#stage').getBoundingClientRect().width.toFixed(0) === '6400') + ' render match=' + (Math.abs(cnr.left - expectX) < 1.5 && Math.abs(cnr.top - expectY) < 1.5) + ' scaledNodeW=' + cnr.width.toFixed(0));

      // —— 布局：WORKFLOW 行移除 / 提示行 / 作者弹窗 / Ctrl+C ——
      log('pane-head removed=' + (document.querySelector('.pane-head') === null));
      log('hint text=' + JSON.stringify($('#canvasHint') ? $('#canvasHint').textContent : '(hint removed, new toolbar)'));
      log('toolbar layout=' + (!!$('#wfTabs') && !!$('#wfWsBox') && !!document.querySelector('.fn-toolbar')));
      log('task crumb before tabs=' + ($('#taskCrumb') && $('#taskCrumb').nextElementSibling && $('#taskCrumb').nextElementSibling.id === 'wfTabs'));
      log('author link=' + ($('#authorLink').textContent === '@ms2308'));
      openAuthorPopup();
      const apText = $('#ovBody').textContent;
      log('author popup=' + (apText.indexOf('@ms2308') >= 0 && apText.indexOf('https://space.bilibili.com/16411347') >= 0) + ' centered=' + ($('#overlay').style.alignItems === 'center'));
      closeOverlay();
      const ccBefore = S.wf.nodes.length;
      S.sel = spd.id;
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'c', ctrlKey: true, bubbles: true }));
      log('ctrl+c duplicates=' + (S.wf.nodes.length === ccBefore + 1));

      // —— 任务节点：面包屑 / grid / 待办 ——
      const tk2 = addNode('task', 700, 2200);
      addInnerTask(tk2);
      renderCanvas();
      const tk2El = document.querySelector('.wf-node[data-nid="' + tk2.id + '"]');
      log('task labels=' + (!!tk2El && tk2El.textContent.indexOf('待办') >= 0));
      log('task default status=' + tk2.taskStatus + ' expect pending');
      const gridCell = tk2El && tk2El.querySelector('.task-cell');
      log('task grid cell=' + !!gridCell);

      // —— 文本对话节点 ——
      addNode('chat', 100, 2450);
      const ch = S.wf.nodes[S.wf.nodes.length - 1];
      ch.title = '对话';
      ch.providerId = 'local'; ch.model = 'm';
      await chatSend(ch, '你好');
      log('chat messages=' + ch.messages.length + ' roles=' + ch.messages.map((m) => m.role).join(',') + ' reply=' + (ch.messages[1] && ch.messages[1].content));
      renderCanvas();
      const chEl = document.querySelector('.wf-node[data-nid="' + ch.id + '"]');
      const bubbles = chEl.querySelectorAll('.chat-bubble');
      log('chat bubbles=' + bubbles.length + ' me=' + (chEl.querySelector('.chat-msg.me .chat-bubble') !== null) + ' ai=' + (chEl.querySelector('.chat-msg.ai .chat-bubble') !== null));
      log('chat input+btn=' + (chEl.querySelector('.chat-input') !== null && chEl.querySelector('.chat-input-row .mini') !== null));
      log('chat hasOutput=' + hasOutput(ch) + ' value=' + (valueForInput(ch, 0) && valueForInput(ch, 0).kind));
      const tr = chatTranscript(ch);
      log('chat transcript=' + (tr.indexOf('【对话记录】') === 0 && tr.indexOf('**用户**：你好') >= 0 && tr.indexOf('**AI**：答案') >= 0));
      log('chat textSource=' + isTextSource(ch));
      const chList = chEl.querySelector('.chat-list');
      chList.dispatchEvent(new MouseEvent('mousedown', { clientX: 200, clientY: 200, bubbles: true }));
      const listDrag = S.drag && S.drag.mode === 'node';
      window.dispatchEvent(new MouseEvent('mouseup', { clientX: 200, clientY: 200, bubbles: true }));
      const chInput2 = document.querySelector('.wf-node[data-nid="' + ch.id + '"] .chat-input');
      chInput2.dispatchEvent(new MouseEvent('mousedown', { clientX: 210, clientY: 240, bubbles: true }));
      const inputDrag = !!(S.drag && S.drag.mode === 'node');
      window.dispatchEvent(new MouseEvent('mouseup', { clientX: 210, clientY: 240, bubbles: true }));
      log('chat list drag works=' + listDrag + ' input drag blocked=' + !inputDrag);
      // —— 对话节点输出端子拉线可视化 ——
      const chPort = document.querySelector('.wf-node[data-nid="' + ch.id + '"] .port.out');
      const chPr = chPort.getBoundingClientRect();
      const chMX = chPr.left + chPr.width / 2, chMY = chPr.top + chPr.height / 2;
      chPort.dispatchEvent(new MouseEvent('mousedown', { clientX: chMX, clientY: chMY, bubbles: true }));
      window.dispatchEvent(new MouseEvent('mousemove', { clientX: chMX + 250, clientY: chMY + 100, buttons: 1, bubbles: true }));
      const chTemp = document.querySelector('#wireTemp');
      const chD = chTemp.getAttribute('d');
      const nums2 = chD.match(/[\\d.]+/g).map(Number);
      const end2 = [nums2[nums2.length - 2], nums2[nums2.length - 1]];
      const want2 = toStage(chMX + 250, chMY + 100);
      const tempVis = getComputedStyle(chTemp).display !== 'none' && chD.length > 5;
      log('chat wire temp: vis=' + tempVis + ' end=' + end2.map((v) => Math.round(v)) + ' want=' + [Math.round(want2.x), Math.round(want2.y)] + ' d=' + chD.slice(0, 40));
      window.dispatchEvent(new MouseEvent('mouseup', { clientX: chMX + 250, clientY: chMY + 100, bubbles: true }));

      // —— 控制节点：金色边框/连线、指挥线不占用数据、批量清空 ——
      addNode('proc_text', 100, 3100);
      const cProc = S.wf.nodes[S.wf.nodes.length - 1];
      cProc.title = '受控处理';
      cProc.output = { kind: 'text', text: 'to-clear' };
      cProc.ranAt = Date.now();
      addNode('input_text', 100, 3280);
      const cIn = S.wf.nodes[S.wf.nodes.length - 1];
      cIn.text = 'keep-me';
      addNode('control', 420, 3100);
      const ctrl = S.wf.nodes[S.wf.nodes.length - 1];
      log('control title=' + ctrl.title + ' action=' + ctrl.ctrlAction);
      addWire(ctrl.id, cProc.id);
      addWire(ctrl.id, cIn.id);
      log('ctrl dataWires proc=' + wiresTo(cProc.id).length + ' all=' + allWiresTo(cProc.id).length + ' expect 0/1');
      log('ctrl not inherit input=' + (inputInherited(cIn) === false) + ' text=' + cIn.text);
      renderCanvas();
      const ctrlEl = document.querySelector('.wf-node[data-nid="' + ctrl.id + '"]');
      log('ctrl class=' + (ctrlEl && ctrlEl.classList.contains('ctrl')) + ' toggles=' + (ctrlEl ? ctrlEl.querySelectorAll('.n-ctrl-toggle').length : 0));
      addNode('proc_image', 700, 3100);
      const cImg = S.wf.nodes[S.wf.nodes.length - 1];
      renderCanvas();
      const imgEl = document.querySelector('.wf-node[data-nid="' + cImg.id + '"]');
      log('proc_image class=' + (imgEl && imgEl.classList.contains('proc-img')));
      const cw = S.wf.wires.find((w) => w.from === ctrl.id && w.to === cProc.id);
      const cwEl = cw && document.getElementById('wire-' + cw.id);
      log('ctrl wire class=' + (cwEl && (' ' + cwEl.getAttribute('class') + ' ').indexOf(' ctrl ') >= 0));
      ctrl.ctrlAction = 'clear';
      await playControlNode(ctrl);
      log('ctrl clear proc=' + (cProc.output == null) + ' input cleared=' + (cIn.text === ''));
      // —— 控制节点执行：拓扑上游优先，避免下游吃旧结果 ——
      addNode('proc_text', 100, 3400);
      const upP = S.wf.nodes[S.wf.nodes.length - 1];
      upP.title = '上游处理'; upP.providerId = 'local'; upP.model = 'm';
      upP.output = { kind: 'text', text: 'OLD-UP' }; upP.ranAt = 1;
      addNode('proc_text', 360, 3400);
      const dnP = S.wf.nodes[S.wf.nodes.length - 1];
      dnP.title = '下游处理'; dnP.providerId = 'local'; dnP.model = 'm';
      dnP.output = { kind: 'text', text: 'OLD-DN' }; dnP.ranAt = 1;
      connect(upP.id, dnP.id, 0);
      addNode('control', 620, 3400);
      const ctrl2 = S.wf.nodes[S.wf.nodes.length - 1];
      ctrl2.ctrlAction = 'run';
      addWire(ctrl2.id, dnP.id);
      addWire(ctrl2.id, upP.id);
      const ord = controlRunOrder([dnP, upP]);
      log('ctrl topo order=' + ord.map((n) => n.title).join('>') + ' expect 上游处理>下游处理');
      const layersDep = controlRunLayers([dnP, upP]);
      log('ctrl layers dep=' + layersDep.map((w) => w.map((n) => n.title).join('+')).join('|') + ' expect 上游处理|下游处理');
      await playControlNode(ctrl2);
      log('ctrl run upstreamFirst=' + (
        !!(upP.output && upP.output.text !== 'OLD-UP' && dnP.output && dnP.output.text !== 'OLD-DN'
          && upP.ranAt > 0 && dnP.ranAt >= upP.ranAt)
      ));
      addNode('input_text', 100, 3550);
      const parIn = S.wf.nodes[S.wf.nodes.length - 1];
      parIn.text = 'p';
      addNode('proc_text', 360, 3550);
      const parA = S.wf.nodes[S.wf.nodes.length - 1];
      parA.title = '并行A'; parA.providerId = 'local'; parA.model = 'm';
      addNode('proc_text', 620, 3550);
      const parB = S.wf.nodes[S.wf.nodes.length - 1];
      parB.title = '并行B'; parB.providerId = 'local'; parB.model = 'm';
      connect(parIn.id, parA.id, 0);
      connect(parIn.id, parB.id, 0);
      addNode('control', 880, 3550);
      const ctrl3 = S.wf.nodes[S.wf.nodes.length - 1];
      ctrl3.ctrlAction = 'run';
      addWire(ctrl3.id, parA.id);
      addWire(ctrl3.id, parB.id);
      const layersPar = controlRunLayers([parA, parB]);
      log('ctrl layers par=' + layersPar.length + ':' + (layersPar[0] && layersPar[0].length) + ' expect 1:2');
      const tPar0 = Date.now();
      await playControlNode(ctrl3);
      const tPar = Date.now() - tPar0;
      log('ctrl parallel both=' + !!(parA.output && parB.output) + ' ms=' + tPar + ' fast=' + (tPar < 900));

      // —— 画布绘制标注（文本 / 框体 / 箭头，纯展示） ——
      const mkT = addMark('text', 100, 3600);
      const mkB = addMark('box', 320, 3600);
      const mkA = addMark('arrow', 600, 3650);
      renderCanvas();
      log('mark kinds=' + [mkT.kind, mkB.kind, mkA.kind].join(',') + ' n=' + marksOf().length);
      log('mark dom=' + !!document.querySelector('.wf-mark.mk-text') + '/' + !!document.querySelector('.wf-mark.mk-box') + '/' + !!document.querySelector('.wf-mark.mk-arrow'));
      log('mark tools=' + (document.querySelectorAll('.wf-mark .mk-tools').length >= 3));
      cycleMarkColor(mkB);
      bumpMarkSize(mkT, 1);
      log('mark edit color=' + (mkB.color !== MARK_DEFAULTS.box.color) + ' font=' + (mkT.fontSize > MARK_DEFAULTS.text.fontSize));
      deleteMarks([mkT.id, mkB.id, mkA.id]);
      log('mark deleted=' + (marksOf().length === 0));

      // —— Markdown 渲染 ——
      const mdSrc = "# 标题\\n**加粗** 和 \`代码\`\\n\\n\`\`\`js\\nconst x = 1;\\n\`\`\`\\n\\n[链接](https://example.com) 与 <script>alert(1)</script>";
      const mdHtml = renderMarkdown(mdSrc);
      log('md heading=' + (mdHtml.indexOf('<h1') >= 0) + ' bold=' + (mdHtml.indexOf('<strong>') >= 0) + ' code=' + (mdHtml.indexOf('<code>') >= 0) + ' pre=' + (mdHtml.indexOf('<pre>') >= 0));
      log('md link=' + (mdHtml.indexOf('href="https://example.com"') >= 0) + ' xssBlocked=' + (mdHtml.indexOf('<script>') < 0));
      const lc = S.wf.nodes.find((x) => x.id === la.id);
      lc.output = { kind: 'text', text: '# 报告\\n内容 **加粗**' };
      lc.ranAt = Date.now();
      renderCanvas();
      const mdOut = document.querySelector('.wf-node[data-nid="' + la.id + '"] .n-out .md');
      log('md output panel=' + (!!mdOut && mdOut.querySelector('h1') !== null && mdOut.querySelector('strong') !== null));
      clearOutput(lc);

      // —— 文本节点 文件参考（小文件导入 / 超 500KB 拒绝） ——
      addNode('input_text', 100, 2600);
      const fr = S.wf.nodes[S.wf.nodes.length - 1];
      const smallPath = ${JSON.stringify(path.join(process.env.TEMP || '.', 'mtnode_ref_small.txt'))};
      const bigPath = ${JSON.stringify(path.join(process.env.TEMP || '.', 'mtnode_ref_big.txt'))};
      const bigContent = 'x'.repeat(600 * 1024);
      await window.api.fileWriteText(smallPath, '参考文件内容-测试');
      await window.api.fileWriteText(bigPath, bigContent);
      await importFileToText(fr, smallPath);
      log('file ref small=' + (fr.text === '参考文件内容-测试'));
      fr.text = '';
      await importFileToText(fr, bigPath);
      log('file ref >500KB rejected=' + (fr.text === ''));
      renderCanvas();
      const frBtn = document.querySelector('.wf-node[data-nid="' + fr.id + '"] .n-head .n-file-ref');
      log('file ref btn=' + (frBtn && frBtn.title.indexOf('文件参考') >= 0));

      // —— 停止按钮：运行中显示红方块，点击立即中止 ——
      addNode('proc_text', 100, 2750);
      const stNode = S.wf.nodes[S.wf.nodes.length - 1];
      stNode.providerId = 'local'; stNode.model = 'm';
      const runP2 = playNode(stNode, true);
      await new Promise((r) => setTimeout(r, 120));
      renderCanvas();
      const stopBtn = document.querySelector('.wf-node[data-nid="' + stNode.id + '"] .n-stop');
      log('stop btn while running=' + (!!stopBtn));
      await stopNode(stNode);
      await runP2;
      log('stop result=' + (stNode.error === '已手动停止') + ' running=' + stNode.running + ' abKeyCleared=' + (!stNode._abKey));
      renderCanvas();
      log('stop btn hidden after=' + (document.querySelector('.wf-node[data-nid="' + stNode.id + '"] .n-stop') === null));

      // —— 多模态识图：无视觉服务商时接入图像被阻止；有视觉服务商时自动切换并可运行 ——
      addNode('input_image', 700, 2750);
      const vi = S.wf.nodes[S.wf.nodes.length - 1];
      vi.imageAsset = (await window.api.assetWriteBase64(S.wf.id, 'vi_src', (() => { const c = document.createElement('canvas'); c.width = 4; c.height = 4; const x = c.getContext('2d'); x.fillStyle = '#123456'; x.fillRect(0, 0, 4, 4); return c.toDataURL('image/png').split(',')[1]; })(), 'png')).path;
      addNode('proc_text', 980, 2750);
      const vp = S.wf.nodes[S.wf.nodes.length - 1];
      vp.title = '识图节点';
      vp.providerId = 'deepseek'; vp.model = 'deepseek-v4-flash';
      connect(vi.id, vp.id, 0);
      const mockCount0 = (await window.api.fileReadText(${JSON.stringify(mockCountFile)})).exists ? (await window.api.fileReadText(${JSON.stringify(mockCountFile)})).content.length : 0;
      await playNode(vp, false);
      const mockCount1 = (await window.api.fileReadText(${JSON.stringify(mockCountFile)})).content.length;
      log('vision blocked=' + (vp.error && vp.error.indexOf('未添加多模态模型') >= 0) + ' noRequest=' + (mockCount1 === mockCount0));
      S.config.providers.push({ id: 'vision1', name: 'Vision', type: 'text_openai', baseUrl: 'http://127.0.0.1:' + ${MOCK_PORT}, apiKey: 'k', models: ['vision-model'], vision: true });
      vp.providerId = 'deepseek'; vp.model = 'deepseek-v4-flash'; vp.error = null; vp.output = null;
      const auto = ensureProcTextVision(vp, { notify: false });
      log('vision autoSwitch=' + (!!auto.ok && auto.switched && vp.providerId === 'vision1' && vp.model === 'vision-model'));
      await playNode(vp, false);
      const mockCount2 = (await window.api.fileReadText(${JSON.stringify(mockCountFile)})).content.length;
      log('vision runs=' + (vp.output && vp.output.kind === 'text') + ' requestSent=' + (mockCount2 > mockCount1));

      // —— 撤销 / 重做 ——
      const beforeCount = S.wf.nodes.length;
      addNode('input_text', 300, 300);
      const afterAdd = S.wf.nodes.length;
      undo();
      const afterUndo = S.wf.nodes.length;
      redo();
      const afterRedo = S.wf.nodes.length;
      undo();
      const afterUndo2 = S.wf.nodes.length;
      log('undo/redo ok=' + (afterAdd === beforeCount + 1 && afterUndo === beforeCount && afterRedo === afterAdd && afterUndo2 === beforeCount) + ' stacks=' + S.undoStack.length + '/' + S.redoStack.length);

      // —— 流式思考（reasoning_content）：思考捕获 + 思考 icon + 弹窗 ——
      const rdCnt = async () => (await window.api.fileReadText(${JSON.stringify(mockCountFile)})).content.length;
      addNode('input_text', 100, 2500);
      const thSrc = S.wf.nodes[S.wf.nodes.length - 1];
      thSrc.title = '思考素材'; thSrc.text = '素材';
      addNode('proc_text', 360, 2500);
      const th1 = S.wf.nodes[S.wf.nodes.length - 1];
      th1.title = '思考节点'; th1.providerId = 'local'; th1.model = 'm';
      connect(thSrc.id, th1.id, 0);
      const cntT0 = await rdCnt();
      await playNode(th1, false);
      const cntT1 = await rdCnt();
      const thinkTxt = (S.thinking[th1.id] || [])[0] || '';
      log('stream req=1:' + (cntT1 - cntT0 === 1) + ' thinking=' + (thinkTxt.indexOf('推理A-推理B') >= 0) + ' output=' + (th1.output && th1.output.text === '答案-' + (cntT0 + 1)));
      renderCanvas();
      const thinkIcon = document.querySelector('.wf-node[data-nid="' + th1.id + '"] .n-think');
      log('think icon shown=' + (thinkIcon && thinkIcon.classList.contains('show')) + ' text=' + (thinkIcon && thinkIcon.textContent.trim()));
      showThinking(th1);
      const tp = document.getElementById('thinkPre');
      log('think overlay=' + (tp && tp.textContent.indexOf('推理A-推理B') >= 0));
      closeOverlay();

      // —— 多次尝试：并行 N 次 + 方形 Tabs + 下游引用切换 ——
      const handles = document.querySelectorAll('.n-drag-handle');
      const rens = document.querySelectorAll('.n-ren');
      log('drag handle on all nodes=' + (handles.length === S.wf.nodes.length && handles[0].textContent.trim() === '✋') + ' rename btn removed=' + (rens.length === 0));
      th1.attempts = 3;
      const cntA0 = await rdCnt();
      await playNode(th1, false);
      const cntA1 = await rdCnt();
      const slots = th1.attemptOutputs || [];
      log('attempts reqs=3:' + (cntA1 - cntA0 === 3) + ' slots=' + slots.length + ' allOk=' + (slots.length === 3 && slots.every((o) => o.output && o.output.kind === 'text')));
      const valDiffs = new Set(slots.map((o) => o.output.text)).size;
      log('attempts parallel distinct=' + (valDiffs === 3) + ' vals=' + slots.map((o) => o.output.text).join(','));
      log('attempt status=' + (statusOf(th1).txt.indexOf('尝试 1/3') >= 0));
      renderCanvas();
      const tabs = document.querySelectorAll('.wf-node[data-nid="' + th1.id + '"] .n-att-tab');
      log('attempt tabs=' + tabs.length + ' expect 3, active=' + document.querySelector('.wf-node[data-nid="' + th1.id + '"] .n-att-tab.on').textContent);
      const attBtn = document.querySelector('.wf-node[data-nid="' + th1.id + '"] .n-att-btn');
      log('attempt btn shows x3=' + (attBtn && attBtn.textContent === '×3'));
      const v0 = valueForInput(th1, 0);
      setAttempt(th1, 1);
      const v1 = valueForInput(th1, 0);
      setAttempt(th1, 2);
      const v2 = valueForInput(th1, 0);
      log('switch attempt changes downstream value=' + (v0.text !== v1.text && v1.text !== v2.text) + ' v0=' + v0.text + ' v1=' + v1.text + ' v2=' + v2.text);
      log('setAttempt idx=2:' + (th1.attemptIdx === 2));
      const ranB = [];
      await ensureProcessed(th1, ranB);
      log('attempts skip rerun=' + (ranB.length === 0));
      th1.attempts = 99;
      log('attempt clamp max=10:' + (attemptCount(th1) === 10));
      th1.attempts = 0;
      log('attempt clamp min=1:' + (attemptCount(th1) === 1));
      th1.attempts = 1;
      const cntA2 = await rdCnt();
      await playNode(th1, false);
      const cntA3 = await rdCnt();
      log('attempts reset single req=1:' + (cntA3 - cntA2 === 1) + ' legacy output=' + (th1.output && th1.output.kind === 'text'));

      // —— 画布插件:创建物品配置工作流并自动排版(不重叠、可 @引用) ——
      const beforeN = S.wf.nodes.length;
      const beforeW = S.wf.wires.length;
      const rCanvas = await applyCanvasOp('edit', {
        setWorkflowName: '',
        create: [
          { alias: 'req', kind: 'input_text', title: '物品需求', text: '新剑: 攻击+10' },
          { alias: 'fmt', kind: 'input_text', title: '配置表格式', text: 'id: name\\n  atk: n' },
          { alias: 'gen', kind: 'proc_text', title: '生成物品配置', prompt: '按格式输出 YAML', refs: ['物品需求', '配置表格式'] },
          { alias: 'save', kind: 'save_text', title: '写入配置表', savePath: 'E:/game/items.yaml', auto: true },
        ],
        connect: [
          { from: 'req', to: 'gen' },
          { from: 'fmt', to: 'gen' },
          { from: 'gen', to: 'save' },
        ],
        group: { title: '物品配置工作流' },
        layout: true,
      });
      const afterN = S.wf.nodes.length;
      const afterW = S.wf.wires.length;
      const reqN = S.wf.nodes.find((n) => n.title === '物品需求');
      const fmtN = S.wf.nodes.find((n) => n.title === '配置表格式');
      const genN = S.wf.nodes.find((n) => n.title === '生成物品配置');
      const saveN = S.wf.nodes.find((n) => n.title === '写入配置表');
      const gItem = (S.wf.groups || []).find((g) => g.title === '物品配置工作流');
      let overlap = false;
      const neu = [reqN, fmtN, genN, saveN];
      for (let i = 0; i < neu.length; i++) {
        for (let j = i + 1; j < neu.length; j++) {
          if (rectsOverlap(neu[i], neu[j], 8)) overlap = true;
        }
      }
      const genRefs = genN && genN.prompt && genN.prompt.indexOf('@物品需求') >= 0 && genN.prompt.indexOf('@配置表格式') >= 0;
      const wired = genN && reqN && fmtN && saveN &&
        S.wf.wires.some((w) => w.from === reqN.id && w.to === genN.id) &&
        S.wf.wires.some((w) => w.from === fmtN.id && w.to === genN.id) &&
        S.wf.wires.some((w) => w.from === genN.id && w.to === saveN.id);
      log('canvas edit ok=' + (rCanvas && rCanvas.ok) + ' +nodes=' + (afterN - beforeN) + ' +wires=' + (afterW - beforeW));
      log('canvas refs=' + genRefs + ' wired=' + wired + ' group=' + !!(gItem && gItem.nodeIds && gItem.nodeIds.length >= 4) + ' noOverlap=' + !overlap);

      // —— 画布编辑：替换节点模型 / 服务商 ——
      S.config.providers.push({ id: 'swap_prov', name: 'SwapProv', type: 'text_openai', baseUrl: 'http://127.0.0.1:' + ${MOCK_PORT}, apiKey: 'k', models: ['swap-model-a', 'swap-model-b'], vision: false });
      genN.providerId = 'local'; genN.model = 'm';
      const rModel = await applyCanvasOp('edit', {
        update: [
          { title: '生成物品配置', providerId: 'SwapProv', model: 'swap-model-b' },
        ],
        layout: false,
      });
      log('canvas model swap=' + (genN.providerId === 'swap_prov' && genN.model === 'swap-model-b' && rModel && rModel.ok));
      const rModelBad = await applyCanvasOp('edit', {
        update: [{ title: '生成物品配置', providerId: 'no-such-provider', model: 'x' }],
        layout: false,
      });
      log('canvas model badProv warn=' + (!!(rModelBad && rModelBad.warnings && rModelBad.warnings.some((w) => String(w).indexOf('找不到服务商') >= 0))) + ' kept=' + (genN.providerId === 'swap_prov'));
      addNode('agent_task', 100, 3600);
      const agM = S.wf.nodes[S.wf.nodes.length - 1];
      agM.title = '模型任务';
      agM.provider = 'deepseek-official';
      agM.model = 'deepseek-v4-flash';
      const rAg = await applyCanvasOp('edit', {
        update: [{ title: '模型任务', provider: 'deepseek-official', model: 'deepseek-v4-pro' }],
        layout: false,
      });
      log('canvas agent model=' + (agM.model === 'deepseek-v4-pro' && rAg && rAg.ok));
      const colsOk = genN && reqN && saveN && genN.x > reqN.x && saveN.x > genN.x;
      log('canvas edit ok=' + (rCanvas && rCanvas.ok) + ' +nodes=' + (afterN - beforeN) + ' +wires=' + (afterW - beforeW));
      log('canvas titles=' + !!(reqN && fmtN && genN && saveN) + ' refs=' + !!genRefs + ' wired=' + !!wired);
      log('canvas layout noOverlap=' + !overlap + ' leftToRight=' + !!colsOk + ' grouped=' + !!(gItem && gItem.nodeIds.length === 4));
      log('canvas savePath=' + (saveN && saveN.savePath) + ' auto=' + !!(saveN && saveN.auto));
      const snap = applyCanvasOp('get', {});
      log('canvas get nodes>=4=' + (snap.nodes && snap.nodes.length >= 4) + ' kinds=' + (snap.kinds && snap.kinds.length));
      const blocked = applyCanvasOp('edit', {
        create: [{ alias: 'loop', kind: 'input_text', title: '回路测试' }],
        connect: [{ from: '生成物品配置', to: '物品需求' }],
        layout: false,
      });
      log('canvas cycle blocked=' + ((blocked.warnings || []).some((w) => String(w).indexOf('回路') >= 0)));
      ensureAgentToolPresets();
      const tp = agentToolActivePreset();
      const prevDraw = tp.allow.canvas_draw;
      tp.allow.canvas_draw = false;
      let drawDenied = false;
      try {
        await applyCanvasOp('edit', {
          createMarks: [{ alias: 'mdeny', kind: 'box', x: 10, y: 10, w: 40, h: 20 }],
          layout: false,
        });
      } catch (e) {
        drawDenied = String((e && e.message) || e).indexOf('不允许') >= 0;
      }
      tp.allow.canvas_draw = prevDraw;
      const prevRead = tp.allow.canvas_read;
      tp.allow.canvas_read = false;
      let getDenied = false;
      try {
        await applyCanvasOp('get', {});
      } catch (e) {
        getDenied = String((e && e.message) || e).indexOf('不允许') >= 0;
      }
      tp.allow.canvas_read = prevRead;
      log('agent tool deny draw=' + drawDenied + ' get=' + getDenied);

      window.__chatId = ch.id;
      window.__procId = la.id;
      return 'DONE';
    })()`;
    setTimeout(() => {
      win.webContents.executeJavaScript(script)
        .then((r) => console.log('[smoke-result]', r))
        .catch((e) => console.log('[smoke-err]', e.stack || e.message))
        .then(async () => {
          /* 真实输入事件拖线测试（走完整命中测试管线） */
          try {
            const ids = await win.webContents.executeJavaScript(`(() => {
              const nc = nodeById(window.__chatId);
              nc.x = 100; nc.y = 300;
              const np = nodeById(window.__procId);
              np.x = 600; np.y = 300;
              renderCanvas();
              return [window.__chatId, window.__procId];
            })()`);
            console.log('[real-drag nodes] ' + JSON.stringify(ids));
            await win.webContents.executeJavaScript(`window.__lastDown = null; window.addEventListener('mousedown', (ev) => { window.__lastDown = { x: ev.clientX, y: ev.clientY, target: ev.target.className + '|' + ev.target.tagName }; }, true);`);
            for (const id of ids) {
              const pt = await win.webContents.executeJavaScript(`(() => {
                const n = nodeById(${JSON.stringify(id)});
                S.cam = { x: 320 - n.x, y: 320 - (n.y + n.h / 2), z: 1 };
                applyTransform();
                const p = document.querySelector('.wf-node[data-nid="' + n.id + '"] .port.out');
                const r = p.getBoundingClientRect();
                return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
              })()`);
              win.webContents.sendInputEvent({ type: 'mouseDown', x: Math.round(pt.x), y: Math.round(pt.y), button: 'left', clickCount: 1 });
              await new Promise((r2) => setTimeout(r2, 60));
              const down = await win.webContents.executeJavaScript(`window.__lastDown`);
              win.webContents.sendInputEvent({ type: 'mouseMove', x: Math.round(pt.x) + 250, y: Math.round(pt.y) + 100 });
              await new Promise((r2) => setTimeout(r2, 120));
              const st = await win.webContents.executeJavaScript(`(() => {
                const t = document.querySelector('#wireTemp');
                return { d: t ? (t.getAttribute('d') || '').length : -1, vis: t ? getComputedStyle(t).display !== 'none' : false, drag: S.drag ? S.drag.mode : 'none' };
              })()`);
              win.webContents.sendInputEvent({ type: 'mouseUp', x: Math.round(pt.x) + 250, y: Math.round(pt.y) + 100, button: 'left', clickCount: 1 });
              console.log('[real-drag ' + id.slice(-6) + '] down=' + JSON.stringify(down) + ' then ' + JSON.stringify(st));
            }
            /* 右键删除连线（真实输入） */
            const wireInfo = await win.webContents.executeJavaScript(`(() => {
              const w = S.wf.wires[0];
              const from = nodeById(w.from);
              S.cam = { x: 320 - from.x, y: 320 - from.y, z: 1 };
              applyTransform();
              const path = document.querySelector('#wire-' + w.id);
              const pt = path.getPointAtLength(path.getTotalLength() / 2);
              const cr = $('#canvas').getBoundingClientRect();
              return { x: cr.left + S.cam.x + pt.x * S.cam.z, y: cr.top + S.cam.y + pt.y * S.cam.z, count: S.wf.wires.length };
            })()`);
            win.webContents.sendInputEvent({ type: 'mouseDown', x: Math.round(wireInfo.x), y: Math.round(wireInfo.y), button: 'right', clickCount: 1 });
            win.webContents.sendInputEvent({ type: 'mouseUp', x: Math.round(wireInfo.x), y: Math.round(wireInfo.y), button: 'right', clickCount: 1 });
            await new Promise((r2) => setTimeout(r2, 150));
            const wireMenu = await win.webContents.executeJavaScript(`$('#ctx').style.display + '|' + $('#ctx').textContent`);
            await win.webContents.executeJavaScript(`(() => {
              const btn = [...document.querySelectorAll('#ctx button')].find((b) => b.textContent.indexOf('删除连线') >= 0);
              if (btn) btn.click();
            })()`);
            await new Promise((r2) => setTimeout(r2, 150));
            const wiresAfter = await win.webContents.executeJavaScript(`S.wf.wires.length`);
            console.log('[wire-ctx] menu=' + JSON.stringify(wireMenu.slice(0, 60)) + ' deleted=' + (wiresAfter === wireInfo.count - 1));
            /* 连线在负坐标（画布上方）不被裁剪 */
            const procId0 = await win.webContents.executeJavaScript('window.__procId');
            const svgOv = await win.webContents.executeJavaScript(`(() => {
              const a = nodeById(${JSON.stringify(procId0)});
              const w0 = S.wf.wires.find((x) => x.from === a.id || x.to === a.id);
              const other = nodeById(w0.from === a.id ? w0.to : w0.from);
              a.x = -600; a.y = -600;
              other.x = 200; other.y = 200;
              renderCanvas();
              const p = document.querySelector('#wire-' + w0.id);
              const bb = p.getBBox();
              const ov = getComputedStyle(document.querySelector('#wfSvg')).overflow;
              return { bbY: bb.y, ov };
            })()`);
            console.log('[svg-clip] overflow=' + svgOv.ov + ' wireBBoxY=' + svgOv.bbY.toFixed(0) + ' notClipped=' + (svgOv.bbY < 0));
            /* 右键节点无效果；右键端子切断连线（直接派发 contextmenu 到目标元素） */
            const procId = await win.webContents.executeJavaScript('window.__procId');
            const rcState = await win.webContents.executeJavaScript(`(() => {
              const n = nodeById(${JSON.stringify(procId)});
              const el = document.querySelector('.wf-node[data-nid="' + n.id + '"]');
              const beforeOut = S.wf.wires.filter((w) => w.from === n.id).length;
              const beforeIn = S.wf.wires.filter((w) => w.to === n.id).length;
              const fire = (p, x, y) => p.dispatchEvent(new MouseEvent('contextmenu', { clientX: x, clientY: y, bubbles: true }));
              el.dispatchEvent(new MouseEvent('contextmenu', { clientX: 50, clientY: 50, bubbles: true }));
              const menuNone = $('#ctx').style.display === 'none';
              fire(el.querySelector('.port.out'), 80, 80);
              const afterOut = S.wf.wires.filter((w) => w.from === n.id).length;
              fire(el.querySelector('.port.in'), 80, 80);
              const afterIn = S.wf.wires.filter((w) => w.to === n.id).length;
              return { beforeOut, beforeIn, afterOut, afterIn, menuNone };
            })()`);
            console.log('[rc-behavior] nodeMenu=none=' + rcState.menuNone + ' outCut=' + (rcState.afterOut === 0) + ' inCut=' + (rcState.afterIn === 0) + ' (before out=' + rcState.beforeOut + ' in=' + rcState.beforeIn + ')');
          } catch (e) { console.log('[real-drag err]', e.message); }
        })
        .finally(() => {
          setTimeout(() => {
            try { fs.unlinkSync('C:/Users/shaom/AppData/Local/Temp/opencode/pcl_batch_产品A.yaml'); } catch {}
            try { fs.unlinkSync('C:/Users/shaom/AppData/Local/Temp/opencode/pcl_batch_产品B.yaml'); } catch {}
            try { fs.unlinkSync('C:/Users/shaom/AppData/Local/Temp/opencode/pcl_agg.yaml'); } catch {}
            const dataRoot = path.join(app.getPath('userData'), 'pipeline-console');
            const walk = (dir, out) => {
              if (!fs.existsSync(dir)) return out;
              for (const f of fs.readdirSync(dir)) {
                const p = path.join(dir, f);
                try {
                  if (fs.statSync(p).isDirectory()) walk(p, out);
                  else if (f.endsWith('.gif')) out.push(p);
                } catch {}
              }
              return out;
            };
            const gifs = walk(path.join(dataRoot, 'assets'), []);
            let gifOk = false, transpOk = false;
            if (gifs.length) {
              const buf = fs.readFileSync(gifs[gifs.length - 1]);
              gifOk = buf.slice(0, 6).toString() === 'GIF89a';
              const info = decodeGif(buf);
              transpOk = info && info.transparentIndex >= 0 && info.frames.some((f) => f.index.includes(info.transparentIndex));
            }
            console.log('[gif-check] ok=' + gifOk + ' count=' + gifs.length + ' transparent=' + transpOk);
            app.exit(0);
          }, 300);
        });
    }, 2000);
  }, 600);
  });
});
