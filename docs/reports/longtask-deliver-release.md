# 长周期任务 · 交付未交齐放行（本轮需求收尾报告）

> 本会话是开发节点（模块）nmtghmy2rd7h 绑定的开发会话：**不读也不改画布**，收尾不写回画布节点的
> title / note / devStatus / devFiles。下面按「概述（note）/ 状态（devStatus）/ 核心文件列表（devFiles）」
> 三段式留档在项目根，供画布侧按需回填。

## 一、概述（note）

【功能】长周期任务允许在交付物**没全部提交**时继续，但提醒用户，并且允许用户在提交时输入补充信息
（为什么有些未交付、哪些需要额外交付）。条带交付卡点「确认交付完成」不再被硬拦：先弹确认窗，
逐条列出没交的条目（「没交」/「没定下文件名（含后缀）」）并给一格**交付说明**；「继续任务」= 放行，
「返回补齐」= 不提交、说明留草稿。一件都没交也允许继续，说明可以留空（空说明显式记成「（未填说明）」）。
放行逐轮留痕三处同源：共享状态键 `deliver_note` / `deliver_missing`（下游 Agent 提示词里的
【交付放行】段读它）、run 的逐轮归档、交付目录的 `manifest.json` 的 `releases` 与《交付清单.md》的
「未交付说明」段；清单里放行过的条目标「未交付·已放行」，交付节点板身挂放行横幅。
下游只对**交付环节之后、同一命名空间**的环节注入，并要求「缺件影响后续就标需人工，别硬跑」。
改动只落在长任务状态机与它自己建的 `kind=deliver` 交付节点上，其余画布节点与连线一律没动。

【实现】`renderer/app-longtask.js`：新增 `ltItemsUseful / ltReleaseMissingItems / ltReleaseMissingText /
ltReleaseRecs / ltReleasesOf / ltSegBase / ltPathAfter / ltReleasesForPath`（判据与排版唯一真源），
`ltHumanResolve` 的 deliver 分支删掉两个 `return {ok:false}` 硬拦截、改为记状态键 + 逐轮归档
（`st.deliverReleases`，上限 20 轮）+ 交付目录写入带 `release`，`ltAgentPrompt` 注入【交付放行】段，
`ltDeliverEnsure/ltDeliverWrite/ltDeliverSyncFromNode/ltRebindDeliverNodes` 透传与读回放行记录；
`renderer/app-longtask-ui.js`：新增确认窗 `ltHumanReleaseDialog` + `ltReleaseRecText`/`ltReleaseRecs`，
卡片改成永远可点 + 未交提醒 + 已放行轮次，清单行标签加「未交付·已放行」，板身加放行横幅，文案口径从
「全交齐才能确认交付」改成「没交齐也能继续（缺文件名先补名）」；`longtask-store.js`：`normRelease` +
`manifest.releases` 逐轮追加 + `deliverMarkdown` 的「未交付说明」段与「未交付·已放行」状态列；
`renderer/css/longtask.css` 与 `renderer/i18n.js` 同步样式与中英词条；
`guides/manual/longtask.md`、`guides/nodes/deliver.md` 改口径；
新增 `test/smoke-longtask-release.js`（99 项，真跑 vm 沙箱 + 真加载 longtask-store 写盘读回）。

## 二、状态（devStatus）

`done`

## 三、核心文件列表（devFiles）

- `renderer/app-longtask.js`
- `renderer/app-longtask-ui.js`
- `longtask-store.js`
- `renderer/css/longtask.css`
- `renderer/i18n.js`
- `test/smoke-longtask-release.js`
- `guides/manual/longtask.md`
- `guides/nodes/deliver.md`

## 四、验证

| 测试 | 结果 |
| --- | --- |
| `test/smoke-longtask-release.js`（本轮新增：判据 / 下游归属 / manifest 与 md 落盘读回 / 接线） | ✅ 99 项全部通过 |
| `test/smoke-longtask.js`（本模块主冒烟；3 条旧断言按新口径改写） | ✅ 786 项全部通过 |
| `test/smoke-longtask-create.js` / `-edit.js` / `-output.js` / `-artifacts.js` | ✅ 全绿（未受影响） |
| `node --check`（两个渲染层脚本 + longtask-store.js + i18n.js） | ✅ exit 0 |

跑法（纯 Node，无 Electron）：`node test/smoke-longtask-release.js`。

其余套件里与本模块无关的既有红灯（`smoke-file-node` / `smoke-image-mask-edit` / `smoke-ratio-lock` /
`smoke-session-canvas` / `smoke-rel-layout` 及缺 `CHANGELOG-v1.1.md` 的 `smoke-dev-suggest`）在本轮改动之前
就存在，失败对象都不在本轮改动面内（见 `docs/reports/longtask-regression-verification.md` 的归属方法）。