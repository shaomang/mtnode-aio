/* 只读探针子件（非交付件）：cfg-save-cost.cjs 的「另一个进程」。
 * 只做一件事：父亲发 ping，立刻回 pong。父进程同步阻塞时 pong 会被推迟，
 * 那个推迟量就等于「同一时刻窗口里敲一下要等多久」。不读不写任何文件。 */
"use strict";
process.on("message", () => {
  try {
    process.send("pong");
  } catch {}
});
