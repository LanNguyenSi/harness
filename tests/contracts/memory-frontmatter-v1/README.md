# Memory frontmatter contract v1

This directory pins the versioned `memory-frontmatter/v1` corpus from the
agent-memory producer. `vendor/` contains an exact committed producer tree;
`provenance.json` identifies that source revision and its deterministic tree
digest. The digest is SHA-256 of sorted `path:sha256(file-bytes)` lines, joined
with LF and no trailing newline. Case files are kept as bytes, including CRLF.

Refresh only from an explicit local checkout and a reviewed full producer SHA:

```sh
npm run sync:memory-frontmatter-contract -- --source /path/to/agent-memory --revision <40-lowercase-hex-sha>
```

The command requires that exact revision to be the checkout HEAD and refuses a
dirty contract path. It reads committed bytes, validates the complete corpus,
then replaces the local pin. It does not fetch, select a latest release, or
establish cryptographic authenticity: provenance is a source identity claim.
Review the producer change and this consumer pin together. Run
`npm run check:memory-frontmatter-contract` to validate the stored provenance,
manifest, membership, regular-file tree, and bytes offline. Future incompatible
contracts use a new versioned directory rather than changing this one.
