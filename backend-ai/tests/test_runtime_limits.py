import pytest

from app.runtime_limits import configure_torch_threads


class FakeTorch:
  def __init__(self):
    self.threads = None

  def set_num_threads(self, value):
    self.threads = value


def test_configures_explicit_positive_torch_thread_limit():
  torch = FakeTorch()

  configured = configure_torch_threads({"TORCH_NUM_THREADS": "3"}, torch_module=torch)

  assert configured == 3
  assert torch.threads == 3


@pytest.mark.parametrize("value", ["0", "-1", "many"])
def test_invalid_torch_thread_limit_fails_closed(value):
  with pytest.raises(ValueError):
    configure_torch_threads({"TORCH_NUM_THREADS": value}, torch_module=FakeTorch())
