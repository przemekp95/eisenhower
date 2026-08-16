#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import re
import subprocess
import sys
from urllib.parse import unquote, urlsplit


PYPI_INDEX = "https://pypi.org/simple"
PYTORCH_CPU_INDEX = "https://download.pytorch.org/whl/cpu"
PYTORCH_WHEEL_HOSTS = frozenset({"download.pytorch.org", "download-r2.pytorch.org"})
PATCHED_BUILD_TOOLCHAIN = "py3.11-pip=26.2.1-r0"
ALLOWED_UNAUDITED = {
  "torch": "2.13.0+cpu",
  "torchvision": "0.28.0+cpu",
}
ALLOWED_HASHED_WHEEL_REQUIREMENTS = {
  (
    "https://github.com/explosion/spacy-models/releases/download/"
    "en_core_web_sm-3.8.0/en_core_web_sm-3.8.0-py3-none-any.whl"
    "#sha256=1932429db727d4bff3deed6b34cfc05df17794f4a52eeb26cf8928f7c1a0fb85"
  ): ("en_core_web_sm", "3.8.0"),
}
ALLOWED_HASHED_WHEEL_UNAUDITED = {"en-core-web-sm": "3.8.0"}
REQUIREMENT_PATTERN = re.compile(
  r"^(?P<name>[A-Za-z0-9_.-]+)(?:\[[A-Za-z0-9_,.-]+\])?==(?P<version>[^\s;]+)$"
)
SHA256_PATTERN = re.compile(r"^[0-9a-fA-F]{64}$")


class AuditPolicyError(RuntimeError):
  """The production dependency evidence does not satisfy the fail-closed policy."""


def canonical_name(name: str) -> str:
  return re.sub(r"[-_.]+", "-", name).lower()


def validate_requirements_policy(requirements_text: str) -> dict[str, tuple[str, str]]:
  indexes = []
  requirements: dict[str, tuple[str, str]] = {}

  for raw_line in requirements_text.splitlines():
    line = raw_line.strip()
    if not line or line.startswith("#"):
      continue
    if line.startswith("--index-url") or line.startswith("--extra-index-url"):
      indexes.append(line)
      continue
    if line in ALLOWED_HASHED_WHEEL_REQUIREMENTS:
      display_name, wheel_version = ALLOWED_HASHED_WHEEL_REQUIREMENTS[line]
      name = canonical_name(display_name)
      if name in requirements:
        raise AuditPolicyError(f"Duplicate production dependency pin: {display_name}")
      requirements[name] = (display_name, wheel_version)
      continue
    if line.startswith("-"):
      raise AuditPolicyError(f"Unsupported production requirement directive: {line}")

    match = REQUIREMENT_PATTERN.fullmatch(line)
    if match is None:
      raise AuditPolicyError(f"Production dependency is not exactly pinned: {line}")
    display_name = match.group("name")
    name = canonical_name(display_name)
    if name in requirements:
      raise AuditPolicyError(f"Duplicate production dependency pin: {display_name}")
    requirements[name] = (display_name, match.group("version"))

  expected_index = f"--extra-index-url {PYTORCH_CPU_INDEX}"
  if indexes != [expected_index]:
    raise AuditPolicyError(
      "Production requirements must declare only the public PyTorch CPU extra index."
    )

  for name, expected_version in ALLOWED_UNAUDITED.items():
    actual = requirements.get(name)
    if actual is None or actual[1] != expected_version:
      raise AuditPolicyError(
        f"The {name} audit exception requires the exact {expected_version} production pin."
      )

  return requirements


def validate_dockerfile_policy(dockerfile_text: str) -> None:
  if (
    re.search(
      r"--(?:extra-)?index-url\b|--find-links\b|--trusted-host\b|--no-index\b",
      dockerfile_text,
    )
    or re.search(
      r"\bPIP_(?:EXTRA_INDEX_URL|INDEX_URL|FIND_LINKS|TRUSTED_HOST|NO_INDEX|CONFIG_FILE)\b",
      dockerfile_text,
      flags=re.IGNORECASE,
    )
    or re.search(r"\bpip\s+config\b", dockerfile_text, flags=re.IGNORECASE)
  ):
    raise AuditPolicyError(
      "Dockerfile must use the source policy from requirements.txt without another index flag."
    )
  if "download.pytorch.org" in dockerfile_text or "download-r2.pytorch.org" in dockerfile_text:
    raise AuditPolicyError(
      "Dockerfile must not duplicate or override the checked PyTorch source declaration."
    )
  production_dependency_stage, production_marker, following_stages = dockerfile_text.partition(
    "FROM classifier AS production"
  )
  role_build = bool(production_marker)
  if not production_marker:
    production_dependency_stage, production_marker, following_stages = dockerfile_text.partition(
      "FROM base AS production"
    )
  if not production_marker:
    raise AuditPolicyError("Dockerfile must retain the checked production target.")
  pip_install_lines = [
    line.strip()
    for line in production_dependency_stage.splitlines()
    if re.search(r"\b(?:python(?:3(?:\.\d+)?)?\s+-m\s+)?pip\s+install\b", line)
  ]
  if PATCHED_BUILD_TOOLCHAIN not in dockerfile_text:
    raise AuditPolicyError("Dockerfile must install the pinned patched build toolchain.")
  expected_lines = (
    [
      "RUN python3.11 -m pip install --target /opt/python --requirement requirements-boundary.txt",
      "RUN python3.11 -m pip install --target /opt/python --upgrade --requirement requirements-ml.txt",
      "RUN python3.11 -m pip install --target /opt/python --upgrade --requirement requirements-classifier.txt",
      "RUN python3.11 -m pip install --target /opt/python --upgrade --requirement requirements-knowledge.txt",
      "RUN python3.11 -m pip install --target /opt/python --upgrade --requirement requirements-ingest.txt",
    ]
    if role_build
    else ["RUN python3.11 -m pip install --target /opt/python --requirement requirements.txt"]
  )
  if pip_install_lines != expected_lines:
    raise AuditPolicyError(
      "Dockerfile production dependencies must use exactly the checked role requirements installs."
    )
  production_stage = re.split(r"(?m)^FROM\s+", following_stages, maxsplit=1)[0]
  if re.search(r"\b(?:python(?:3(?:\.\d+)?)?\s+-m\s+)?pip\s+install\b", production_stage):
    raise AuditPolicyError(
      "Dockerfile production target must not install dependencies outside requirements.txt."
    )


def read_requirements_tree(path: Path, *, _seen: set[Path] | None = None) -> str:
  """Flatten local -r includes for policy validation without permitting remote sources."""

  resolved = path.resolve()
  seen = _seen or set()
  if resolved in seen:
    raise AuditPolicyError(f"Cyclic production requirement include: {path.name}")
  seen.add(resolved)
  flattened: list[str] = []
  for raw_line in resolved.read_text(encoding="utf-8").splitlines():
    line = raw_line.strip()
    if line.startswith("-r ") or line.startswith("--requirement "):
      include_name = line.split(maxsplit=1)[1]
      include_path = (resolved.parent / include_name).resolve()
      if include_path.parent != resolved.parent or not include_path.is_file():
        raise AuditPolicyError(f"Production requirement include is not a local peer: {include_name}")
      flattened.append(read_requirements_tree(include_path, _seen=seen))
      continue
    flattened.append(raw_line)
  seen.remove(resolved)
  return "\n".join(flattened)


def validate_audit_report(
  report: dict,
  direct_requirements: dict[str, tuple[str, str]],
) -> dict[str, str]:
  dependencies = report.get("dependencies") if isinstance(report, dict) else None
  if not isinstance(dependencies, list):
    raise AuditPolicyError("pip-audit did not return a dependency list.")

  reported: dict[str, dict] = {}
  skipped: dict[str, str] = {}
  for dependency in dependencies:
    if not isinstance(dependency, dict) or not isinstance(dependency.get("name"), str):
      raise AuditPolicyError("pip-audit returned a malformed dependency record.")
    display_name = dependency["name"]
    name = canonical_name(display_name)
    if name in reported:
      raise AuditPolicyError(f"pip-audit returned duplicate dependency records for {display_name}.")
    reported[name] = dependency

    skip_reason = dependency.get("skip_reason")
    if skip_reason is not None:
      if set(dependency) != {"name", "skip_reason"}:
        raise AuditPolicyError(
          f"pip-audit returned a malformed unaudited record for {display_name}."
        )
      expected_version = ALLOWED_UNAUDITED.get(name) or ALLOWED_HASHED_WHEEL_UNAUDITED.get(name)
      expected_reason = (
        "Dependency not found on PyPI and could not be audited: "
        f"{name} ({expected_version})"
      )
      if expected_version is None or skip_reason != expected_reason:
        raise AuditPolicyError(
          f"Unexpected or drifted unaudited dependency: {display_name}."
        )
      skipped[name] = expected_version
      continue

    version = dependency.get("version")
    vulnerabilities = dependency.get("vulns")
    if not isinstance(version, str) or not isinstance(vulnerabilities, list):
      raise AuditPolicyError(f"pip-audit returned malformed evidence for {display_name}.")
    if vulnerabilities:
      raise AuditPolicyError(f"pip-audit reported vulnerabilities for {display_name}.")

  missing = sorted(set(direct_requirements) - set(reported))
  if missing:
    names = ", ".join(direct_requirements[name][0] for name in missing)
    raise AuditPolicyError(f"pip-audit did not report direct dependencies: {names}.")

  for name, (display_name, expected_version) in direct_requirements.items():
    dependency = reported[name]
    if "skip_reason" not in dependency and dependency.get("version") != expected_version:
      raise AuditPolicyError(
        f"pip-audit resolved {display_name} at {dependency.get('version')}, "
        f"not the pinned {expected_version}."
      )

  return skipped


def _sha256_from_download_info(download_info: dict) -> str | None:
  archive_info = download_info.get("archive_info")
  if not isinstance(archive_info, dict):
    return None
  hash_value = archive_info.get("hash")
  if isinstance(hash_value, str) and hash_value.startswith("sha256="):
    return hash_value.removeprefix("sha256=")
  hashes = archive_info.get("hashes")
  if isinstance(hashes, dict) and isinstance(hashes.get("sha256"), str):
    return hashes["sha256"]
  return None


def validate_resolution_report(report: dict) -> dict[str, str]:
  installs = report.get("install") if isinstance(report, dict) else None
  if not isinstance(installs, list):
    raise AuditPolicyError("pip did not return a wheel resolution report.")

  resolved: dict[str, str] = {}
  for item in installs:
    if not isinstance(item, dict) or not isinstance(item.get("metadata"), dict):
      continue
    metadata = item["metadata"]
    raw_name = metadata.get("name")
    if not isinstance(raw_name, str):
      continue
    name = canonical_name(raw_name)
    if name not in ALLOWED_UNAUDITED:
      continue
    if name in resolved:
      raise AuditPolicyError(f"Duplicate {name} wheel source evidence.")

    version = metadata.get("version")
    download_info = item.get("download_info")
    url = download_info.get("url") if isinstance(download_info, dict) else None
    if version != ALLOWED_UNAUDITED[name] or not isinstance(url, str):
      raise AuditPolicyError(f"Drifted or incomplete {name} wheel source evidence.")

    try:
      parsed = urlsplit(url)
      parsed_port = parsed.port
    except ValueError as error:
      raise AuditPolicyError(f"Malformed {name} wheel source URL.") from error
    filename = unquote(parsed.path.rsplit("/", 1)[-1])
    expected_prefix = f"{name}-{ALLOWED_UNAUDITED[name]}-"
    has_authority_secret_or_port = any((
      parsed.username is not None,
      parsed.password is not None,
      parsed_port is not None,
    ))
    source_is_approved = (
      parsed.scheme == "https"
      and parsed.hostname in PYTORCH_WHEEL_HOSTS
      and not has_authority_secret_or_port
    )
    path_is_approved = (
      not parsed.query
      and not parsed.fragment
      and parsed.path.startswith("/whl/cpu/")
    )
    filename_is_approved = filename.startswith(expected_prefix) and filename.endswith(".whl")
    if not all((source_is_approved, path_is_approved, filename_is_approved)):
      raise AuditPolicyError(f"Unapproved {name} wheel source: expected official PyTorch CPU HTTPS.")

    digest = _sha256_from_download_info(download_info)
    if digest is None or SHA256_PATTERN.fullmatch(digest) is None:
      raise AuditPolicyError(f"Missing SHA-256 evidence for the resolved {name} wheel.")
    resolved[name] = version

  missing = sorted(set(ALLOWED_UNAUDITED) - set(resolved))
  if missing:
    raise AuditPolicyError(
      f"Missing official wheel source evidence for: {', '.join(missing)}."
    )
  return resolved


def _clean_pip_environment() -> dict[str, str]:
  environment = {
    key: value for key, value in os.environ.items() if not key.upper().startswith("PIP_")
  }
  environment["PIP_CONFIG_FILE"] = os.devnull
  environment["PIP_DISABLE_PIP_VERSION_CHECK"] = "1"
  environment["PIP_NO_INPUT"] = "1"
  return environment


def _run_json(command: list[str]) -> tuple[dict, int]:
  result = subprocess.run(
    command,
    check=False,
    capture_output=True,
    text=True,
    env=_clean_pip_environment(),
  )
  try:
    report = json.loads(result.stdout)
  except json.JSONDecodeError as error:
    raise AuditPolicyError(
      f"Dependency evidence command did not return JSON (status {result.returncode})."
    ) from error
  if not isinstance(report, dict):
    raise AuditPolicyError("Dependency evidence command returned a non-object JSON report.")
  return report, result.returncode


def run_audit(requirements_path: Path, dockerfile_path: Path) -> tuple[int, dict[str, str]]:
  direct_requirements = validate_requirements_policy(
    read_requirements_tree(requirements_path)
  )
  validate_dockerfile_policy(dockerfile_path.read_text(encoding="utf-8"))

  resolution_report, resolution_status = _run_json([
    sys.executable,
    "-m",
    "pip",
    "install",
    "--dry-run",
    "--ignore-installed",
    "--quiet",
    "--report",
    "-",
    "--index-url",
    PYPI_INDEX,
    "-r",
    str(requirements_path),
  ])
  if resolution_status != 0:
    raise AuditPolicyError(f"pip wheel source resolution failed with status {resolution_status}.")
  validate_resolution_report(resolution_report)

  audit_report, audit_status = _run_json([
    sys.executable,
    "-m",
    "pip_audit",
    "-r",
    str(requirements_path),
    "--format=json",
    "--progress-spinner=off",
    "--index-url",
    PYPI_INDEX,
  ])
  skipped = validate_audit_report(audit_report, direct_requirements)
  if audit_status != 0:
    raise AuditPolicyError(f"pip-audit failed with status {audit_status}.")
  return len(audit_report["dependencies"]), skipped


def main() -> int:
  project_root = Path(__file__).resolve().parents[1]
  parser = argparse.ArgumentParser(
    description="Fail closed around pip-audit and the pinned PyTorch CPU wheel blind spots."
  )
  parser.add_argument("--requirements", type=Path, default=project_root / "requirements.txt")
  parser.add_argument("--dockerfile", type=Path, default=project_root / "Dockerfile")
  args = parser.parse_args()

  try:
    dependency_count, skipped = run_audit(args.requirements, args.dockerfile)
  except (AuditPolicyError, OSError) as error:
    print(f"production-dependency-audit-failed: {error}", file=sys.stderr)
    return 1

  if skipped:
    blind_spots = ", ".join(f"{name}=={version}" for name, version in sorted(skipped.items()))
    print(
      f"pip-audit checked {dependency_count - len(skipped)} dependencies; known audit "
      f"blind spots remain for {blind_spots}. Every allowlisted direct wheel source and "
      "SHA-256 resolution was verified. This is not vulnerability evidence for the "
      "skipped wheels; the repository Trivy source scan remains a separate gate."
    )
  else:
    print(f"pip-audit checked all {dependency_count} resolved dependencies without skips.")
  return 0


if __name__ == "__main__":
  raise SystemExit(main())
