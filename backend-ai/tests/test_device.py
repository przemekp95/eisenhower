from types import SimpleNamespace

import pytest

from app.device import detect_device


class AcceleratorNamespace:
  def __init__(self, *, available=False, names=()):
    self._available = available
    self._names = tuple(names)

  def is_available(self):
    return self._available

  def device_count(self):
    return len(self._names)

  def get_device_name(self, index):
    return self._names[index]


@pytest.mark.parametrize(
  ("runtime", "expected"),
  [
    (
      SimpleNamespace(
        cuda=AcceleratorNamespace(available=True, names=("NVIDIA Test GPU",)),
        xpu=AcceleratorNamespace(),
        backends=SimpleNamespace(mps=AcceleratorNamespace()),
        version=SimpleNamespace(cuda="12.4", hip=None),
        get_num_threads=lambda: 8,
      ),
      ("cuda", "nvidia", "cuda", "12.4", "cuda"),
    ),
    (
      SimpleNamespace(
        cuda=AcceleratorNamespace(available=True, names=("AMD Test GPU",)),
        xpu=AcceleratorNamespace(),
        backends=SimpleNamespace(mps=AcceleratorNamespace()),
        version=SimpleNamespace(cuda=None, hip="6.3"),
        get_num_threads=lambda: 8,
      ),
      ("rocm", "amd", "hip", "6.3", "cuda"),
    ),
    (
      SimpleNamespace(
        cuda=AcceleratorNamespace(),
        xpu=AcceleratorNamespace(available=True, names=("Intel Test GPU",)),
        backends=SimpleNamespace(mps=AcceleratorNamespace()),
        version=SimpleNamespace(cuda=None, hip=None),
        get_num_threads=lambda: 8,
      ),
      ("xpu", "intel", "xpu", None, "xpu"),
    ),
    (
      SimpleNamespace(
        cuda=AcceleratorNamespace(),
        xpu=AcceleratorNamespace(),
        backends=SimpleNamespace(mps=AcceleratorNamespace(available=True)),
        version=SimpleNamespace(cuda=None, hip=None),
        get_num_threads=lambda: 8,
      ),
      ("mps", "apple", "mps", None, "mps"),
    ),
  ],
)
def test_detect_device_reports_backend_vendor_runtime_and_torch_namespace(runtime, expected):
  info = detect_device(runtime)

  assert (info.type, info.vendor, info.runtime, info.runtime_version, info.torch_device) == expected


def test_detect_device_falls_back_to_cpu_without_claiming_an_accelerator():
  runtime = SimpleNamespace(
    cuda=AcceleratorNamespace(),
    xpu=AcceleratorNamespace(),
    backends=SimpleNamespace(mps=AcceleratorNamespace()),
    version=SimpleNamespace(cuda=None, hip=None),
    get_num_threads=lambda: 6,
  )

  info = detect_device(runtime)

  assert info.type == "cpu"
  assert info.vendor == "cpu"
  assert info.runtime == "cpu"
  assert info.runtime_version is None
  assert info.torch_device == "cpu"
  assert info.available is True
