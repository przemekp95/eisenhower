def create_app(*args, **kwargs):
  """Load the heavyweight application factory only when that runtime is selected."""
  from .main import create_app as application_factory

  return application_factory(*args, **kwargs)

__all__ = ["create_app"]
