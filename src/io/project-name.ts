// `{project}` value validation and safe display, shared by every
// `{project}`-shaped interpolation sink.
//
// Lives in `src/io/` rather than `src/runtime/` (where `isValidProjectName`
// and `sanitizeProjectForDisplay` originated, task `c88461c1`) because
// `buildLockEntries` (`src/io/harness-lock.ts`, task `b5e6ccb0`) is itself
// one of those sinks, and `io/` may not import from `runtime/`
// (`io-no-upward-imports`, `.dependency-cruiser.cjs`). This is the same
// relocation pattern `.dependency-cruiser.cjs`'s header comment already
// documents for `src/policies/duration.ts`, `src/policies/extract.ts`,
// `src/runtime/ledger-record.ts` and `src/runtime/expand-home.ts`: a
// utility needed below its original layer moves down rather than the
// importing layer's boundary being relaxed. `src/runtime/git-context.ts`
// re-exports both names so every existing consumer that imports them from
// `../runtime/git-context.js` keeps working unchanged.

/**
 * Every C0 control character (U+0000 to U+001F, so NUL, LF, CR and ESC
 * among them), DEL (U+007F), and every C1 control character (U+0080 to
 * U+009F, NEL included). Shared by {@link isValidProjectName}, which
 * rejects a name carrying one, and {@link sanitizeProjectForDisplay},
 * which strips them from a name that was already rejected and is being
 * echoed back.
 */
const PROJECT_NAME_CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/;

/**
 * {@link PROJECT_NAME_CONTROL_CHARS} with the `g` flag, for
 * `String.prototype.replace`. Two objects built from one source rather
 * than one shared `g`-flagged regex, because a `g`-flagged regex carries
 * a stateful `lastIndex` that makes `.test()` alternate between hits and
 * misses across calls.
 */
const PROJECT_NAME_CONTROL_CHARS_GLOBAL = new RegExp(PROJECT_NAME_CONTROL_CHARS.source, "g");

/**
 * Is `name` usable as a `{project}` value at all: both as an on-disk
 * directory component (`<home>/projects/<name>/harness.overrides.yaml`,
 * `resolvePaths`, `src/cli/loader.ts`) and as a value that will end up
 * inside rendered CLI output? Two independent screens, both applied here
 * at the SOURCE rather than at each consumer:
 *
 *  - PATH ESCAPE. Rejects the empty string, `"."`, and `".."` (the two
 *    `path.join` special-cases that either no-op or climb a level,
 *    `".."` being exactly the shape a crafted, un-normalized `commondir`
 *    used to produce before the fix above), plus any name containing a
 *    forward slash or a backslash (Windows separator; POSIX permits a
 *    literal backslash IN a directory name, so this is not redundant
 *    with the platform's own path parsing).
 *  - CONTROL CHARACTERS. Rejects any name containing one of
 *    {@link PROJECT_NAME_CONTROL_CHARS}, NUL included (which is why
 *    there is no separate NUL clause). A newline would forge an extra,
 *    diagnostic-looking line of caller-chosen text wherever the value is
 *    rendered, an ESC would write raw terminal escapes into the
 *    operator's terminal, and a CR would overwrite the line it landed
 *    on. Screening here rather than at each rendering site is what makes
 *    "an accepted project name is a plain single-line string" a property
 *    of the VALUE: it also covers the surfaces that render the
 *    SUBSTITUTED memory directory path rather than the name itself
 *    (`harness doctor`'s "memory directory missing" line,
 *    `src/cli/doctor/format.ts`; `harness list memories`' `path` row
 *    field, `src/cli/list.ts`), which no per-site escaper of the name
 *    would ever have reached.
 *
 * A name that passes both screens may still not exist on disk
 * (`resolvePaths` already handles that with `fs.existsSync`); this only
 * guards against the value escaping the single path segment it is meant
 * to occupy and against it carrying control characters anywhere
 * downstream.
 *
 * WHAT A REJECTION LOOKS LIKE. `deriveProjectName` (`src/runtime/git-
 * context.ts`) validates its own return value at every exit, so a
 * checkout directory whose basename contains a control character now
 * takes the same path a `".."` basename already took: the helper returns
 * `null`, no project override layer is looked up for that repository,
 * and the base/machine value applies unchanged. There is no error and no
 * warning; the operator sees the host-wide value instead of a per-repo
 * one (`harness doctor`'s setup-version finding then carries
 * `projectName: null` and renders no `(project: X)` suffix). An explicit
 * `--project` carrying a control character is instead reported:
 * `resolvePaths` resolves no project layer for it, and
 * `substituteProject` (`src/probes/memory.ts`) degrades to the "no
 * project supplied" branch, which `harness doctor` surfaces as its
 * rejected-`--project` warn line.
 *
 * Exported (task c88461c1, review round 3 residual; task `1c4eb3ea`
 * of the batch-44 follow-up run) so `resolvePaths` (`src/cli/loader.ts`)
 * can apply the SAME guard at its own `path.join` sink, defense in
 * depth: this function already rejects an unsafe name at every
 * `deriveProjectName` exit, but an `opts.project` reaching
 * `resolvePaths`' OWN sink from anywhere else (a caller building
 * `LoaderOptions` by hand, a future producer) had no equivalent check
 * of its own until now. Applied a THIRD time at `substituteProject`'s
 * own sink (`src/probes/memory.ts`, task `e904f25a`): an invalid name
 * there degrades to the "no project supplied" branch instead of being
 * interpolated into the `{project}` placeholder. Applied a FOURTH time
 * at `buildLockEntries`' own sink (`src/io/harness-lock.ts`, task
 * `b5e6ccb0`): an invalid name there skips the templated directory's
 * lock entry instead of the raw value being interpolated into the path
 * this function stats, hashes and writes into `harness.lock`.
 * `resolvePaths`, `substituteProject` and `buildLockEntries` are now all
 * guarded; one `{project}` sink is NOT: `generate-memory-index.ts`'s own
 * substitution still interpolates an operator-supplied `--project` value
 * into a path unvalidated, left unguarded (reached only via the explicit
 * CLI flag, not this module's derivation; see CHANGELOG.md for the
 * reservation/follow-up). That one call site calls this function
 * nowhere, so it inherits NOTHING from the control-character screen
 * above either: a caller reading this comment should not assume this
 * function guards every `{project}`-shaped sink in the codebase, for
 * path escapes or for control characters.
 */
export function isValidProjectName(name: string): boolean {
  if (name.length === 0) return false;
  if (name === "." || name === "..") return false;
  if (PROJECT_NAME_CONTROL_CHARS.test(name)) return false;
  return !name.includes("/") && !name.includes("\\");
}

/**
 * Renders a REJECTED project name safe to interpolate into one line of
 * CLI output. The invariant this helper is half of has two parts, and
 * they are complementary rather than overlapping (task `e904f25a`):
 *
 *  - An ACCEPTED name cannot carry a control character at all.
 *    {@link isValidProjectName} rejects C0, DEL and C1 at the source, so
 *    every value that survives validation is already a plain
 *    single-line string wherever it, or a path it was substituted into,
 *    is rendered. Nothing downstream of the validator has to enumerate
 *    its own rendering sites to stay safe.
 *  - A REJECTED name is by definition unvalidated, and it is still
 *    echoed back so the operator can see WHICH value was refused. Every
 *    such echo goes through this helper: `harness doctor`'s
 *    rejected-`--project` warn line and its per-directory note
 *    (`src/cli/doctor/format.ts`), doctor's header `project:` clause
 *    (which renders the raw `--project` whether it was accepted or
 *    rejected), and `harness list memories`' `project_rejected` row
 *    field (`src/cli/list.ts`, and with it the text table derived from
 *    it).
 *
 * Strips (rather than escapes) every character in
 * {@link PROJECT_NAME_CONTROL_CHARS}. A name with no control character
 * (`..`, `a/b`, every ordinary shape) passes through unchanged. Report
 * DATA keeps the raw value (`DoctorReport.project`,
 * `MemoryReport.projectRejected`), so a `--json` consumer still reads
 * back exactly what the operator passed, carried by JSON's own escaping
 * rather than by a raw control byte.
 */
export function sanitizeProjectForDisplay(name: string): string {
  return name.replace(PROJECT_NAME_CONTROL_CHARS_GLOBAL, "");
}
