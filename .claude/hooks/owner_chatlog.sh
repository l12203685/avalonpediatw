#!/bin/bash
# 每輪結束，把擁有者在這個 session 親手打的話與 Claude 的回覆，寫進擁有者的私人筆記 repo。
# 寫的是私人 repo，不是這個公開 repo；這裡不會多出任何對話內容。
# 這個 session 讀不到那個私人 repo 時：第一次說一聲，之後安靜跳過，不影響工作。
D="$HOME/.siji/dit-log"
URL="https://github.com/l12203685/digital-immortal-tree-lyh.git"
MISS="$HOME/.siji/dit-log.unreachable"
input="$(cat)"
if [ ! -f "$D/scripts/siji_entry/user_hook.py" ]; then
  [ -f "$MISS" ] && exit 0
  mkdir -p "$HOME/.siji" && rm -rf "$D"
  if ! { timeout 120 git clone -q --filter=blob:none --sparse --depth 1 "$URL" "$D" \
         && git -C "$D" sparse-checkout set scripts; } >/dev/null 2>&1 \
     || [ ! -f "$D/scripts/siji_entry/user_hook.py" ]; then
    rm -rf "$D"; : > "$MISS"
    echo "[對話落檔] 這個 session 讀不到擁有者的私人筆記 repo，這裡的對話不會自動存進去。請照實告訴擁有者一次：要自動存，得把那個 repo 也掛到這個 session（要能推）。" >&2
    exit 2
  fi
fi
printf '%s' "$input" | timeout 120 python3 "$D/scripts/siji_entry/user_hook.py"
