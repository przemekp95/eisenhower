from __future__ import annotations

from collections.abc import Mapping
import os


def configure_torch_threads(
  environment: Mapping[str, str] | None = None,
  *,
  torch_module=None,
) -> int | None:
  """Apply the measured Torch limit; leave development unchanged when unset."""

  source = environment or os.environ
  raw = source.get("TORCH_NUM_THREADS")
  if raw is None:
    return None
  try:
    limit = int(raw)
  except ValueError as issue:
    raise ValueError("TORCH_NUM_THREADS must be a positive integer") from issue
  if limit < 1:
    raise ValueError("TORCH_NUM_THREADS must be a positive integer")
  if torch_module is None:
    import torch as torch_module
  torch_module.set_num_threads(limit)
  return limit
