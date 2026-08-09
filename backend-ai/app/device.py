from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Any

logger = logging.getLogger("uvicorn.error")


@dataclass(frozen=True)
class DeviceInfo:
    name: str
    type: str  # "cpu", "cuda", "mps"
    available: bool
    device_count: int
    cuda_version: str | None = None
    device_names: list[str] | None = None


def detect_device() -> DeviceInfo:
    """
    Detect the best available PyTorch compute device automatically.
    Priority: CUDA > MPS (Apple Silicon) > CPU.
    Always returns a valid device and falls back to CPU.
    """
    try:
        import torch
    except ImportError:
        logger.warning("PyTorch is not installed; falling back to CPU")
        return DeviceInfo(
            name="cpu",
            type="cpu",
            available=True,
            device_count=1
        )

    # Detect CUDA.
    if torch.cuda.is_available():
        cuda_devices = []
        for i in range(torch.cuda.device_count()):
            try:
                device_name = torch.cuda.get_device_name(i)
                cuda_devices.append(device_name)
            except Exception:
                cuda_devices.append(f"CUDA Device {i}")

        cuda_version = torch.version.cuda
        logger.info(
            f"CUDA GPUs detected: {len(cuda_devices)} device(s), CUDA version: {cuda_version}"
        )
        for idx, dev_name in enumerate(cuda_devices):
            logger.info(f"   GPU {idx}: {dev_name}")

        return DeviceInfo(
            name="cuda",
            type="cuda",
            available=True,
            device_count=len(cuda_devices),
            cuda_version=cuda_version,
            device_names=cuda_devices
        )

    # Detect MPS (Apple Silicon).
    if hasattr(torch.backends, 'mps') and torch.backends.mps.is_available():
        logger.info("MPS accelerator detected (Apple Silicon)")
        return DeviceInfo(
            name="mps",
            type="mps",
            available=True,
            device_count=1
        )

    # Fall back to CPU.
    cpu_count = torch.get_num_threads()
    logger.info(f"No GPU accelerator available; using CPU with {cpu_count} threads")
    return DeviceInfo(
        name="cpu",
        type="cpu",
        available=True,
        device_count=cpu_count
    )


def get_torch_device() -> Any:
    """Return the PyTorch device object used by model code."""
    device_info = detect_device()
    try:
        import torch
        return torch.device(device_info.name)
    except ImportError:
        return None


# Process-wide detected-device singleton, initialized on first use.
_global_device: DeviceInfo | None = None


def get_device() -> DeviceInfo:
    global _global_device
    if _global_device is None:
        _global_device = detect_device()
    return _global_device
