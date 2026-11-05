#!/bin/bash
# Compatibility shim: one CodeArts lane via the supervised runner (runner/ca.mjs).
# usage: ca-lane.sh <repo-or-worktree> <task>   (reads <repo>/tasks/<task>.md)
# The old bash lane (ca-run.sh per attempt, text-log scraping) is replaced by `ca lane`:
# live transcript, watchdog, same-session resume, runner-run CHECK gates, read-only review.
exec node "$(dirname "$0")/../runner/ca.mjs" lane "$@"
