#!/bin/bash
# 生产机 · 1000 条目录隔离沙箱（起 / 停 / 状态）
# 口径：绝不碰线上 /opt/mtnode-store 与其 data/；沙箱自带 DATA_DIR / 静态目录 / 端口。
# 用法：bash scale-sandbox.sh start|stop|status|seed|republish|load [参数…]
set -u
DIR=/opt/mtnode-store-sandbox
APP=$DIR/app
PORT=8791
PATTERN="node server.mjs"
LOG=$DIR/server.log

sandbox_pids() {
  ps -eo pid,args | grep -E "node server\.mjs" | grep -v grep | awk '{print $1}'
}

case "${1:-status}" in
start)
  if ss -ltn | grep -q ":$PORT "; then
    echo "[sandbox] 端口 $PORT 已被占用，先 stop"; exit 2
  fi
  cd "$APP" || exit 2
  nohup env PORT=$PORT HOST=127.0.0.1 \
    DATA_DIR=$DIR/data \
    MTNODE_APPS_WEB_DIR=$DIR/web \
    MTNODE_ACCOUNT_STORE=json \
    MTNODE_APP_VERSIONS=1 \
    MTNODE_ADMIN_USERS="${MTNODE_ADMIN_USERS:-ms2308}" \
    MTNODE_APPS_PUBLISH="${MTNODE_APPS_PUBLISH:-manual}" \
    MTNODE_MAX_ACCOUNT_APPS="${MTNODE_MAX_ACCOUNT_APPS:-5}" \
    MTNODE_MAX_ACCOUNT_APP_BYTES="${MTNODE_MAX_ACCOUNT_APP_BYTES:-209715200}" \
    node server.mjs >> "$LOG" 2>&1 &
  echo $! > $DIR/sandbox.pid
  for i in $(seq 1 40); do
    sleep 0.5
    code=$(curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:$PORT/api/apps/pub" || true)
    [ "$code" = "200" ] && { echo "[sandbox] 已启动 http://127.0.0.1:$PORT（pid $(cat $DIR/sandbox.pid)）"; exit 0; }
  done
  echo "[sandbox] 起不来，日志尾部："; tail -20 "$LOG"; exit 1
  ;;
stop)
  n=0
  for pid in $(sandbox_pids); do
    kill "$pid" 2>/dev/null && n=$((n+1))
  done
  for i in $(seq 1 20); do
    ss -ltn | grep -q ":$PORT " || break
    sleep 0.3
  done
  for pid in $(ss -ltnp 2>/dev/null | grep ":$PORT " | grep -o 'pid=[0-9]*' | cut -d= -f2); do
    kill -9 "$pid" 2>/dev/null && n=$((n+1))
  done
  rm -f $DIR/sandbox.pid
  echo "[sandbox] 已停（处理 $n 个进程）"
  ss -ltn | grep -q ":$PORT " && { echo "[sandbox] 警告：端口 $PORT 仍在监听"; exit 1; } || exit 0
  ;;
status)
  echo "== 端口 =="; ss -ltn | grep ":$PORT " || echo "(未监听)"
  echo "== 进程 =="; ps -eo pid,etime,args | grep -E "node server\.mjs" | grep -v grep || echo "(无)"
  echo "== 沙箱 vs 线上代码 =="
  md5sum "$APP/server.mjs" /opt/mtnode-store/server.mjs 2>/dev/null
  echo "== 库与热表 =="
  ls -la $DIR/data/db.json $DIR/data/*.jsonl 2>/dev/null
  echo "== 静态目录 =="
  du -sh $DIR/web 2>/dev/null; ls $DIR/web 2>/dev/null | head -5
  echo "== 体检 =="
  curl -s "http://127.0.0.1:$PORT/api/apps/pub" | head -c 600; echo
  ;;
republish)
  TOK=$(cat $DIR/admin-token.txt)
  t0=$(date +%s%3N)
  out=$(curl -s -X POST -H "authorization: Bearer $TOK" -H 'content-type: application/json' -d '{}' "http://127.0.0.1:$PORT/api/admin/content/republish")
  t1=$(date +%s%3N)
  echo "[sandbox] 全量重发墙钟 $((t1-t0))ms"
  echo "$out" | head -c 500; echo
  ;;
*)
  echo "用法：bash $0 start|stop|status|republish"
  ;;
esac
