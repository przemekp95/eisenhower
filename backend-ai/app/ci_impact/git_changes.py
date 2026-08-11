from __future__ import annotations

import json
from pathlib import Path

from app.ci_impact.models import ChangeFile, ChangeSet
from app.ci_impact.process import run_bounded


def resolve_revision(repo_root: Path, revision: str) -> str:
  value = run_bounded(
    ("git", "rev-parse", "--verify", f"{revision}^{{commit}}"),
    cwd=repo_root,
    timeout_seconds=10,
    maximum_stdout_bytes=1024,
  ).decode().strip()
  if len(value) != 40:
    raise ValueError("Git revision did not resolve to a full SHA")
  return value


def changes_between(repo_root: Path, base_revision: str, head_revision: str) -> ChangeSet:
  base_sha = resolve_revision(repo_root, base_revision)
  head_sha = resolve_revision(repo_root, head_revision)
  run_bounded(
    ("git", "merge-base", "--is-ancestor", base_sha, head_sha),
    cwd=repo_root,
    timeout_seconds=10,
    maximum_stdout_bytes=1024,
  )
  name_status = run_bounded(
    ("git", "diff", "--name-status", "-z", "-M", base_sha, head_sha),
    cwd=repo_root,
  )
  numstat = run_bounded(
    ("git", "diff", "--numstat", "-z", "-M", base_sha, head_sha),
    cwd=repo_root,
  )
  stats = _parse_numstat(numstat)
  tokens = name_status.split(b"\0")
  if tokens and tokens[-1] == b"":
    tokens.pop()
  files: list[ChangeFile] = []
  index = 0
  status_map = {"A": "added", "M": "modified", "D": "deleted", "T": "modified"}
  while index < len(tokens):
    raw_status = tokens[index].decode("ascii", errors="strict")
    index += 1
    kind = raw_status[0]
    if kind in {"R", "C"}:
      if index + 1 >= len(tokens):
        raise ValueError("truncated Git rename record")
      previous_path = tokens[index].decode("utf-8", errors="strict")
      path = tokens[index + 1].decode("utf-8", errors="strict")
      index += 2
      additions, deletions, binary = stats.get((path, previous_path), (0, 0, True))
      files.append(ChangeFile(
        path=path,
        previous_path=previous_path,
        status="renamed" if kind == "R" else "copied",
        additions=additions,
        deletions=deletions,
        binary=binary,
      ))
    else:
      if kind not in status_map or index >= len(tokens):
        raise ValueError("unsupported or truncated Git change status")
      path = tokens[index].decode("utf-8", errors="strict")
      index += 1
      additions, deletions, binary = stats.get((path, None), (0, 0, True))
      files.append(ChangeFile(
        path=path,
        status=status_map[kind],
        additions=additions,
        deletions=deletions,
        binary=binary,
      ))
  if not files:
    raise ValueError("Git revisions contain no changed files")
  return ChangeSet(base_sha=base_sha, head_sha=head_sha, files=tuple(files))


def planner_changes_between(
  repo_root: Path, base_revision: str, head_revision: str
) -> tuple[dict[str, str], ...]:
  base_sha = resolve_revision(repo_root, base_revision)
  head_sha = resolve_revision(repo_root, head_revision)
  payload = run_bounded(
    ("git", "diff", "--name-status", "-z", "-M", base_sha, head_sha), cwd=repo_root
  )
  tokens = payload.split(b"\0")
  if tokens and tokens[-1] == b"":
    tokens.pop()
  changes: list[dict[str, str]] = []
  index = 0
  while index < len(tokens):
    status = tokens[index].decode("ascii", errors="strict")
    index += 1
    if status.startswith(("R", "C")):
      if index + 1 >= len(tokens):
        raise ValueError("truncated deterministic rename record")
      changes.append({
        "status": status,
        "path": tokens[index + 1].decode("utf-8", errors="strict"),
        "previousPath": tokens[index].decode("utf-8", errors="strict"),
      })
      index += 2
    else:
      if index >= len(tokens):
        raise ValueError("truncated deterministic change record")
      changes.append({
        "status": status,
        "path": tokens[index].decode("utf-8", errors="strict"),
      })
      index += 1
  return tuple(sorted(
    changes, key=lambda item: json.dumps(item, ensure_ascii=False, separators=(",", ":"))
  ))


def _parse_numstat(payload: bytes) -> dict[tuple[str, str | None], tuple[int, int, bool]]:
  tokens = payload.split(b"\0")
  if tokens and tokens[-1] == b"":
    tokens.pop()
  result: dict[tuple[str, str | None], tuple[int, int, bool]] = {}
  index = 0
  while index < len(tokens):
    fields = tokens[index].split(b"\t", 2)
    index += 1
    if len(fields) != 3:
      raise ValueError("invalid Git numstat record")
    raw_additions, raw_deletions, raw_path = fields
    binary = raw_additions == b"-" or raw_deletions == b"-"
    additions = 0 if binary else int(raw_additions)
    deletions = 0 if binary else int(raw_deletions)
    if raw_path:
      result[(raw_path.decode("utf-8", errors="strict"), None)] = (additions, deletions, binary)
    else:
      if index + 1 >= len(tokens):
        raise ValueError("truncated Git rename numstat record")
      previous_path = tokens[index].decode("utf-8", errors="strict")
      path = tokens[index + 1].decode("utf-8", errors="strict")
      index += 2
      result[(path, previous_path)] = (additions, deletions, binary)
  return result
