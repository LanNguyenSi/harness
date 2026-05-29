# runtime-reality PreToolUse hook

Block destructive runtime commands (compose down/restart, `systemctl`, `kill`, deploy scripts) when the live process state has drifted from what the documentation says should be running. This wires [`@lannguyensi/runtime-reality-checker`](https://github.com/LanNguyenSi/agent-grounding/tree/master/packages/runtime-reality-checker) as a harness `PreToolUse` hook.

The motivation: without this check, an agent can issue `docker-compose restart panel-api` on a host where `panel-frontend` is already gone, observe that nothing broke, and report success while the panel is still half-down. The hook runs a drift check first and denies the call when critical drift exists.

## How it works

1. A `PreToolUse` event fires for a Bash command.
2. The hook (`harness pack hook runtime-reality`) checks the command against a built-in trigger set (compose mutations, `systemctl`, `kill`/`pkill`, `./deploy-*`). Non-matching commands pass through silently.
3. On a match, it runs your `RUNTIME_REALITY_PROBE_CMD` to capture the actual process state, loads the expectations file for `RUNTIME_REALITY_KEYWORD`, and compares them.
4. Critical drift (an expected process is not running) denies the call. Warnings (port or startup-mode mismatch) are surfaced on stderr but allowed by default.

Every load or probe error degrades to allow: a misconfigured probe never tarpits the session. The only deny path is a probe that actually produced state showing critical drift.

## 1. Declare the hook

Add a `hooks[]` entry to your `harness.yaml`. The hook is env-driven, so all configuration is inline in the `command` string:

```yaml
hooks:
  - name: runtime-reality
    event: PreToolUse
    command: >-
      RUNTIME_REALITY_KEYWORD=deploy-panel
      RUNTIME_REALITY_EXPECTATIONS_DIR=$HOME/.runtime-reality/expectations
      RUNTIME_REALITY_PROBE_CMD="node $HOME/.runtime-reality/probes/runtime-reality-docker-probe.mjs"
      harness pack hook runtime-reality
    blocking: hard
    description: Block destructive runtime commands on critical process drift
```

`blocking: hard` is required so the hook's `deny` envelope actually blocks the tool call. Run `harness apply` to project this into your runtime config (`settings.json`), then `harness doctor` to confirm the hook is registered.

Note: the trigger matching runs inside the hook binary, so the entry needs no `bash_match`. The hook self-filters to the destructive command set and short-circuits everything else.

## 2. Write the expectations file

The keyword names a JSON file under `RUNTIME_REALITY_EXPECTATIONS_DIR` (default `~/.runtime-reality/expectations/`). For `RUNTIME_REALITY_KEYWORD=deploy-panel`, create `~/.runtime-reality/expectations/deploy-panel.json`:

```json
{
  "domain": "deploy-panel",
  "processes": [
    { "name": "panel-api",      "expected_startup": "docker", "expected_port": 3001 },
    { "name": "panel-frontend", "expected_startup": "docker", "expected_port": 3000 },
    { "name": "agent-relay",    "expected_startup": "docker", "expected_port": 4040 }
  ]
}
```

`name` must match the container name your probe reports (`docker ps` Names). `expected_startup` and `expected_port` are optional: drift on them is a warning, a missing process is critical.

## 3. Install the probe

The probe prints a JSON array of `{ name, running, startup_mode, port }` for the live processes. harness ships a Docker probe at `scripts/runtime-reality-docker-probe.mjs`. Copy it where your hook points:

```bash
mkdir -p ~/.runtime-reality/probes
cp "$(npm root -g)/@lannguyensi/harness/scripts/runtime-reality-docker-probe.mjs" \
   ~/.runtime-reality/probes/
```

For systemd or pm2 hosts, copy the script and swap the `docker ps` call for `systemctl list-units` or `pm2 jlist`, keeping the same output shape.

## Severity to decision

| Worst drift | Default decision | Override |
| ----------- | ---------------- | -------- |
| none / info | allow (silent) | n/a |
| warning | allow + stderr note | `RUNTIME_REALITY_WARN_AS_BLOCK=1` to escalate to deny |
| critical | deny + stderr message | `RUNTIME_REALITY_CRITICAL_AS_WARN=1` to degrade to allow |
| probe failed / not configured | allow + stderr warning | `RUNTIME_REALITY_PROBE_FAIL_BLOCK=1` to deny |

Set `RUNTIME_REALITY_DISABLE=1` to short-circuit the hook entirely (always allow).

## Env knobs

| Variable | Purpose |
| -------- | ------- |
| `RUNTIME_REALITY_KEYWORD` | Domain keyword: selects the expectations file. If unset, the hook degrades to allow (no baseline). |
| `RUNTIME_REALITY_EXPECTATIONS_DIR` | Directory of `<keyword>.json` files. Default `~/.runtime-reality/expectations`. |
| `RUNTIME_REALITY_PROBE_CMD` | Command that prints the actual-state JSON array. If unset, the hook allows (nothing to compare). |
| `RUNTIME_REALITY_WARN_AS_BLOCK` | Escalate warning-tier drift to deny. |
| `RUNTIME_REALITY_CRITICAL_AS_WARN` | Degrade critical drift to allow plus stderr. |
| `RUNTIME_REALITY_PROBE_FAIL_BLOCK` | Deny when the probe fails or is missing, instead of allowing. |
| `RUNTIME_REALITY_DISABLE` | Disable the hook entirely. |

## Example: blocked restart

```
Agent runs: docker-compose -f docker-compose.prod.yml restart panel-api

Expected (deploy-panel.json):  panel-api, panel-frontend, agent-relay
Actual   (docker probe):       panel-api, agent-relay   (panel-frontend missing)

Drift:    critical: Process 'panel-frontend' expected to be running but is NOT
Decision: deny

runtime-reality-checker: drift detected for keyword 'deploy-panel' before 'compose-mutation' tool call
  - [critical] Process 'panel-frontend' expected to be running but is NOT
Fix drift before continuing, or 'harness approve risk --reason "..."' to override.
```

## Scope

v1 resolves the keyword from `RUNTIME_REALITY_KEYWORD` only. A grounding-mcp session lookup, multi-keyword sessions, probe caching, and a structured JSONL audit trail are follow-ups. Multi-host probes are out of scope: the probe is local-host only.

The design spec lives in [`agent-grounding/docs/policy-runtime-reality.md`](https://github.com/LanNguyenSi/agent-grounding/blob/master/docs/policy-runtime-reality.md).
