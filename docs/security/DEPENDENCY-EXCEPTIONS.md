# Dependency security exceptions

## NLTK `PYSEC-2026-3740`

**Status:** temporary, owner-approved on 2026-09-08
**Scope:** `nltk==3.10.3`, transitive only through `llama-index-core==0.14.23`
**Advisory:** `PYSEC-2026-3740` / `CVE-2026-81726` / `GHSA-8mgp-746c-j5xp`

The repository owner explicitly approved this one exception because NLTK has no fixed
release and removing LlamaIndex would require a materially larger adapter rewrite. It
does not cover another NLTK version, another advisory, direct NLTK use, or any other
package.

The canonical production dependency audit enforces all of these conditions:

- the resolved package is exactly `nltk==3.10.3`;
- the only reported NLTK vulnerability is `PYSEC-2026-3740`;
- `pip-audit` reports no available fixed version;
- NLTK is not directly pinned and the exact owning pin remains
  `llama-index-core==0.14.23`;
- project-owned production Python in `backend-ai/app` and `backend-ai/scripts` has no
  static or dynamic direct NLTK import.

The exception expires automatically: the gate fails when a fixed version appears in
the audit evidence, the dependency graph drifts, a second vulnerability is reported,
or project code starts importing NLTK. At that point update to the fixed compatible
release and remove this section and its narrow policy branch; do not broaden or renew
the exception implicitly.

The upstream advisory identifies model persistence and transition-parser APIs as the
affected surface. The stronger no-direct-import boundary keeps project code out of the
entire NLTK API while the transitive package remains present. This is risk containment,
not a claim that the dependency is vulnerability-free.

Sources: [NLTK advisory](https://github.com/nltk/nltk/security/advisories/GHSA-8mgp-746c-j5xp),
[upstream remediation pull request](https://github.com/nltk/nltk/pull/3753).
