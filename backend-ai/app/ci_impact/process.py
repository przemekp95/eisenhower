from __future__ import annotations

import os
from pathlib import Path
import selectors
import subprocess
import time
from typing import Mapping


class BoundedProcessError(ValueError):
  pass


def run_bounded(
  command: tuple[str, ...] | list[str],
  *,
  cwd: Path,
  timeout_seconds: float = 120,
  maximum_stdout_bytes: int = 64 * 1024 * 1024,
  maximum_stderr_bytes: int = 1024 * 1024,
  env: Mapping[str, str] | None = None,
) -> bytes:
  """Run a trusted argv without shell expansion while bounding time and captured bytes."""
  process = subprocess.Popen(  # pylint: disable=consider-using-with
    command, cwd=cwd, env=None if env is None else dict(env),
    stdout=subprocess.PIPE, stderr=subprocess.PIPE
  )
  selector = selectors.DefaultSelector()
  stdout = bytearray()
  stderr = bytearray()
  deadline = time.monotonic() + timeout_seconds
  try:
    if process.stdout is None or process.stderr is None:
      raise BoundedProcessError("bounded process pipes are unavailable")
    selector.register(process.stdout, selectors.EVENT_READ, (stdout, maximum_stdout_bytes, "stdout"))
    selector.register(process.stderr, selectors.EVENT_READ, (stderr, maximum_stderr_bytes, "stderr"))
    while selector.get_map():
      remaining = deadline - time.monotonic()
      if remaining <= 0:
        raise BoundedProcessError("bounded process timed out")
      events = selector.select(min(remaining, 0.5))
      if not events and process.poll() is not None:
        continue
      for key, _ in events:
        target, limit, stream_name = key.data
        chunk = os.read(key.fd, min(65_536, limit + 1))
        if not chunk:
          selector.unregister(key.fileobj)
          continue
        target.extend(chunk)
        if len(target) > limit:
          raise BoundedProcessError(f"bounded process {stream_name} limit exceeded")
    return_code = process.wait(timeout=max(0.01, deadline - time.monotonic()))
    if return_code != 0:
      message = stderr.decode("utf-8", errors="replace")[:500]
      raise BoundedProcessError(f"bounded process failed ({return_code}): {message}")
    return bytes(stdout)
  except (OSError, subprocess.SubprocessError) as issue:
    raise BoundedProcessError("bounded process execution failed") from issue
  finally:
    selector.close()
    if process.poll() is None:
      process.kill()
    process.wait()
    if process.stdout:
      process.stdout.close()
    if process.stderr:
      process.stderr.close()
