class GenerationProviderError(RuntimeError):
  """Expected generation-provider failure that may safely trigger fallback."""


class GenerationProviderUnavailable(GenerationProviderError):
  """The generation provider could not serve the request."""


class InvalidGenerationOutput(GenerationProviderError):
  """The provider response violated the structured generation contract."""


class ProjectionUnavailable(RuntimeError):
  """The vector projection could not complete because its runtime was unavailable."""
