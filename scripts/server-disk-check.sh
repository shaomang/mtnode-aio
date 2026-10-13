#!/bin/bash
# MTNode weekly disk fallback check.
# Installed at /usr/local/sbin/mtnode-disk-check.sh, scheduled by
# /etc/cron.d/mtnode-disk-check every Monday 04:30 server local time.
#
# Behavior:
#   - read df for the root filesystem, compute the use percentage
#   - below MN_DISK_THRESHOLD (default 80) -> exit 0 immediately, nothing touched
#   - at/above threshold -> run the same log-side cleanup as the one-off job:
#       * journalctl --vacuum-time=2d / --vacuum-size=64M
#       * logrotate -f /etc/logrotate.d/nginx (drops old rotated files)
#       * remove /tmp upload/archive residue older than 30 days
#       * remove /root/.npm/_cacache
#   - append one summary line to /var/log/mtnode-disk-check.log
#
# Manual run:   /usr/local/sbin/mtnode-disk-check.sh
# Force run:    /usr/local/sbin/mtnode-disk-check.sh --force   (ignore threshold, still cleans)
# Print help:   /usr/local/sbin/mtnode-disk-check.sh --help
#
# Idempotent and re-installable: every step tolerates missing targets, and a
# second run in the same state changes nothing.

set -u

PROG="mtnode-disk-check"
TARGET="${MN_DISK_TARGET:-/}"
THRESHOLD="${MN_DISK_THRESHOLD:-80}"
LOG="${MN_DISK_LOG:-/var/log/mtnode-disk-check.log}"
JOURNAL_KEEP_TIME="${MN_DISK_JOURNAL_TIME:-2d}"
JOURNAL_KEEP_SIZE="${MN_DISK_JOURNAL_SIZE:-64M}"
TMP_DAYS="${MN_DISK_TMP_DAYS:-30}"
NPM_CACHE="${MN_DISK_NPM_CACHE:-/root/.npm/_cacache}"
NGINX_LOGROTATE="${MN_DISK_LOGROTATE:-/etc/logrotate.d/nginx}"

FORCE=0
for a in "$@"; do
  case "$a" in
    -h|--help) sed -n '2,26p' "$0"; exit 0 ;;
    -f|--force) FORCE=1 ;;
    *) : ;;
  esac
done

case "$THRESHOLD" in
  ''|*[!0-9]*) THRESHOLD=80 ;;
esac

log_line() {
  printf '%s %s %s\n' "$(date '+%Y-%m-%dT%H:%M:%S%z')" "$PROG" "$1" >> "$LOG" 2>/dev/null || true
}

du_h() {
  if [ -e "$1" ]; then du -sh "$1" 2>/dev/null | cut -f1; else echo "-"; fi
}

df_pct() {
  df -P "$TARGET" 2>/dev/null | awk 'NR==2 {gsub("%","",$5); print $5}'
}

df_row() {
  df -h "$TARGET" 2>/dev/null | awk 'NR==2 {print $2" "$3" "$4" "$5}'
}

PCT="$(df_pct)"

if [ -z "${PCT:-}" ]; then
  log_line "ERROR cannot read df for $TARGET (nothing done)"
  echo "$PROG: cannot read df for $TARGET"
  exit 1
fi

if [ "$FORCE" -eq 0 ] && [ "$PCT" -lt "$THRESHOLD" ]; then
  log_line "SKIP df=$TARGET used=${PCT}% threshold=${THRESHOLD}% below-threshold nothing-to-do"
  echo "$PROG: ${PCT}% < ${THRESHOLD}% - nothing to do"
  exit 0
fi

BEFORE_JOURNAL="$(du_h /var/log/journal)"
BEFORE_NGINX="$(du_h /var/log/nginx)"
BEFORE_TMP="$(du_h /tmp)"
BEFORE_NPM="$(du_h "$NPM_CACHE")"
BEFORE_DF="$(df_row)"

# 1) journald: keep 2 days / 64M
if command -v journalctl >/dev/null 2>&1; then
  journalctl --vacuum-time="$JOURNAL_KEEP_TIME" >/dev/null 2>&1
  journalctl --vacuum-size="$JOURNAL_KEEP_SIZE" >/dev/null 2>&1
fi

# 2) nginx logs: force a rotation; the rotate N directive drops the old generations
if [ -f "$NGINX_LOGROTATE" ] && command -v logrotate >/dev/null 2>&1; then
  logrotate -f "$NGINX_LOGROTATE" >/dev/null 2>&1
fi

# 3) /tmp residue older than 30 days: upload/ dist/ dirs + archive files < 200M
if [ -d /tmp ]; then
  find /tmp -xdev -depth -mindepth 1 -mtime +"$TMP_DAYS" \
       \( -type d \( -iname '*upload*' -o -iname '*dist*' \) -o \
          -type f \( -iname '*.tgz' -o -iname '*.tar.gz' -o -iname '*.zip' -o \
                     -iname '*.gz' -o -iname '*.rar' -o -iname '*.7z' -size -200M \) \) \
       -exec rm -rf -- {} + 2>/dev/null
fi

# 4) npm cache (npm rebuilds it on the next install)
if [ -d "$NPM_CACHE" ]; then
  rm -rf -- "$NPM_CACHE" 2>/dev/null
fi

AFTER_DF="$(df_row)"
NPCT="$(df_pct)"
[ -n "${NPCT:-}" ] || NPCT="$PCT"

WHAT="forced"
if [ "$FORCE" -eq 0 ]; then
  WHAT="threshold"
fi

log_line "CLEAN $WHAT used=${PCT}%->${NPCT}% df_before=[${BEFORE_DF}] df_after=[${AFTER_DF}] journal=${BEFORE_JOURNAL}->$(du_h /var/log/journal) nginx_log=${BEFORE_NGINX}->$(du_h /var/log/nginx) tmp=${BEFORE_TMP}->$(du_h /tmp) npm_cache=${BEFORE_NPM}->$(du_h "$NPM_CACHE")"
echo "$PROG: cleaned (${WHAT}) used=${PCT}%->${NPCT}%"
exit 0
