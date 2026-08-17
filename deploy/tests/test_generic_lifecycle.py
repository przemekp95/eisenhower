from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import subprocess
import tarfile


ROOT = Path(__file__).resolve().parents[2]
DEPLOY = ROOT / "deploy" / "generic" / "deploy.sh"
BACKUP = ROOT / "deploy" / "generic" / "backup.sh"
RESTORE = ROOT / "deploy" / "generic" / "restore.sh"
IMAGE_NAMES = (
  "backend-ai-boundary", "backend-ai-classifier", "backend-ai-knowledge",
  "backend-ai-ingest", "backend-node", "mcp", "web",
)


def _manifest(path: Path, sha: str, digit: str) -> None:
  path.write_text(json.dumps({
    "schema_version": "eisenhower-release/v1",
    "release_sha": sha,
    "images": [
      {"name": name, "digest": f"registry.example/{name}@sha256:{digit * 64}"}
      for name in IMAGE_NAMES
    ],
  }))


def _host(tmp_path: Path) -> tuple[Path, Path]:
  host = tmp_path / "host"
  host.mkdir()
  (host / ".deploy").mkdir()
  (host / ".eisenhower-deployment").write_text("eisenhower\n")
  (host / "compose.yaml").write_text("services: {}\n")
  env_file = tmp_path / "host.env"
  env_file.write_text("OIDC_ISSUER=https://identity.example.test\n")
  return host, env_file


def _fake_docker(tmp_path: Path, *, fail_first_up: bool = False, archive: Path | None = None) -> dict[str, str]:
  bin_dir = tmp_path / "bin"
  bin_dir.mkdir()
  log = tmp_path / "docker.log"
  count = tmp_path / "up.count"
  script = bin_dir / "docker"
  script.write_text(f"""#!/bin/sh
set -eu
printf '%s\\n' \"$*\" >> \"{log}\"
previous=''
for arg in \"$@\"; do
  if [ \"$previous\" = '--env-file' ]; then grep -E '^(RELEASE_SHA|WEB_IMAGE)=' \"$arg\" >> \"{log}\" || true; fi
  previous=$arg
done
case \" $* \" in
  *' exec -T mongodb mongodump '*) printf 'mongo-backup' ;;
  *' run --rm --no-deps -T backup-volume-helper '*) cat \"{archive or '/dev/null'}\" ;;
  *' up -d --remove-orphans --wait '* )
    value=0; [ -f \"{count}\" ] && value=$(cat \"{count}\"); value=$((value + 1)); printf '%s' \"$value\" > \"{count}\"
    {'[ "$value" -ne 1 ] || exit 42' if fail_first_up else ':'}
    ;;
esac
exit 0
""")
  script.chmod(0o755)
  return {**os.environ, "PATH": f"{bin_dir}:{os.environ['PATH']}"}


def test_failed_rollout_executes_previous_manifest_rollback(tmp_path):
  host, env_file = _host(tmp_path)
  previous = host / ".deploy" / "active-release-manifest.json"
  (host / ".deploy" / "active-n8n-profile").write_text("true\n")
  candidate = tmp_path / "candidate.json"
  _manifest(previous, "1" * 40, "a")
  _manifest(candidate, "2" * 40, "b")
  env = _fake_docker(tmp_path, fail_first_up=True)
  env["EISENHOWER_DEPLOY_ROOT"] = str(host)

  result = subprocess.run([DEPLOY, candidate, env_file, "false"], env=env, text=True, capture_output=True)

  assert result.returncode != 0
  assert json.loads(previous.read_text())["release_sha"] == "1" * 40
  log = (tmp_path / "docker.log").read_text()
  assert log.count("up -d --remove-orphans --wait") == 2
  assert f"RELEASE_SHA={'2' * 40}" in log
  assert f"RELEASE_SHA={'1' * 40}" in log
  assert "--profile n8n up -d --remove-orphans --wait" in log


def test_backup_is_checksummed_and_restore_requires_explicit_confirmation(tmp_path):
  host, env_file = _host(tmp_path)
  active = host / ".deploy" / "active-release-manifest.json"
  _manifest(active, "3" * 40, "c")
  archive = tmp_path / "volumes.tar.gz"
  source = tmp_path / "volume-source"
  source.mkdir()
  for name in ("audit", "n8n", "identity", "rag-jobs"):
    (source / name).mkdir()
  with tarfile.open(archive, "w:gz") as bundle:
    for child in source.iterdir():
      bundle.add(child, arcname=child.name)
  backup_root = tmp_path / "backups"
  env = _fake_docker(tmp_path, archive=archive)
  env.update({
    "EISENHOWER_DEPLOY_ROOT": str(host),
    "DEPLOY_ENV_FILE": str(env_file),
    "EISENHOWER_BACKUP_DIR": str(backup_root),
  })

  subprocess.run([BACKUP], env=env, check=True, text=True, capture_output=True)
  backup_set = next(backup_root.iterdir())
  sums = (backup_set / "SHA256SUMS").read_text()
  for name in ("mongodb.archive.gz", "private-volumes.tar.gz", "release-manifest.json"):
    assert hashlib.sha256((backup_set / name).read_bytes()).hexdigest() in sums

  restore_env = {**env, "EISENHOWER_BACKUP_SET": str(backup_set)}
  refused = subprocess.run([RESTORE], env=restore_env, text=True, capture_output=True)
  assert refused.returncode != 0
  assert "confirmation" in refused.stderr.lower()
