# Memory frontmatter v1

This corpus is the versioned producer contract for memory frontmatter routing.
`manifest.json` declares whether each case is accepted and, when accepted, the
resolved `type` returned by the runtime loader. Cases are intentionally limited
to type routing and parsing; consumers keep their own contracts for all other
frontmatter and file-walk behavior.

Case files are exact inputs. In particular, `crlf.md` uses CRLF bytes and must
not be normalized.
