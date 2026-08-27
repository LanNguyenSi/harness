#!/usr/bin/env bash
# Codex counterpart of capture.sh: records what the Codex hook payload
# carries per event under each approval_policy / sandbox_mode shape, so the
# `permission_mode` values Codex actually emits can back the `auto_approve`
# allowlist (slice 2 of docs/decisions/2026-08-27-ug-auto-mode-approval.md).
# Produces payloads/codex-<shape>.<Event>.jsonl plus the hook process
# environment for the PreToolUse call. Runs against an isolated CODEX_HOME so
# the operator's real Codex config is never touched.
#
# Env vars (all optional):
#   UG_SIG_OUT          output dir for captured jsonl/stdout (default: mktemp -d)
#   UG_SIG_CODEX_HOME   isolated CODEX_HOME (default: mktemp -d)
#   UG_SIG_WORK         cwd the `codex exec` runs are launched from (default: mktemp -d)
#   UG_SIG_ONLY         space-separated run names to execute (default: all)
set -u

CAP="${UG_SIG_OUT:-$(mktemp -d)}"
DIR="${UG_SIG_CODEX_HOME:-$(mktemp -d)}"
WORK="${UG_SIG_WORK:-$(mktemp -d)}"
mkdir -p "$CAP" "$DIR" "$WORK"
chmod 700 "$DIR"
umask 077

# Codex keeps its login in $CODEX_HOME/auth.json. Copy the real one into the
# isolated home so `codex exec` can authenticate; removed on exit either way.
COPIED_CREDS=0
cleanup() {
  if [ "$COPIED_CREDS" = "1" ]; then
    rm -f "$DIR/auth.json"
    echo "cleanup: auth.json removed from isolated CODEX_HOME"
  fi
}
trap cleanup EXIT
if [ -f "$HOME/.codex/auth.json" ]; then
  cp "$HOME/.codex/auth.json" "$DIR/auth.json"
  chmod 600 "$DIR/auth.json"
  COPIED_CREDS=1
  echo "creds: copied"
else
  echo "creds: no ~/.codex/auth.json (API-key auth on this machine?)"
fi

{ codex --version; uname -a; } > "$CAP/version.txt" 2>&1

# Base config: hooks feature on, nothing else. Per-run overrides go in via
# -c flags, except for the config-derived runs which rewrite this file.
gen_config() {
  # Top-level keys must precede the [features] table in TOML, so the
  # per-run overrides are written first.
  : > "$DIR/config.toml"
  if [ $# -gt 0 ]; then
    printf '%s\n' "$@" >> "$DIR/config.toml"
  fi
  cat >> "$DIR/config.toml" <<'EOF'
[features]
hooks = true
EOF
}

gen_hooks() {
  local name=$1
  cat > "$DIR/hooks.json" <<EOF
{
  "hooks": {
    "SessionStart":      [{"hooks":[{"type":"command","command":"{ cat; echo; } >> $CAP/$name.SessionStart.jsonl"}]}],
    "UserPromptSubmit":  [{"hooks":[{"type":"command","command":"{ cat; echo; } >> $CAP/$name.UserPromptSubmit.jsonl"}]}],
    "PreToolUse":        [{"hooks":[
      {"type":"command","command":"{ cat; echo; } >> $CAP/$name.PreToolUse.jsonl"},
      {"type":"command","command":"{ env | grep -E '^(CODEX|CLAUDE|OPENAI|SHLVL|PPID|PWD|_=)' | sort; echo ---; ps -o pid=,ppid=,comm= -p \$PPID; ps -o pid=,ppid=,comm= -p \$\$; echo ===; } >> $CAP/$name.PreToolUse.env.txt"}
    ]}],
    "PermissionRequest": [{"hooks":[{"type":"command","command":"{ cat; echo; } >> $CAP/$name.PermissionRequest.jsonl"}]}],
    "PostToolUse":       [{"hooks":[{"type":"command","command":"{ cat; echo; } >> $CAP/$name.PostToolUse.jsonl"}]}],
    "Stop":              [{"hooks":[{"type":"command","command":"{ cat; echo; } >> $CAP/$name.Stop.jsonl"}]}],
    "SessionEnd":        [{"hooks":[{"type":"command","command":"{ cat; echo; } >> $CAP/$name.SessionEnd.jsonl"}]}]
  }
}
EOF
}

PROMPT="Run exactly this one shell command and nothing else: env | grep -i -E 'codex|claude|permission' | sort . Then reply with the single word: done"

wanted() {
  [ -z "${UG_SIG_ONLY:-}" ] && return 0
  case " $UG_SIG_ONLY " in *" $1 "*) return 0;; esac
  return 1
}

run() {
  local name=$1; shift
  wanted "$name" || return 0
  gen_hooks "$name"
  echo "=== run $name: $* ==="
  printf '%s\n' "$*" > "$CAP/$name.flags.txt"
  ( cd "$WORK" && CODEX_HOME="$DIR" codex exec \
      --dangerously-bypass-hook-trust --skip-git-repo-check --json \
      -o "$CAP/$name.last.txt" "$@" "$PROMPT" \
      > "$CAP/$name.stdout.jsonl" 2> "$CAP/$name.stderr.txt" )
  echo "exit=$? ; files:"; ls "$CAP" | grep "^$name\."
}

# --- flag-driven shapes (config.toml carries only the hooks feature) ---
gen_config
run exec-default
run exec-readonly       -s read-only
run exec-workspace      -s workspace-write
run exec-fullaccess     -s danger-full-access
run exec-never-ws       -c 'approval_policy="never"' -s workspace-write
run exec-never-full     -c 'approval_policy="never"' -s danger-full-access
run exec-untrusted      -c 'approval_policy="untrusted"'
run exec-onfailure      -c 'approval_policy="on-failure"'
run exec-onrequest      -c 'approval_policy="on-request"'
run exec-bypass         --dangerously-bypass-approvals-and-sandbox
run exec-approve-for-me --approve-for-me

# --- config-derived shapes (no flags; the mode comes from config.toml) ---
gen_config 'approval_policy = "never"' 'sandbox_mode = "danger-full-access"'
run config-never-full
gen_config 'approval_policy = "never"' 'sandbox_mode = "workspace-write"'
run config-never-ws
gen_config 'default_permissions = ":danger-full-access"'
run config-perm-fullaccess
gen_config 'default_permissions = ":read-only"'
run config-perm-readonly
gen_config

echo "=== done, output in $CAP ==="
