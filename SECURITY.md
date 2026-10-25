# Security Policy

## Supported Versions

Active development is on `master`. Only the latest published release on npm is supported.

harness gates agent tool calls. Vulnerabilities are treated as serious, above all: a bypass of the branch-protection hook (an edit on a protected branch that the hook should have refused), misuse of the `harness gate disable` / `enable` kill switch (restoring or removing hook state that belongs to another file), tampering with the integrity of the generated `settings.json` or the harness-managed block of `~/.codex/config.toml`, and manifest loading that accepts or acts on more than the operator declared (schema-injection in YAML config).

## Reporting a Vulnerability

Please **do not** open a public GitHub issue for security reports.

Email **contact@lan-nguyen-si.de** with:

- Affected version
- Reproduction steps or proof-of-concept
- Impact assessment (gate bypass, generated-config tampering, etc.)

You will get an acknowledgement within 72 hours and an initial assessment within 7 days. A fix timeline depends on severity and complexity, communicated in the assessment.
