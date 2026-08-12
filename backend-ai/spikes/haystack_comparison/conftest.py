import sys
from pathlib import Path
from types import ModuleType


# The production package eagerly imports FastAPI from app/__init__.py. The spike
# loads only the framework-neutral rag package, without installing the runtime.
app = ModuleType("app")
app.__path__ = [str(Path(__file__).parents[2] / "app")]
sys.modules.setdefault("app", app)
