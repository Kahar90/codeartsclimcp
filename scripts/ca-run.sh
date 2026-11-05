#!/bin/bash
# Run one CodeArts Agent CLI session headless in the current directory.
# usage: ca-run.sh <brief-file> [model]        model e.g. huaweicloud-maas/GLM-5.1
# Prints the session output tail, then on failure one line "dsh: CODE (...)" so callers
# (ca-lane.sh, or lane.sh via agent-run.sh) can classify it. Exit 3 = missing credentials.
BRIEF_FILE=$1; MODEL=$2
[ -f "$BRIEF_FILE" ] || { echo "usage: ca-run.sh <brief-file> [model]"; exit 2; }

# AK/SK from the Windows user env (headless mode ignores the TUI browser login). Never print.
for v in CODEARTS_CLI_AK CODEARTS_CLI_SK; do
  if [ -z "${!v}" ]; then
    val=$(powershell -NoProfile -Command "[Environment]::GetEnvironmentVariable('$v','User')" | tr -d '[:cntrl:]')
    export "$v=$val"
  fi
done

CA_HOME="$USERPROFILE/.codeartsdoer"; [ -d "$CA_HOME" ] || CA_HOME="$HOME/.codeartsdoer"
# The worker's bash tool runs $SHELL. Git\usr\bin\bash.exe (raw MSYS) can hang at startup under
# codearts; the Git\bin\bash.exe launcher works. Found 2026-11-05 (every bash call hung).
GITBASH="${PROGRAMFILES:-C:\\Program Files}\\Git\\bin\\bash.exe"
[ -f "$GITBASH" ] && export SHELL="$GITBASH"
TMPDIR_=${TMP:-/tmp}
LOG=$(mktemp "$TMPDIR_/codearts-XXXXXX.log")

# Same env as installers/codearts.cmd, but call the exe directly: cmd.exe would mangle
# quotes, %, & and | in the brief.
SCENARIO=codeartsdoer KERNEL_DATA_DIR="$CA_HOME/cli-data" KERNEL_STATE_DIR="$CA_HOME/state" \
KERNEL_CONFIG_DIR="$CA_HOME" OPENCODE_CONFIG="$CA_HOME/codearts_cli.json" \
OPENCODE_CONFIG_FILE=codearts_cli.json,codearts_cli.jsonc OPENCODE_CHANNEL=latest \
PLUGIN_ENV=hc OPENCODE_DISABLE_MODELS_FETCH=1 OPENCODE_DISABLE_AUTOUPDATE=true \
CODEARTS_DISABLE_AUTO_UPDATE=true OMO_SEND_ANONYMOUS_TELEMETRY=0 \
CODEAGENT_USE_MESSAGE_FEEDBACK=false NODE_TLS_REJECT_UNAUTHORIZED=0 \
  "$CA_HOME/installers/bin/codearts.exe" run --full_access ${MODEL:+-m "$MODEL"} \
  "$(cat "$BRIEF_FILE")" < /dev/null > "$LOG" 2>&1
rc=$?

tail -c 8000 "$LOG"; echo
if grep -q "Authentication failed" "$LOG"; then          # exits 0 on this, so check text
  echo "dsh: MISSING_CREDENTIAL (set CODEARTS_CLI_AK and CODEARTS_CLI_SK in the Windows user env)"
  rm -f "$LOG"; exit 3
fi
if grep -q "Folder not trusted" "$LOG"; then
  echo "dsh: WORKER_FAILED (folder not trusted: add a parent to ~/.codeartsdoer/cli-data/settings.json security.trustedFolders)"
  rm -f "$LOG"; exit 4
fi
# Model-service failures also exit 0; look only at the last lines (the session's own output
# can contain words like "timeout"). Seen 2026-11-04: "Infer timeout: no data received over
# 600000ms" and "Model Queuing / Cannot connect to the model service".
if [ $rc = 0 ] && tail -n 8 "$LOG" | grep -qE "Infer timeout|Model Queuing|Cannot connect to the model service"; then
  echo "dsh: TRANSPORT (codearts model service: $(tail -n 8 "$LOG" | grep -oE 'Infer timeout|Model Queuing|Cannot connect to the model service' | head -1))"
  rm -f "$LOG"; exit 6
fi
if [ $rc != 0 ]; then
  if grep -qiE "429|rate.?limit|too many requests|quota" "$LOG"; then echo "dsh: RATE_LIMIT (codearts exit $rc)"
  elif grep -qiE "connection (reset|refused|closed)|timed? ?out|ENOTFOUND|EAI_AGAIN|fetch failed|\b50[0234]\b" "$LOG"; then echo "dsh: TRANSPORT (codearts exit $rc)"
  else echo "dsh: WORKER_FAILED (codearts exit $rc)"; fi
fi
rm -f "$LOG"; exit $rc
