class GenerationProviderError(RuntimeError):
  """Expected generation-provider failure that may safely trigger fallback."""

  default_reason = "generation_unavailable"

  def __init__(self, message: str, *, reason: str | None = None):
    super().__init__(message)
    self.reason = reason or self.default_reason


class GenerationProviderUnavailable(GenerationProviderError):
  """The generation provider could not serve the request."""


class InvalidGenerationOutput(GenerationProviderError):
  """The provider response violated the structured generation contract."""

  default_reason = "invalid_generation_output"


class ProjectionUnavailable(RuntimeError):
  """The vector projection could not complete because its runtime was unavailable."""
