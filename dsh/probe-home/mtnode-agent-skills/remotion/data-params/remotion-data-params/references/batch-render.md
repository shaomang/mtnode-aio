# 批量出片：一张表 → N 条视频

## 1. 数据表格式

`data/batch.csv`（UTF-8，首行表头，字段名与 zod schema 完全一致）：

```csv
slug,title,accent,locale,heroImage
acme-q4,ACME 2026 Q4 增长复盘,#22D3EE,zh,shots/acme-q4.png
acme-q3,ACME 2026 Q3 增长复盘,#7C3AED,zh,shots/acme-q3.png
beta-en,Beta launch recap,#E8A33D,en,shots/beta.png
```

- `slug` 必填且唯一：既是文件名主键，也是断点续跑的依据。
- 数组/嵌套字段不要塞进 CSV（逗号地狱）→ 用 JSON 行表（`.jsonl`），或 CSV 里放 `public/` 下的 JSON 路径。
- 数字列不要带千分位；布尔用 `true` / `false`。

## 2. CSV → props/*.json

```js
// scripts/table-to-props.mjs
// 用法: node scripts/table-to-props.mjs data/batch.csv props/
import fs from "node:fs";
import path from "node:path";

const [, , csvPath, outDir] = process.argv;
if (!csvPath || !outDir) {
  console.error("用法: node scripts/table-to-props.mjs <csv> <outDir>");
  process.exit(1);
}

const lines = fs.readFileSync(csvPath, "utf8").trim().split(/\r?\n/);
const header = lines[0].split(",").map((s) => s.trim());

const cast = (v) => {
  if (v === "true") return true;
  if (v === "false") return false;
  if (v !== "" && !Number.isNaN(Number(v))) return Number(v);
  return v;
};

fs.mkdirSync(outDir, { recursive: true });
const manifest = [];

for (const line of lines.slice(1)) {
  const cells = line.split(",").map((s) => s.trim());
  const row = Object.fromEntries(header.map((h, i) => [h, cast(cells[i] ?? "")]));
  if (!row.slug) {
    console.error("跳过一行：缺 slug", line);
    continue;
  }
  const file = path.join(outDir, `${row.slug}.json`);
  delete row.slug;
  fs.writeFileSync(file, JSON.stringify(row, null, 2), "utf8");
  manifest.push(row);
}

fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
console.log(`生成 ${manifest.length} 份 props → ${outDir}`);
```

字段里有逗号（文案常带）时换 `.jsonl`，别试图手写 CSV 转义。

## 3. 批量渲染（bundle 一次 + 并发池 + 断点续跑）

```js
// scripts/render-batch.mjs
// 用法: node scripts/render-batch.mjs props/ out/ --concurrency=3 [--force]
import fs from "node:fs";
import path from "node:path";
import { bundle } from "@remotion/bundler";
import { renderMedia, selectComposition, openBrowser } from "@remotion/renderer";

const args = process.argv.slice(2);
const propsDir = args[0] ?? "props";
const outDir = args[1] ?? "out";
const concurrency = Number((args.find((a) => a.startsWith("--concurrency=")) ?? "--concurrency=3").split("=")[1]);
const force = args.includes("--force");

const ENTRY = path.resolve("src/index.ts");
const COMPOSITION_ID = "Main";
const CODEC = "h264";
const CRF = 18;

const files = fs
  .readdirSync(propsDir)
  .filter((f) => f.endsWith(".json") && f !== "manifest.json")
  .map((f) => path.join(propsDir, f));

if (!files.length) {
  console.error(`没有找到 props：${propsDir}`);
  process.exit(1);
}

fs.mkdirSync(outDir, { recursive: true });

console.log("打包中（只做一次）…");
const serveUrl = await bundle({ entryPoint: ENTRY });
console.log("打包完成:", serveUrl);

const report = [];
const queue = [...files];
let index = 0;

const renderOne = async (propsFile) => {
  const slug = path.basename(propsFile, ".json");
  const outputLocation = path.resolve(outDir, `${slug}.mp4`);
  const started = Date.now();

  if (!force && fs.existsSync(outputLocation)) {
    console.log(`跳过（已存在）: ${slug}`);
    return { slug, status: "skipped", outputLocation };
  }

  const inputProps = JSON.parse(fs.readFileSync(propsFile, "utf8"));

  let lastError = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const composition = await selectComposition({ serveUrl, id: COMPOSITION_ID, inputProps });
      await renderMedia({
        composition,
        serveUrl,
        codec: CODEC,
        crf: CRF,
        outputLocation,
        inputProps,
        overwrite: true,
        concurrency,
        onProgress: ({ progress }) => {
          process.stdout.write(`\r${slug} ${(progress * 100).toFixed(0)}%   `);
        },
      });
      process.stdout.write("\n");
      console.log(`完成: ${slug} → ${outputLocation}`);
      return {
        slug,
        status: "ok",
        outputLocation,
        bytes: fs.statSync(outputLocation).size,
        seconds: Math.round((Date.now() - started) / 1000),
      };
    } catch (err) {
      lastError = err;
      console.error(`\n失败 (第 ${attempt} 次): ${slug}\n${err?.message ?? err}`);
    }
  }
  return { slug, status: "failed", error: String(lastError?.message ?? lastError) };
};

// 并发池：同时跑 concurrency 条
const worker = async () => {
  while (index < queue.length) {
    const propsFile = queue[index++];
    report.push(await renderOne(propsFile));
  }
};

await Promise.all(Array.from({ length: concurrency }, worker));

fs.writeFileSync(path.resolve(outDir, "batch-report.json"), JSON.stringify(report, null, 2), "utf8");

const ok = report.filter((r) => r.status === "ok").length;
const skipped = report.filter((r) => r.status === "skipped").length;
const failed = report.filter((r) => r.status === "failed");

console.log(`\n总计 ${report.length}：成功 ${ok}，跳过 ${skipped}，失败 ${failed.length}`);
if (failed.length) {
  failed.forEach((f) => console.error(` - ${f.slug}: ${f.error}`));
  process.exit(1);
}
```

```bash
# 先渲一条验证版式
node scripts/render-batch.mjs props/ out/ --concurrency=1 --force
# 抽查通过后再放量
node scripts/render-batch.mjs props/ out/ --concurrency=3
# 只重做出错的那几条：把失败清单放进 props-retry/
```

## 4. 并发与内存的实测口径

| 机器 | 建议 `concurrency` | 说明 |
| --- | --- | --- |
| 8 核 / 16GB，1080p | 2–3 | 每条渲染进程内部还有多实例，别按核数顶满 |
| 16 核 / 32GB，1080p | 4 | 再高收益递减，内存先崩 |
| 4K | 1–2 | 4K 单条内存约为 1080p 的 3–4 倍 |
| 有大量 `blur` / 多层叠加 | 降一档 | GPU 合成压力大，容易 `Target closed` |

- 批量脚本的 `concurrency` 是"同时几条视频"，`renderMedia` 的 `concurrency` 是"一条视频内几个标签页"，两者相乘才是真实压力。
- 每渲 20 条重启一次浏览器可显著降低 `Target closed`：`await openBrowser("chrome"); ...` 前先让旧实例被回收（或把批量拆成多批跑）。
- 输出目录与 props 目录都放磁盘（不要放网络盘），并预留 每条视频 50–300MB 的空间。

## 5. 批量前的 schema 校验（强烈建议）

```js
// scripts/validate-props.mjs
import fs from "node:fs";
import path from "node:path";
import { MainSchema } from "../src/schema.ts"; // 用 tsx / ts-node 运行；或复制一份 zod 定义到脚本里

const dir = process.argv[2] ?? "props";
let bad = 0;
for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".json") && x !== "manifest.json")) {
  const data = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
  const r = MainSchema.safeParse(data);
  if (!r.success) {
    bad++;
    console.error(`✗ ${f}\n${r.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n")}`);
  }
}
console.log(bad ? `有 ${bad} 份不合格` : "全部通过");
process.exit(bad ? 1 : 0);
```

校验放在渲染前：宁可在第 0 秒报"缺 `title`"，也不要在第 40 条渲到一半才发现。

## 6. 抽检清单（放量后）

- [ ] 随机抽 ≥3 条，抽首帧/中段/末帧各一张 PNG，看文字有没有溢出安全区
- [ ] 最长标题与最短标题各一条（版式的上下界最容易崩）
- [ ] 数字类字段用最大值跑一条（位数变化会撑破布局）
- [ ] 时长与数据一致（末条字幕不被切）
- [ ] `batch-report.json` 里 `bytes` 都在合理区间（异常小 = 黑屏）
- [ ] 输出文件名与表格里的 `slug` 一一对应，无覆盖
