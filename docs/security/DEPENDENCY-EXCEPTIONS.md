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

## Accelerate `CVE-2026-69112`

**Status:** temporary, owner-approved on 2026-09-08
**Scope:** `accelerate==1.14.0`, transitive only through
`unstructured-inference==1.6.13`
**Advisory:** `CVE-2026-69112` / `GHSA-4j2p-28q2-5m79`

The repository owner approved this exception after the advisory appeared during the
final promotion run. Accelerate 1.14.0 is the latest release and the advisory reports
no fixed version. Removing it currently means removing the supported Unstructured
inference dependency from the controlled document-extraction fallback rather than a
narrow package upgrade.

The canonical audit accepts only the exact package, version, advisory and transitive
owner above. It requires an empty fixed-version list, rejects any second advisory, and
forbids project-owned static or dynamic Accelerate imports as well as references to
`load_checkpoint_in_model` and `load_checkpoint_and_dispatch`. The application does
not accept a model-checkpoint path from document-ingest requests; its extraction
fallback uses repository-pinned dependencies and immutable model configuration.

The exception expires automatically when a fixed Accelerate version appears, the
dependency graph changes, another vulnerability is reported, or project code reaches
the affected checkpoint APIs. The next compatible fixed release must replace this
exception; it must not be broadened or renewed implicitly.

This contains the affected checkpoint-index traversal and blocking surface but does
not claim that Accelerate 1.14.0 is vulnerability-free.

Source: [GitHub Advisory Database](https://github.com/advisories/GHSA-4j2p-28q2-5m79).
