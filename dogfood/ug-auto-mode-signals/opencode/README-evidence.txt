Evidence index (opencode 1.18.18 --auto plugin observability probe, 2026-08-27)
version.txt / help-main.txt / help-run.txt   CLI help; --auto exists on default (tui) and run commands
binary-strings.txt                          strings of /opt/homebrew/lib/node_modules/opencode-ai/bin/opencode.exe
binary-context.txt                          OPENCODE_PERMISSION merge, hidden --yolo/--dangerously-skip-permissions aliases, run-cmd reply:"once"/"reject" loop, TUI mode==="auto"
binary-context-permission-ask.txt           "permission.ask" string count = 0 in code (only in docs text); trigger("permission -> 0
project/                                    isolated scratch project (opencode.json -> ollama/gemma4-q8-64k, .opencode/plugin/auto-probe.ts)
project-ask/                                same + "permission": {"bash": "ask"}
run-{a,b,c,d,e}.cmd / .stdout / .stderr     per-run command, stdout, stderr (--print-logs DEBUG)
probe-a.jsonl  (a) project      run --auto          bash allowed by default, no permission events
probe-b.jsonl  (b) project      run                 bash allowed by default, no permission events
probe-c.jsonl  (c) project-ask  run --auto          permission.asked -> permission.replied reply=once, tool ran
probe-d.jsonl  (d) project-ask  run                 permission.asked -> permission.replied reply=reject, tool NOT run
probe-e-serve.jsonl (e) project-ask serve --port 4097 + run --attach --auto: plugin lives in serve process, argv has no --auto, reply=once
diff-a-vs-b.txt                             field-level diff: only argv/bunArgv (+ pids, session ids, PROBE_* env) differ
