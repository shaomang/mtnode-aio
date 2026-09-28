/* test/auth-wechat-mock.mjs — 仅测试用的微信开放平台 HTTP 替身
 * ============================================================================
 * 用法（由 test/smoke-auth.js 以 node --import 注入到 store-saas/server.mjs 进程）：
 *   node --import <pathToFileURL(本文件)> store-saas/server.mjs
 *
 * 作用：把 server.mjs 的 wechatExchangeCode() 对 api.weixin.qq.com 的真实请求
 * 替换成本地确定性响应，使「微信扫码登录」全链路可在离线环境下冒烟。
 *   access_token = "at-<code>"，openid = "openid-<code>"，unionid = "unionid-<code>"
 * 因此同一个 code 永远对应同一个 unionid（= 同一账号），不同 code 即不同微信。
 * 其它 URL 一律透传给真实 fetch（本进程在测试中不会访问别的外网）。
 * ============================================================================
 */
const realFetch = globalThis.fetch;

function jsonResponse(obj) {
  return new Response(JSON.stringify(obj), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function codeOfAccessToken(at) {
  return String(at || "").replace(/^at-/, "");
}

globalThis.fetch = async function (input, init) {
  const url = String(typeof input === "string" ? input : (input && input.url) || "");
  if (url.startsWith("https://api.weixin.qq.com/sns/oauth2/access_token")) {
    const code = new URL(url).searchParams.get("code") || "x";
    return jsonResponse({
      access_token: "at-" + code,
      openid: "openid-" + code,
      unionid: "unionid-" + code,
      expires_in: 7200,
    });
  }
  if (url.startsWith("https://api.weixin.qq.com/sns/userinfo")) {
    const code = codeOfAccessToken(new URL(url).searchParams.get("access_token"));
    return jsonResponse({
      openid: "openid-" + code,
      unionid: "unionid-" + code,
      nickname: "微信测试用户" + code,
    });
  }
  return realFetch(input, init);
};
