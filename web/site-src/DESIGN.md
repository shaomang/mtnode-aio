---
name: MTNode AI编排器
description: 把复杂 AI 工作收束于一张可视化画布的 Windows 桌面应用——官网视觉系统
colors:
  primary: "#ff8f2e"
  primary-soft: "#ffb066"
  signal-read: "#38d6ff"
  signal-read-soft: "#7ce8ff"
  signal-run: "#5fd68a"
  signal-target: "#ffd166"
  signal-fail: "#ff5f56"
  surface-base: "#151517"
  surface-raised: "#1b1b1c"
  surface-raised-2: "#232324"
  line: "#2a2a2d"
  line-strong: "#3a3a3e"
  ink: "#ebedf2"
  ink-muted: "#818590"
  code-surface: "#1b1b1c"
  download-panel: "#221a12"
  download-panel-deep: "#171310"
  button-face: "#3a2a18"
  button-face-deep: "#241a0f"
typography:
  display:
    fontFamily: "'Segoe UI', 'PingFang SC', 'Microsoft YaHei', system-ui, sans-serif"
    fontSize: "30px"
    fontWeight: 800
    lineHeight: 1.3
    letterSpacing: "4px"
  headline:
    fontFamily: "'Segoe UI', 'PingFang SC', 'Microsoft YaHei', system-ui, sans-serif"
    fontSize: "17px"
    fontWeight: 600
    lineHeight: 1.5
    letterSpacing: "3px"
  title:
    fontFamily: "'Segoe UI', 'PingFang SC', 'Microsoft YaHei', system-ui, sans-serif"
    fontSize: "14px"
    fontWeight: 700
    lineHeight: 1.5
    letterSpacing: "1px"
  lead:
    fontFamily: "'Segoe UI', 'PingFang SC', 'Microsoft YaHei', system-ui, sans-serif"
    fontSize: "15px"
    fontWeight: 400
    lineHeight: 1.8
  body:
    fontFamily: "'Segoe UI', 'PingFang SC', 'Microsoft YaHei', system-ui, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.8
  label:
    fontFamily: "'Cascadia Code', 'Consolas', 'JetBrains Mono', monospace"
    fontSize: "11px"
    fontWeight: 400
    lineHeight: 1.4
    letterSpacing: "1px"
rounded:
  sm: "3px"
  md: "5px"
  lg: "6px"
  pill: "999px"
spacing:
  "3xs": "8px"
  "2xs": "10px"
  xs: "12px"
  sm: "14px"
  md: "16px"
  lg: "22px"
  xl: "28px"
  "2xl": "44px"
components:
  button-primary:
    backgroundColor: "{colors.button-face-deep}"
    textColor: "{colors.primary-soft}"
    rounded: "{rounded.sm}"
    padding: "9px 20px"
    typography: "{typography.title}"
  button-primary-hero:
    backgroundColor: "{colors.button-face-deep}"
    textColor: "{colors.primary-soft}"
    rounded: "{rounded.sm}"
    padding: "10px 22px"
    typography: "{typography.body}"
  button-ghost:
    backgroundColor: "{colors.surface-raised}"
    textColor: "{colors.ink}"
    rounded: "{rounded.sm}"
    padding: "9px 20px"
    typography: "{typography.title}"
  pill:
    backgroundColor: "{colors.surface-base}"
    textColor: "{colors.signal-read-soft}"
    rounded: "{rounded.sm}"
    padding: "2px 9px"
    typography: "{typography.label}"
  card:
    backgroundColor: "{colors.surface-raised}"
    textColor: "{colors.ink}"
    rounded: "{rounded.md}"
    padding: "14px 16px"
  download-item:
    backgroundColor: "{colors.surface-base}"
    textColor: "{colors.ink}"
    rounded: "{rounded.md}"
    padding: "16px 18px"
---

# Design System: MTNode AI编排器

## Overview

**Creative North Star: "控制台纸面"（The Console Sheet）**

这不是一个营销网站，而是一张**被摊平的控制台**。用户第一次打开桌面应用看到的那套深底、细线、等宽标注、近乎直角的界面语言，被原样搬到网页上——因为官网的活是让人相信「这东西是给每天干活的人用的」，而不是让人相信「这东西很潮」。

整套视觉的第一个决定是**拒绝讨好**：底色是极暗的近黑（`#151517`），面板只比底亮一档（`#1b1b1c`），边线是能被看见但不刺眼的灰（`#2a2a2d`）。层次不靠阴影、不靠圆角、不靠留白堆砌，靠**一档一档的底色**和**一根一根的线**。这是工具软件的语言，也是这套系统最不容易被误抄的部分。

第二个决定是**颜色只用来指示动作**。橙不是「品牌色慢慢铺开」，橙是「改」；青不是「科技感渐变」，青是「读」；绿是「跑」，黄是「落在哪儿」，红是「失败」。这是从应用源码注释里逐字读出来的硬规则（`base.css:17`），不是配色品味。所以整套系统**几乎没有大面积色块**——最亮的那块橙色出现在下载区的外框（1.5px）和主按钮的边框（2px）上，面积很小、位置很准。

第三个决定是**页面是双语同构的**。中文用 4px 字距撑开标题，英文（`html[lang="en"]`）自动收紧到 1px——同一套版式承载两种书写系统，而不是给英文另做一版。

**Key Characteristics:**

- 深底 + 细线 + 近乎直角：主圆角 `3px`，容器才到 `5–6px`
- 双强调色：青承担功能标识，橙承担品牌与主动作；**黄被刻意压到最低频**
- 等宽字体当标注层用：版本号、文件名、标签、页脚都是 mono + 字距
- 有边线的容器一律**边线 + 底色**，不靠阴影浮起来
- 中文重字距、英文轻字距（`4px` → `1px`）

## Colors

一套**暗色控制台风**配色：近黑分三档做层次，五个语义色只用来指示动作，唯一的暖色（橙）留给下载动作。

### Primary

- **主橙（Signal Amber）**（`#ff8f2e`）：系统的品牌锚点与「改」的语义色。它只出现在三处：下载区外框（`1.5px`）、主按钮边框（`2px`）、`h2::before` 的 `■` 方块。**不做大面积填充、不做渐变文字。**
- **主橙浅档（Signal Amber Soft）**（`#ffb066`）：橙色文字与 hover 态的唯一合法取值。用于按钮文字、`b.hl` 高亮、FAQ 折叠标题。

### Secondary

- **读·青（Read Cyan）**（`#38d6ff`）：全站引用次数最高的语义色（应用侧 299 次）。官网上承担链接色、FAQ 前的功能标识、`.pill` 的文字色。
- **读·青浅档（Read Cyan Soft）**（`#7ce8ff`）：`code` 芯片文字、`.pill` 文字、hover 强调。

### Tertiary

- **跑·绿（Run Green）**（`#5fd68a`）：表示「正在跑 / 成功」。
- **落在哪儿·黄（Target Yellow）**（`#ffd166`）：表示「目标路径」——grep 命中的位置、文件落点。**这是全站引用次数最少的语义色（应用侧仅 28 次），刻意保持稀有。**
- **失败·红（Fail Red）**（`#ff5f56`）：表示「失败 / 危险」。

### Neutral

- **近黑底（Console Base）**（`#151517`）：页面底色。
- **抬升面（Console Raised）**（`#1b1b1c`）：卡片、面板、代码底。**与 `--bg2` 同值**——这是有意的，抬升靠边线而不是靠亮度差太大。
- **二次抬升面（Console Raised 2）**（`#232324`）：顶栏与页脚底。
- **常规线（Console Line）**（`#2a2a2d`）：卡片边线、`code` 边线、分隔。
- **强线（Console Line Strong）**（`#3a3a3e`）：需要被看见的容器边框（`.pill`、`.dl-item`、语言按钮）。
- **正文墨（Console Ink）**（`#ebedf2`）：正文与标题。**不是纯白**。
- **弱化墨（Console Muted）**（`#818590`）：说明文字、meta、页脚。
- **下载面板深档（Download Panel Deep）**（`#171310`）：下载区渐变的下端，暖黑。
- **下载面板（Download Panel）**（`#221a12`）：下载区渐变的上端，暖棕黑。**下载区是页面上唯一一块暖色底**，这是它被认出来的方式。

### Named Rules

**The Four-Verb Rule.** 青=读、橙=改、绿=跑、黄=落在哪儿、红=失败。任何示意图、节点示意、图标着色都必须落在这五个动词里；**不存在「为了好看」的第六种颜色**。

**The No-Fill Rule.** 主橙在任一屏上的覆盖面积不超过边框和文字本身。禁止橙色大色块、禁止橙色到别的颜色的渐变文字、禁止橙色发光阴影（`box-shadow` 带橙色）。

**The One Warm Surface Rule.** 整页只有下载区是暖色底（`#221a12` → `#171310`）。其他任何区块不许再出现暖色底，否则下载区就不再是唯一的地标。

**The Yellow Rarity Rule.** 黄是五种语义色里最少出现的（应用侧实测 28 次 vs 青 299 次）。黄只标路径类信息，不作装饰、不作警示（警示用红）。

## Typography

**Display Font:** Segoe UI（回落 PingFang SC / Microsoft YaHei / system-ui / sans-serif）
**Body Font:** 同 Display——**这是一套单字体族的系统**
**Label/Mono Font:** Cascadia Code（回落 Consolas / JetBrains Mono / monospace）

**Character:** 无衬线承担全部可读内容，等宽承担全部「这是机器给的值」。这个分工非常严格：**凡是用户要照着念、照着敲、照着核对的东西（版本号、文件名、尺寸、页脚），一律等宽 + 字距**；凡是叙述性文字，一律无衬线。字体族只有两个，不允许引入第三个。

### Hierarchy

- **Display**（`800`, `30px`, `line-height 1.3`, `letter-spacing 4px`）：页面主标题 `h1`。中文靠 4px 字距撑出仪式感；英文自动收到 `1px`（`html[lang="en"] h1`）；`≤760px` 降到 `24px / 2px`。
- **Headline**（`600`, `17px`, `letter-spacing 3px`）：章节标题 `h2`，前面挂一个橙色 `■ `（`12px`，`vertical-align: 1px`）。英文收到 `1px`。
- **Title**（`700`, `14px`, `letter-spacing 1px`）：卡片标题 `h3` 与按钮文字。卡片内标题字距放宽到 `2px`。
- **Lead**（`400`, `15px`, `line-height 1.8`）：首屏导语，`max-width: 760px`（**不要满宽**）。
- **Body**（`400`, `14px`, `line-height 1.8`）：正文基准，与桌面应用的 `body` 基准同值。
- **Label**（`400`, `11px`, `letter-spacing 1px`, 等宽）：`.pill` 标签、`.meta` 文件名、页脚（`11.5px`）。**这一层全部是小号 mono**，是整套系统辨识度最高的细节。**下限是 11px**（The Eleven-Pixel Floor Rule）。

### Named Rules

**The Mono-For-Machine Rule.** 版本号、文件名、路径、命令、尺寸、署名——一律等宽字体。用无衬线写 `MTNodeAIO-Setup-1.3.3.exe` 是错的。等宽在这里是**为数据与测量服务的**，不是「技术感」的道具（craft floor 明确禁止后者）。

**The Eleven-Pixel Floor Rule.** **承载信息的小字不得低于 11px**——文件名、版本号、meta、统计、页脚、标签全在内。这条规矩是硬的：Impeccable 检测器对现行页面明确报了 `undersized-ui-text`，并点名「在 DESIGN.md 的字号梯子上留个位置并不能豁免它：把 8px 加进梯子只是给问题洗了个 token」。**因此官网 `.meta` 用 `11px`（现行页面的 `10.5px` 不继承）。** 应用侧 `10.5px` 的实测记录保留在 `design-tokens.md` 里作为「应用界面的手感事实」，**官网不复刻**。

**The Tracking Budget Rule.** 宽字距只给**标题**与**短标签**。行内正文与承载信息的小字，字距压在 `0.08em` 以内。检测器对现行页面报了 4 处 `wide-tracking`（`0.10em`–`0.22em` 落在承载文字的元素上）——**新站不要重复**：`h1` 的 `4px`（在 30px 上是 `0.133em`）与 `h2` 的 `3px` 属于标题，保留；小字一律把字距收到 `0.5px`–`1px` 并且先把字号提到 11px。

**The One Family Rule.** 不引入第三个字体族。需要强调就改字重、字距、颜色，不加字体。

## Layout

**空间模型**：单列纵向流，容器 `max-width: 860px` 居中，左右 `20px` 内边距（`.wrap`）。没有多栏栅格系统——需要并排时用 flex / grid 的 `repeat(2, 1fr)`，`gap: 12px`，**在 `≤760px` 一律塌成单列**。

**节奏（全部实测）**：区块间距 `8px 0 6px`（`section`），首屏另给 `36px 0 10px`（`.hero`）；章节标题上边距 `28px`、下边距 `12px`；列表项 `5px`；页脚上方留 `44px`。间距刻度：`8 / 10 / 12 / 14 / 16 / 22 / 28 / 44`。

**下载区的空间地位**：它是页面上唯一用 `1.5px` 橙色外框 + `22px 24px` 内边距 + `0 8px 30px rgba(0,0,0,.4)` 投影的区块（`.dl-zone`）。内部两栏：`.dl-item` 用 `flex: 1 1 320px` + `gap: 16px` 排布，所以**在窄屏会自动换行而不是挤压**。

**响应式**：唯一断点是 `max-width: 760px`——隐藏导航（`.nav`）、把 `.grid` / `.shift` 塌成单列、`h1` 降到 `24px / 2px`、`.dl-zone` 内边距收到 `16px`。

**密度**：这是一套**偏密**的版式。正文行高 `1.8`（够松），但字号偏小、间距偏紧、容器偏窄（`860px` 而不是 `1200px`）。**不要靠加大留白来「提升质感」**——那是营销页的做法，会破坏控制台观感。

## Elevation & Depth

**混合，但以分层为主、阴影为辅。**

深度首先由**底色分档**表达：`#151517`（底）→ `#1b1b1c`（面）→ `#232324`（顶栏 / 页脚）。三者亮度差很小，所以层次感实际是靠**边线**（`#2a2a2d` / `#3a3a3e`）读出来的。

阴影只用于**一个地方**：应用截图（`box-shadow: 0 8px 30px rgba(0,0,0,.45)`，且**不带边线**）。普通卡片、`.pill`、`code`、**以及下载区**一律没有阴影。

这条口径直接继承自应用：`renderer/css/base.css`（1887 行）里**一共只有 4 条 `box-shadow` 声明**，全是大半径低透明纯黑扩散——没有彩色光晕，没有多层堆叠。

**⚠️ 这里对现行页面做了一处明确修正。** 现行 `web/index.html` 的 `.dl-zone` 同时用了 `1.5px` 橙色边线**和** `0 8px 30px` 宽投影，Impeccable 检测器把它报为 `gpt-thin-border-wide-shadow` 反模式，判语是「细边线配宽散投影是一眼就认得的生成式 UI 签名；**二选一，别两个都要**」。**本设计系统选择「定义明确的边缘」**：`.dl-zone` 保留 `1.5px solid var(--orange)`，**去掉投影**。带阴影的活交给那张应用截图。

### Shadow Vocabulary

- **浮层抬升**（`box-shadow: 0 8px 30px rgba(0,0,0,.45)`）：**只给应用截图**——它字面意义上就是一张贴在纸面上的图。用了它就不再给这个元素加边线。
- **对话框抬升**（`box-shadow: 0 12px 32px rgba(0,0,0,.55)`）：从应用 `.mt-dialog-box` 继承，官网上**只在真出现模态时**用。
- **选中内嵌条**（`box-shadow: inset 2px 0 0 var(--orange)`）：从应用继承的选中态语言。**注意 craft floor 禁止「卡片 / 列表项 / 提示块上大于 1px 的彩色 border-left / border-right」**——所以这条只允许出现在导航当前项或列表选中行这类**交互状态**上，不许拿来当卡片装饰。

### Named Rules

**The Flat-By-Default Rule.** 静止态一律平的。全站只有一处阴影（应用截图）。卡片、标签、代码芯片、下载区**全部是平的**。

**The Line-Not-Glow Rule.** 需要强调一个容器，就加粗它的边线并换成 `--orange`（像 `.dl-zone` 的 `1.5px`）；**不要加发光**。

**The Edge-Or-Elevation Rule.** 一个元素要么有**定义明确的边缘**（边线），要么有**柔和的抬升**（投影），**不能两者兼有**。这是对检测器那条反模式的直接回答。

**The Offset Rule.** 阴影必须带偏移和柔和模糊。零偏移的彩色光晕是装饰，不是深度（craft floor 原文口径）。

## Shapes

**形式语言：近乎直角。** 主圆角 `3px`（按钮、`code`、`.pill`、步骤序号）——小到几乎读不出来，但比 `0` 少了刀锋感。容器升到 `5px`（`.card` / `.dl-item` / `.steps li` / FAQ），最大的区块才 `6px`（`.dl-zone` / `.app-shot`）。`999px` 只留给真正的胶囊元素。

**边线宽度是分级的**，而且分级有语义：`1px`（常规卡片）、`1.5px`（下载区外框）、`2px`（主按钮、语言按钮）、`3px`（顶栏下边线、页脚上边线）。

**没有裁切、没有倾斜、没有圆形装饰、没有角落折角。**

### Named Rules

**The 3px Rule.** 交互元素（按钮、标签、代码芯片、序号）统一 `3px`。看到 `8px`、`12px`、`rounded-full` 出现在按钮上，就是抄错了系统。

**The Weight-Means-Something Rule.** 边线粗细只有四个合法值：`1px` 常规 / `1.5px` 下载区 / `2px` 主动作 / `3px` 顶栏与页脚。**不许为了「看起来更清楚」随手加粗**。

## Components

### Buttons

主按钮只有一个，就是**下载按钮**。它在页面上出现三次（首屏 CTA、下载区安装包、下载区源码包）——**同一个视觉重量，不设「次要/次要中的次要」层级**。

- **Shape:** 近乎直角（`3px`），边线 `2px`
- **Primary:** 暖色渐变面（`linear-gradient(180deg, #3a2a18, #241a0f)`）+ 橙色边线（`var(--orange)`）+ 橙浅档文字（`var(--orange2)`），内边距 `9px 20px`（首屏放大到 `10px 22px`），字号 `13px`（首屏 `14px`）、字距 `2px`、字重 `700`
- **Hover:** 文字转纯白（`#fff`）、边线转橙浅档（`var(--orange2)`），**不位移、不放大、不加阴影**
- **Secondary / Ghost:** `a.dl-btn.ghost` —— 透明底、`var(--bd2)` 边线、`var(--ink)` 文字、字重 `600`；hover 时边线与文字转青系（`var(--cyan)` / `var(--cyan2)`）
- **幂等形式**：`<a download>` 属性 —— 下载按钮就是链接，不是 JS 按钮

**唯一注意事项**：按钮的暖色渐变（`#3a2a18` → `#241a0f`）**只在按钮上出现**，不得扩散成区块底色（区块的暖色是另一组值，见 `.dl-zone`）。

### Chips（`.pill`）

- **Style:** 透明黑底（`rgba(0,0,0,.25)`）+ `1px` 强线（`var(--bd2)`）+ `3px` 圆角 + 等宽 `11px` + 字距 `1px` + 文字青浅档（`var(--cyan2)`）
- **State:** `.pill.accent` = 橙色边线 + 橙浅档文字，用于标记当轮重点（如版本号）；`.pill` 与 `.pill.accent` 共用同一套尺寸，**只有边线与文字色变**
- **用途边界**：pill 承载「事实标签」（平台、版本、引擎名），**不承载「卖点形容词」**

### Cards / Containers

- **Corner Style:** `5px`
- **Background:** `var(--panel)`（`#1b1b1c`）；`.shift-card.from` 用 `opacity: .85` 做「改造前」的弱化
- **Shadow Strategy:** **无阴影**（见 Elevation & Depth）
- **Border:** `1px solid var(--bd)`；强调变体换 `var(--orange)`
- **Internal Padding:** `14px 16px`（`.card` / `.shift-card` / `.steps li`）
- **Steps 变体**：`.steps li` 左侧用绝对定位的 `24×24px` 序号方块（`1px` 橙边 + 橙浅档等宽 `12px` 数字 + `3px` 圆角），`padding-left: 48px` 让出位置

### Inputs / Fields

**官网是静态落地页，没有输入框。** 不发明一套表单样式——等真的出现表单时再从 `renderer/css/base.css` 的输入框口径继承（那里是 `1px solid var(--bd2)` + `3px` 圆角 + `var(--code)` 底 + focus 转 `var(--orange)` 边线）。

### Navigation

- **顶栏（`.topbar`）**：`sticky`，`padding: 10px 20px`，底为 `linear-gradient(180deg, var(--panel2), var(--panel))`，下边线 `3px solid var(--bd)`
- **品牌块**：`logo-txt` 字重 `800`、字距 `2px`、`15px`、橙色。**⚠️ 现行页面在它下面挂了一行 `logo-sub`（`MTNODE AI ORCHESTRATOR`，`10px` / 字距 `3px`），本设计系统决定不再沿用**：它是 craft floor 明令禁止的「眉标 / kicker」——一行只是把标题换成英文重说一遍的小字，而且 `10px` 还破了 11px 底线（检测器已报 `undersized-ui-text`）。**品牌块只留一行。**
- **版本标签（`.ver-tag`）**：等宽 `11px`、字距 `1px`、弱化墨——**版本号必须是等宽**
- **语言按钮（`.btn-lang`）**：`36×32px` 竖排按钮，`2px` 边线，hover 转青；内部图标 `14px`、文字标签 `9px` / `800` / 等宽 / 青浅档
- **移动端**：`≤760px` 时 `.nav` 直接 `display: none`（不做汉堡菜单）

### Footer

`margin-top: 44px`、`padding: 16px 20px`、底 `var(--panel2)`、上边线 `3px solid var(--bd)`、**整体等宽** `11.5px` + 字距 `1px` + 弱化墨。署名是 `1px` 强线框 + `3px` 圆角 + 青色的可点小胶囊。

### Signature Component

**下载区（`.dl-zone`）——这套系统里唯一被允许「喊出来」的区块。**

橙色 `1.5px` 外框、`6px` 圆角、`22px 24px` 内边距、暖色渐变底（`#221a12` → `#171310`）、**无投影**（The Edge-Or-Elevation Rule）；标题用橙浅档，并**去掉 `h2::before` 的 `■` 方块**（`content: ""`）——因为在橙色外框里再加橙色方块是重复强调。

它是「首要动作 = 下载」这条产品原则在视觉上的唯一表达：**整页只有它允许用暖色底；它靠橙色外框被认出来，不靠投影。**

## Do's and Don'ts

### Do:

- **Do** 从 `renderer/css/base.css` 的 `:root` 取令牌，并把官网 CSS 写成 `var(--orange)` 这类引用——真源在应用里，官网是消费者。
- **Do** 用 `#151517` / `#1b1b1c` / `#232324` 三档近黑 + `#2a2a2d` / `#3a3a3e` 两级边线做层次。
- **Do** 把版本号、文件名、路径、页脚写成等宽（`Cascadia Code` / `Consolas` / `JetBrains Mono`），字距 `1px`。
- **Do** 中文标题给足字距（`h1` `4px` / `h2` `3px`），并在 `html[lang="en"]` 下自动收到 `1px`。
- **Do** 交互元素统一 `3px` 圆角、容器 `5px`、大区块 `6px`。
- **Do** 让下载按钮在首屏可见——它承载产品原则里唯一的首要动作。
- **Do** 用橙浅档（`#ffb066`）写橙色文字，用主橙（`#ff8f2e`）画橙色线。
- **Do** 在 `≤760px` 把并排布局塌成单列、`h1` 收到 `24px`。
- **Do** 把承载信息的小字守在 `11px` 以上——文件名、版本号、meta、页脚。
- **Do** 让每个元素**要么有边线、要么有投影**，二选一。
- **Do** 知道这套配色的对比度已经达标：实测**全部前景 / 背景配对都 ≥4.5:1**（弱化墨在抬升面上最低 `4.63:1`，正文 `14.58:1`–`15.77:1`）。所以新站不要再为了「更清楚」而擅自提亮颜色——**问题在字号和字距，不在色。**

### Don't:

- **Don't** 大面积铺橙色。主橙只出现在边线、图标方块与按钮描边上（The No-Fill Rule）。
- **Don't** 给静止态的卡片加阴影——`base.css` 1887 行里只有 4 条 `box-shadow`，全给浮层。
- **Don't** **同时**给一个元素细边线和宽投影（检测器反模式 `gpt-thin-border-wide-shadow`，现行 `.dl-zone` 与 `.app-shot` 都犯过）。
- **Don't** 把圆角放大到 `8px` 以上交给按钮、标签或代码芯片。
- **Don't** 引入第三个字体族，也不要为强调换字体。
- **Don't** 再出现第二块暖色底（The One Warm Surface Rule）。
- **Don't** 用黄做装饰或警示——黄只标「落在哪儿」（The Yellow Rarity Rule）。
- **Don't** 用无衬线写文件名和版本号（The Mono-For-Machine Rule）。
- **Don't** 让承载信息的文字掉到 `11px` 以下（`undersized-ui-text`）。`10.5px` 是应用界面的手感事实，**不是官网许可**。
- **Don't** 给承载信息的小字放宽字距（`wide-tracking`，检测器在现行页面报了 4 处）。
- **Don't** 写一个只把标题换个说法重念一遍的眉标 / kicker——craft floor 里这是**禁令**，没有 brief 能把它买回来。现行页面的 `logo-sub`「MTNODE AI ORCHESTRATOR」就是这一类。
- **Don't** 用等宽字体当「技术感」的戏服——它只用于代码、数据与测量。
- **Don't** 照抄 `base.css` 里三处没有亮色覆盖的硬编码深色值（`.app-docs-ask` 的 `#141820`、`.app-docs-ask-msg` 的 `#1a1f28`、`.app-docs-article.md img` 的 `#0d1016`）——官网一律走 `var()`。
- **Don't** 写价格、授权、开源、免费类主张，也不写「数据不出本机」（见 `PRODUCT.md` 的「明确未决 / 有意不写」）。
- **Don't** 编造客户案例、下载量、性能倍数或合规声明。
- **Don't** 用零偏移的彩色光晕假装深度，也不要用硬偏移色块影子（`4px 4px 0`）。

## Quality Floor 基线（实测，2026-09）

Impeccable 检测器对**现行** `E:\dev\tools\pipeline-console\web\index.html`（621 行）的机械扫描结果，作为新站的**反模式基线**——这些是「不要继承」的清单，不是「要修旧页面」的任务：

```bash
E:\dev\tools\pipeline-console\web\site-src\.dsh\skills\impeccable\scripts\impeccable.cmd detect E:\dev\tools\pipeline-console\web\index.html
```

| # | 规则 | 命中 | 本设计系统的处置 |
| --- | --- | --- | --- |
| 1 | `wide-tracking` | `letter-spacing: 0.13em on body text` | 收敛：字距只给标题与短标签（The Tracking Budget Rule） |
| 2 | `undersized-ui-text` | `9px functional text "MTNODE AI ORCHESTRATOR"` | **删除该元素**（眉标禁令 + 破 11px 底线） |
| 3 | `wide-tracking` | `letter-spacing: 0.22em on body text` | 同上，收敛 |
| 4 | `undersized-ui-text` | `10.5px functional text "MTNodeAIO-Setup-1.3.3.exe"` | 提到 `11px`（The Eleven-Pixel Floor Rule） |
| 5 | `wide-tracking` | `letter-spacing: 0.10em on body text` | 同上，收敛 |
| 6 | `undersized-ui-text` | `10.5px functional text "MTNodeAIO-src-1.3.3.zip · 不含 node_modules"` | 提到 `11px` |
| 7 | `wide-tracking` | `letter-spacing: 0.10em on body text` | 同上，收敛 |

**结论：7 项主发现全部集中在两件事上——小字尺寸与宽字距。配色一条都没报。** 所以改版的方向是**收紧字号与字距，而不是动颜色**。

_（Advisory，不计为失败：`gpt-thin-border-wide-shadow` ×2 —— `.dl-zone` 的 `1.5px` 边线 + `30px` 投影、`.app-shot` 的 `1px` 边线 + `30px` 投影。已由 The Edge-Or-Elevation Rule 处置：`.dl-zone` 去投影、`.app-shot` 去边线。）_

**待做**：新站有真实 UI 之后，按 Impeccable 的要求**再跑一次**检测器（`detect --json <changed targets>`），一次即可，不要在概念选择阶段跑。

---

> **待决（下一环节处理，勿自行决定）**：现行 `web/index.html` 实际使用的是 `base.css` 里的 **`body.theme-industrial`** 变体（`--bg: #0d1016`、`--panel: #161b25`、`--bd: #2a3342`、`--code: #0c0f15`），而本文件 frontmatter 按本轮任务书要求以 **`:root` 默认主题**（`#151517` / `#1b1b1c` / `#2a2a2d`）为规范值。二者**语义色完全相同，只有中性色不同**（见 `design-tokens.md` §2.1 实测对照）。改版前必须在两者之间定一个，不允许两个真源并存。