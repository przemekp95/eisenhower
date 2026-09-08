#!/usr/bin/env python3
"""Run the repository-owned verification gate from a Codex Stop hook."""

from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys


STATE_NAME = "codex-policy-gate.json"
OUTPUT_LIMIT = 6000


def run_git(cwd: Path, *args: str) -> subprocess.CompletedProcess[bytes]:
    return subprocess.run(
        ["git", *args],
        cwd=cwd,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        check=False,
    )


def repository_root(cwd: Path) -> Path | None:
    result = run_git(cwd, "rev-parse", "--show-toplevel")
    if result.returncode != 0:
        return None
    return Path(os.fsdecode(result.stdout).strip()).resolve()


def hash_worktree(root: Path) -> str:
    digest = hashlib.sha256()
    for args in (
        ("rev-parse", "HEAD"),
        ("status", "--porcelain=v1", "-z", "--untracked-files=all"),
        ("diff", "--binary", "HEAD", "--"),
    ):
        result = run_git(root, *args)
        digest.update(b"\0".join(os.fsencode(part) for part in args))
        digest.update(result.stdout)

    untracked = run_git(root, "ls-files", "--others", "--exclude-standard", "-z")
    for raw_path in filter(None, untracked.stdout.split(b"\0")):
        digest.update(raw_path)
        path = root / os.fsdecode(raw_path)
        try:
            if path.is_symlink():
                digest.update(os.fsencode(os.readlink(path)))
            else:
                digest.update(path.read_bytes())
        except OSError as exc:
            digest.update(repr(exc).encode("utf-8", errors="replace"))
    return digest.hexdigest()


def state_path(root: Path) -> Path:
    result = run_git(root, "rev-parse", "--git-path", STATE_NAME)
    candidate = Path(os.fsdecode(result.stdout).strip())
    return candidate if candidate.is_absolute() else root / candidate


def load_state(path: Path) -> dict[str, str]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    return value if isinstance(value, dict) else {}


def save_state(path: Path, state: dict[str, str]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(state, sort_keys=True) + "\n", encoding="utf-8")
    temporary.replace(path)


def emit(payload: dict[str, object]) -> None:
    print(json.dumps(payload, ensure_ascii=False))


def main() -> int:
    try:
        event = json.load(sys.stdin)
    except (json.JSONDecodeError, TypeError):
        return 0

    cwd = Path(event.get("cwd") or os.getcwd()).resolve()
    root = repository_root(cwd)
    if root is None:
        return 0

    verifier = root / ".codex" / "verify"
    fingerprint = hash_worktree(root)
    gate_state_path = state_path(root)
    gate_state = load_state(gate_state_path)

    if gate_state.get("passed") == fingerprint:
        return 0

    if event.get("stop_hook_active") is True and gate_state.get("failed") == fingerprint:
        emit({
            "continue": False,
            "stopReason": "Repository policy gate is still failing for the unchanged worktree.",
        })
        return 0

    if not verifier.is_file() or not os.access(verifier, os.X_OK):
        gate_state["failed"] = fingerprint
        save_state(gate_state_path, gate_state)
        emit({"decision": "block", "reason": "Repository policy gate is not executable."})
        return 0

    timeout = int(os.environ.get("CODEX_POLICY_GATE_TIMEOUT", "540"))
    try:
        result = subprocess.run(
            [str(verifier)],
            cwd=root,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            check=False,
            timeout=timeout,
        )
    except subprocess.TimeoutExpired as exc:
        output = (exc.stdout or "")[-OUTPUT_LIMIT:]
        gate_state["failed"] = fingerprint
        save_state(gate_state_path, gate_state)
        emit({"decision": "block", "reason": f"Repository policy gate timed out after {timeout}s.\n{output}"})
        return 0

    if result.returncode == 0:
        save_state(gate_state_path, {"passed": fingerprint})
        return 0

    gate_state["failed"] = fingerprint
    save_state(gate_state_path, gate_state)
    output = result.stdout[-OUTPUT_LIMIT:].strip()
    reason = f"Repository policy gate failed with exit {result.returncode}."
    if output:
        reason += f"\n\nLast output:\n{output}"
    emit({"decision": "block", "reason": reason})
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
