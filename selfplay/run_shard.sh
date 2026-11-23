#!/bin/bash
# Run this shard's share of selfplay/jobs.txt (line k goes to shard k % NSHARDS), PARALLEL chunks at a time,
# and push each finished batch's compact results to branch selfplay-results under results/<RUN_ID>/.
# Chunks whose result file already exists on that branch are skipped (re-runs are idempotent).
# Usage (repo root): SHARD=0 NSHARDS=16 PARALLEL=4 RUN_ID=x RES_DIR=res bash selfplay/run_shard.sh
set -u
ROOT=$(pwd)
OUT="$RES_DIR/results/$RUN_ID"
mkdir -p "$OUT"
mapfile -t ALL < <(grep -v '^\s*#' selfplay/jobs.txt | grep -v '^\s*$')
MINE=()
for k in "${!ALL[@]}"; do
  if [ $((k % NSHARDS)) -eq "$SHARD" ]; then
    IFS='|' read -r lab fl sd from games <<< "${ALL[$k]}"
    [ -f "$OUT/${lab}_${sd}_${from}.json" ] || MINE+=("${ALL[$k]}")
  fi
done
echo "shard $SHARD/$NSHARDS: ${#MINE[@]} chunks to run (of ${#ALL[@]} total)"

push_results() {
  for attempt in 1 2 3 4 5 6 7 8 9 10; do
    git -C "$RES_DIR" add -A results >/dev/null 2>&1
    git -C "$RES_DIR" diff --cached --quiet && return 0
    git -C "$RES_DIR" commit -q -m "selfplay $RUN_ID shard $SHARD" >/dev/null 2>&1
    if git -C "$RES_DIR" push -q origin HEAD:selfplay-results >/dev/null 2>&1; then return 0; fi
    git -C "$RES_DIR" reset -q --soft HEAD~1
    git -C "$RES_DIR" stash -q -u >/dev/null 2>&1
    git -C "$RES_DIR" pull -q --rebase origin selfplay-results >/dev/null 2>&1
    git -C "$RES_DIR" stash pop -q >/dev/null 2>&1
    sleep $((RANDOM % 10 + attempt * 3))
  done
  echo "push failed after retries"; return 1
}

run_one() {
  IFS='|' read -r lab fl sd from games <<< "$1"
  local flags=""
  for x in $fl; do flags="$flags --flag $x"; done
  local tmp="$ROOT/.sp_out/${lab}_${sd}_${from}.json"
  ( cd "$ROOT/packages/server" && USE_FORWARD_REASONING=true npx tsx scripts/selfplay/sp.ts --seed "$sd" --from "$from" --games "$games" --out "$tmp" $flags ) \
    && cp "$tmp" "$OUT/" || echo "chunk ${lab}_${sd}_${from} failed"
}

mkdir -p "$ROOT/.sp_out"
i=0
while [ $i -lt ${#MINE[@]} ]; do
  for j in $(seq 0 $((PARALLEL - 1))); do
    [ $((i + j)) -lt ${#MINE[@]} ] && run_one "${MINE[$((i + j))]}" &
  done
  wait
  i=$((i + PARALLEL))
  push_results
  echo "shard $SHARD: $(( i < ${#MINE[@]} ? i : ${#MINE[@]} ))/${#MINE[@]} chunks done"
done
