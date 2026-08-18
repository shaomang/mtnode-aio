本目录内容**不会**打进 MTNode AIO 安装包。用户通过顶栏「插件」对话框下载安装到 `%APPDATA%/pipeline-console/.../pet/runtime/`。

## P1 能力

- 全局键鼠驱动（爪击 / 视线跟随 / 键区 PNG）
- 窗口穿透、悬停隐藏、缩放、透明度、镜像
- 系统托盘 + 右键菜单
- 导入自定义形象文件夹（`cover.png` / `sprite.png` + 可选 `resources/left-keys|right-keys`）

## 结构

- `index.html` / `style.css` / `app.js` — 透明桌宠窗
- `manifest.json` — 版本与发布元数据
- `resources/left-keys|right-keys` — 默认键区叠加（可选 PNG）
- `models/` — Live2D 模型（P2+ Cubism）

## 自定义形象文件夹示例

```
my-skin/
  pet.json          # { "name": "我的猫" }
  cover.png         # 主形象
  resources/
    left-keys/A.png
    right-keys/L.png
```

## 发布

```bash
node scripts/stage-pet.mjs
# 或双击 E:\dev\tools\release-pet.cmd
```
