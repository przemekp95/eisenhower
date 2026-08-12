from __future__ import annotations

import argparse
import json
from pathlib import Path
import sys

from pydantic import ValidationError

from .models import CandidateManifest
from .registry import ArtifactConflictError, ImmutableArtifactRegistry


def _parser() -> argparse.ArgumentParser:
  parser = argparse.ArgumentParser(description="Register and verify immutable private AI artifacts.")
  subparsers = parser.add_subparsers(dest="command", required=True)

  register_file = subparsers.add_parser("register-file")
  register_file.add_argument("--registry", type=Path, required=True)
  register_file.add_argument("--path", type=Path, required=True)
  register_file.add_argument("--name", required=True)
  register_file.add_argument("--revision", required=True)

  register_manifest = subparsers.add_parser("register-manifest")
  register_manifest.add_argument("--registry", type=Path, required=True)
  register_manifest.add_argument("--manifest", type=Path, required=True)

  verify = subparsers.add_parser("verify")
  verify.add_argument("--registry", type=Path, required=True)
  verify.add_argument("--candidate-id", required=True)
  return parser


def main(argv: list[str] | None = None) -> int:
  args = _parser().parse_args(argv)
  registry = ImmutableArtifactRegistry(args.registry)
  try:
    if args.command == "register-file":
      result = registry.register_file(args.path, name=args.name, revision=args.revision)
      print(result.model_dump_json())
    elif args.command == "register-manifest":
      manifest = CandidateManifest.model_validate_json(args.manifest.read_text(encoding="utf-8"))
      path = registry.register_manifest(manifest)
      print(json.dumps({"candidate_id": manifest.candidate_id, "path": str(path)}))
    else:
      print(registry.verify_manifest(args.candidate_id).model_dump_json())
  except (ArtifactConflictError, OSError, ValidationError, ValueError) as issue:
    print(f"artifact-registry-blocked: {issue}", file=sys.stderr)
    return 2
  return 0
