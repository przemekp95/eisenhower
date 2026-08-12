from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Any

logger = logging.getLogger("uvicorn.error")


@dataclass(frozen=True)
class DeviceInfo:
  name: str
  type: str
  vendor: str
  runtime: str
  runtime_version: str | None
  torch_device: str
  available: bool
  device_count: int
  device_names: list[str] | None = None

  @property
  def cuda_version(self) -> str | None:
    """Backward-compatible field for existing API clients; CUDA means NVIDIA only."""
    return self.runtime_version if self.type == "cuda" else None


def _device_names(namespace, count: int, fallback_prefix: str) -> list[str]:
  names = []
  for index in range(count):
    try:
      names.append(namespace.get_device_name(index))
    except Exception:
      names.append(f"{fallback_prefix} Device {index}")
  return names


def detect_device(torch_runtime=None) -> DeviceInfo:
  """Report the active PyTorch backend without equating torch.cuda with NVIDIA."""
  if torch_runtime is None:
    try:
      import torch as torch_runtime
    except ImportError:
      logger.warning("PyTorch is not installed; falling back to CPU")
      return DeviceInfo("cpu", "cpu", "cpu", "cpu", None, "cpu", True, 1)

  if torch_runtime.cuda.is_available():
    count = torch_runtime.cuda.device_count()
    names = _device_names(torch_runtime.cuda, count, "GPU")
    hip_version = getattr(torch_runtime.version, "hip", None)
    if hip_version:
      logger.info("ROCm GPUs detected: %s device(s), HIP version: %s", count, hip_version)
      return DeviceInfo(
        "rocm",
        "rocm",
        "amd",
        "hip",
        str(hip_version),
        "cuda",
        True,
        count,
        names,
      )
    cuda_version = getattr(torch_runtime.version, "cuda", None)
    logger.info("CUDA GPUs detected: %s device(s), CUDA version: %s", count, cuda_version)
    return DeviceInfo(
      "cuda",
      "cuda",
      "nvidia",
      "cuda",
      str(cuda_version) if cuda_version else None,
      "cuda",
      True,
      count,
      names,
    )

  xpu = getattr(torch_runtime, "xpu", None)
  if xpu is not None and xpu.is_available():
    count = xpu.device_count()
    names = _device_names(xpu, count, "XPU")
    logger.info("Intel XPU accelerators detected: %s device(s)", count)
    return DeviceInfo("xpu", "xpu", "intel", "xpu", None, "xpu", True, count, names)

  mps = getattr(getattr(torch_runtime, "backends", None), "mps", None)
  if mps is not None and mps.is_available():
    logger.info("MPS accelerator detected (Apple Silicon)")
    return DeviceInfo("mps", "mps", "apple", "mps", None, "mps", True, 1)

  cpu_count = torch_runtime.get_num_threads()
  logger.info("No GPU accelerator available; using CPU with %s threads", cpu_count)
  return DeviceInfo("cpu", "cpu", "cpu", "cpu", None, "cpu", True, cpu_count)


def get_torch_device() -> Any:
  """Return the PyTorch device namespace used by the selected backend."""
  device_info = get_device()
  try:
    import torch
    return torch.device(device_info.torch_device)
  except ImportError:
    return None


_global_device: DeviceInfo | None = None


def get_device() -> DeviceInfo:
  global _global_device
  if _global_device is None:
    _global_device = detect_device()
  return _global_device
