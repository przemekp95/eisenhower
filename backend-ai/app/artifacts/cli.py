from __future__ import annotations

import argparse
import json
from pathlib import Path
import sys

from pydantic import ValidationError

from .models import CandidateManifest
from .registry import ArtifactConflictError, ImmutableArtifactRegistry


def _add_location(parser: argparse.ArgumentParser) -> None:
  location = parser.add_mutually_exclusive_group(required=True)
  location.add_argument("--registry", type=Path)
  location.add_argument("--s3-bucket")
  parser.add_argument("--s3-prefix", default="model-artifacts")


def _registry(args):
  if args.s3_bucket:
    try:
      import boto3
    except ImportError as issue:
      raise RuntimeError("S3 registry requires the pinned AWS operations dependencies") from issue
    from .s3_registry import S3ImmutableArtifactRegistry
    return S3ImmutableArtifactRegistry(
      boto3.client("s3"), bucket=args.s3_bucket, prefix=args.s3_prefix,
    )
  return ImmutableArtifactRegistry(args.registry)


def _parser() -> argparse.ArgumentParser:
  parser = argparse.ArgumentParser(description="Register and verify immutable private AI artifacts.")
  subparsers = parser.add_subparsers(dest="command", required=True)

  register_file = subparsers.add_parser("register-file")
  _add_location(register_file)
  register_file.add_argument("--path", type=Path, required=True)
  register_file.add_argument("--name", required=True)
  register_file.add_argument("--revision", required=True)

  register_manifest = subparsers.add_parser("register-manifest")
  _add_location(register_manifest)
  register_manifest.add_argument("--manifest", type=Path, required=True)

  verify = subparsers.add_parser("verify")
  _add_location(verify)
  verify.add_argument("--candidate-id", required=True)
  return parser


def main(argv: list[str] | None = None) -> int:
  args = _parser().parse_args(argv)
  try:
    registry = _registry(args)
    if args.command == "register-file":
      result = registry.register_file(args.path, name=args.name, revision=args.revision)
      print(result.model_dump_json())
    elif args.command == "register-manifest":
      manifest = CandidateManifest.model_validate_json(args.manifest.read_text(encoding="utf-8"))
      path = registry.register_manifest(manifest)
      print(json.dumps({"candidate_id": manifest.candidate_id, "path": str(path)}))
    else:
      print(registry.verify_manifest(args.candidate_id).model_dump_json())
  except (ArtifactConflictError, OSError, RuntimeError, ValidationError, ValueError) as issue:
    print(f"artifact-registry-blocked: {issue}", file=sys.stderr)
    return 2
  return 0
