#!/usr/bin/env bash
# Manage the Jarvis git worktrees: one long-lived worktree per track, plus short-lived task worktrees.
#   scripts/worktrees.sh init                 create business + dev track worktrees
#   scripts/worktrees.sh task <track> <name>  new task worktree branched from that track
#   scripts/worktrees.sh list | done <track> <name>
set -euo pipefail
ROOT="$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)")"
WT="${JARVIS_WORKTREES:-$ROOT/../jarvis-worktrees}"
BASE="${JARVIS_BASE:-main}"
git -C "$ROOT" rev-parse --verify -q "$BASE" >/dev/null || { echo "base branch $BASE not found (set JARVIS_BASE)"; exit 1; }
cmd="${1:-list}"; shift || true
case "$cmd" in
  init)
    mkdir -p "$WT"
    for t in business dev; do
      [ -d "$WT/$t" ] && { echo "exists: $WT/$t"; continue; }
      git -C "$ROOT" worktree add -b "track/$t" "$WT/$t" "$BASE"
    done ;;
  task)
    t="${1:?track: business|dev}"; n="${2:?task name}"
    case "$t" in business|dev) ;; *) echo "track must be business or dev"; exit 1 ;; esac
    [ -d "$WT/$t" ] || { echo "run init first"; exit 1; }
    git -C "$ROOT" worktree add -b "$t/$n" "$WT/tasks/$t-$n" "track/$t"
    echo "ready: $WT/tasks/$t-$n  (branch $t/$n)" ;;
  done)
    t="${1:?track}"; n="${2:?task name}"
    git -C "$ROOT" worktree remove "$WT/tasks/$t-$n" && echo "removed (branch $t/$n kept until merged)" ;;
  list) git -C "$ROOT" worktree list ;;
  *) echo "usage: $0 init|task <track> <name>|done <track> <name>|list"; exit 1 ;;
esac
