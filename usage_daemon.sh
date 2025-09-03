#!/usr/bin/env bash
set -euo pipefail
LOG=/var/log/xray/access.log
DB=/etc/xray/users.json
STATE=/var/lib/xtool
SQLITE=/var/lib/xtool/usage.sqlite
mkdir -p "$STATE"

init_db() { sqlite3 "$SQLITE" "CREATE TABLE IF NOT EXISTS usage(user TEXT PRIMARY KEY, bytes INTEGER DEFAULT 0);"; }
add_bytes() { local email="$1" bytes="$2"; sqlite3 "$SQLITE" "INSERT INTO usage(user,bytes) VALUES('$email',$bytes) ON CONFLICT(user) DO UPDATE SET bytes = bytes + $bytes;"; }
get_bytes() { sqlite3 "$SQLITE" "SELECT IFNULL(bytes,0) FROM usage WHERE user='$1';"; }
mark_ip() { echo "$3 $2" >>"$STATE/ip.$(echo "$1" | tr '@' '_')"; }
unique_ip_count() { local f="$STATE/ip.$(echo "$1" | tr '@' '_')"; [[ ! -f "$f" ]]&&echo 0&&return; awk -v now=$(date +%s) '{ if (now - $1 <= 600) print $2 }' "$f" | sort -u | wc -l; }
json_update_used() { local email="$1" used="$2"; jq "(.users[] | select(.email==\"$email\")).used_bytes = $used" "$DB" | sponge "$DB"; }
disable_if_needed() {
  local email="$1" used="$2"
  local quota_gb=$(jq -r ".users[] | select(.email==\"$email\").quota_gb" "$DB")
  local ip_limit=$(jq -r ".users[] | select(.email==\"$email\").ip_limit" "$DB")
  [[ "$quota_gb" == "null" || -z "$quota_gb" ]] && quota_gb=0
  [[ "$ip_limit" == "null" || -z "$ip_limit" ]] && ip_limit=0
  local quota_bytes=$(( quota_gb * 1024 * 1024 * 1024 ))
  local ipcnt=$(unique_ip_count "$email")
  if (( quota_gb>0 && used >= quota_bytes )) || (( ip_limit>0 && ipcnt > ip_limit )); then
    /usr/bin/xuser disable "$email" || true
  fi
}

init_db
touch "$LOG"

# seed existing lines
awk '{print}' "$LOG" | while read -r line; do
  email=$(echo "$line" | sed -n 's/.*email:\([^ ]*\).*/\1/p'); [[ -z "$email" ]] && continue
  ip=$(echo "$line" | sed -n 's/.*from \([^: ]*\).*/\1/p')
  down=$(echo "$line" | sed -n 's/.*downlink:\([0-9]*\).*/\1/p')
  up=$(echo "$line" | sed -n 's/.*uplink:\([0-9]*\).*/\1/p')
  bytes=$(( ${down:-0} + ${up:-0} ))
  [[ -n "$ip" ]] && mark_ip "$email" "$ip" "$(date +%s)"
  if (( bytes > 0 )); then
    add_bytes "$email" "$bytes"; used=$(get_bytes "$email")
    json_update_used "$email" "$used"; disable_if_needed "$email" "$used"
  fi
done &

# live tail
( tail -F "$LOG" 2>/dev/null ) | while read -r line; do
  email=$(echo "$line" | sed -n 's/.*email:\([^ ]*\).*/\1/p'); [[ -z "$email" ]] && continue
  ip=$(echo "$line" | sed -n 's/.*from \([^: ]*\).*/\1/p')
  down=$(echo "$line" | sed -n 's/.*downlink:\([0-9]*\).*/\1/p')
  up=$(echo "$line" | sed -n 's/.*uplink:\([0-9]*\).*/\1/p')
  bytes=$(( ${down:-0} + ${up:-0} ))
  [[ -n "$ip" ]] && mark_ip "$email" "$ip" "$(date +%s)"
  if (( bytes > 0 )); then
    add_bytes "$email" "$bytes"; used=$(get_bytes "$email")
    json_update_used "$email" "$used"; disable_if_needed "$email" "$used"
  fi
done