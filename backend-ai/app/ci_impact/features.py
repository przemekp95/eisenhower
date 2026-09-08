from __future__ import annotations

import ast
from collections import defaultdict, deque
from io import BytesIO
from pathlib import Path
import posixpath
import re
import tarfile

from app.ci_impact.models import ChangeSet, FeatureVector, JobConfig
from app.ci_impact.process import run_bounded


MANIFEST_NAMES = {
  "package.json", "requirements.txt", "pyproject.toml", "dockerfile", "compose.yaml", "docker-compose.yml",
  "docker-compose.yaml", "app.json", "app.config.js", "metro.config.js", "vite.config.js",
  "tsconfig.json",
}
LOCKFILE_NAMES = {
  "package-lock.json", "npm-shrinkwrap.json", "yarn.lock", "pnpm-lock.yaml", "poetry.lock",
  "uv.lock", "pipfile.lock",
}
JS_IMPORT_PATTERN = re.compile(
  r"(?:from\s+|require\s*\(|import\s*\()\s*['\"](?P<path>\.{1,2}/[^'\"]+)['\"]"
)


class LocalDependencyGraph:
  """Bounded local reverse-dependency graph; unresolved imports remain conservative features."""

  def __init__(
    self,
    reverse_edges: dict[str, set[str]] | None = None,
    unresolved_sources: set[str] | None = None,
  ):
    self._reverse_edges = reverse_edges or {}
    self._unresolved_sources = unresolved_sources or set()

  @property
  def unresolved(self) -> int:
    return len(self._unresolved_sources)

  @classmethod
  def combine(cls, *graphs: "LocalDependencyGraph") -> "LocalDependencyGraph":
    reverse: dict[str, set[str]] = defaultdict(set)
    unresolved: set[str] = set()
    for graph in graphs:
      for dependency, consumers in graph._reverse_edges.items():
        reverse[dependency].update(consumers)
      unresolved.update(graph._unresolved_sources)
    return cls(dict(reverse), unresolved)

  @classmethod
  def from_repository(
    cls,
    root: Path,
    *,
    maximum_files: int = 20_000,
    maximum_file_bytes: int = 2 * 1024 * 1024,
    maximum_total_bytes: int = 64 * 1024 * 1024,
  ) -> "LocalDependencyGraph":
    candidates = sorted(
      path for path in root.rglob("*")
      if path.is_file() and not path.is_symlink() and path.suffix.lower() in {".py", ".js", ".jsx", ".ts", ".tsx"}
      and not any(part in {"node_modules", "venv", ".git", "dist", "build"} for part in path.parts)
    )
    if len(candidates) > maximum_files:
      raise ValueError("dependency graph file limit exceeded")
    sources: dict[str, str] = {}
    unreadable: set[str] = set()
    total_bytes = 0
    for path in candidates:
      relative = path.relative_to(root).as_posix()
      try:
        size = path.stat().st_size
        if size > maximum_file_bytes or total_bytes + size > maximum_total_bytes:
          unreadable.add(relative)
          continue
        content = path.read_bytes()
        total_bytes += len(content)
        sources[relative] = content.decode("utf-8")
      except (OSError, UnicodeDecodeError):
        unreadable.add(relative)
    return cls._from_sources(sources, initial_unresolved=unreadable)

  @classmethod
  def from_git_revision(
    cls,
    root: Path,
    revision: str,
    *,
    maximum_files: int = 20_000,
    maximum_archive_bytes: int = 128 * 1024 * 1024,
    maximum_file_bytes: int = 2 * 1024 * 1024,
  ) -> "LocalDependencyGraph":
    if not re.fullmatch(r"[a-f0-9]{40}", revision):
      raise ValueError("dependency graph revision must be a full Git SHA")
    archive_bytes = run_bounded(
      ("git", "archive", "--format=tar", revision),
      cwd=root,
      maximum_stdout_bytes=maximum_archive_bytes,
    )
    sources: dict[str, str] = {}
    unreadable: set[str] = set()
    with tarfile.open(fileobj=BytesIO(archive_bytes), mode="r:") as archive:
      for member in archive:
        path = Path(member.name)
        if (
          not member.isfile()
          or path.is_absolute()
          or ".." in path.parts
          or path.suffix.lower() not in {".py", ".js", ".jsx", ".ts", ".tsx"}
          or any(part in {"node_modules", "venv", ".git", "dist", "build"} for part in path.parts)
        ):
          continue
        if len(sources) >= maximum_files:
          raise ValueError("dependency graph file limit exceeded")
        if member.size > maximum_file_bytes:
          unreadable.add(path.as_posix())
          continue
        extracted = archive.extractfile(member)
        if extracted is None:
          unreadable.add(path.as_posix())
          continue
        try:
          sources[path.as_posix()] = extracted.read().decode("utf-8")
        except UnicodeDecodeError:
          unreadable.add(path.as_posix())
    return cls._from_sources(sources, initial_unresolved=unreadable)

  @classmethod
  def _from_sources(
    cls, sources: dict[str, str], *, initial_unresolved: set[str] | None = None
  ) -> "LocalDependencyGraph":
    relative_paths = set(sources)
    reverse: dict[str, set[str]] = defaultdict(set)
    unresolved_sources = set(initial_unresolved or ())
    for relative, text in sources.items():
      dependencies = (
        cls._python_dependencies(relative, text)
        if Path(relative).suffix == ".py"
        else cls._js_dependencies(relative, text)
      )
      if dependencies is None:
        unresolved_sources.add(relative)
        continue
      for dependency in dependencies:
        resolved = cls._resolve_dependency(dependency, relative_paths)
        if resolved is None:
          unresolved_sources.add(relative)
        else:
          reverse[resolved].add(relative)
    return cls(dict(reverse), unresolved_sources)

  @staticmethod
  def _python_dependencies(relative: str, text: str) -> set[str] | None:
    try:
      tree = ast.parse(text)
    except SyntaxError:
      return None
    prefix = "backend-ai/" if relative.startswith("backend-ai/") else ""
    package_parts = Path(relative).parent.parts
    if prefix:
      package_parts = package_parts[1:]
    dependencies: set[str] = set()
    for node in ast.walk(tree):
      if isinstance(node, ast.Import):
        names = [alias.name for alias in node.names]
      elif isinstance(node, ast.ImportFrom):
        if node.level:
          keep = len(package_parts) - node.level + 1
          if keep < 0:
            dependencies.add("__unresolvable_relative_import__.py")
            continue
          components = [*package_parts[:keep]]
          if node.module:
            components.extend(node.module.split("."))
            names = [".".join(components)]
          else:
            names = [".".join((*components, alias.name)) for alias in node.names]
        else:
          names = [node.module] if node.module else []
      elif isinstance(node, ast.Call) and (
        isinstance(node.func, ast.Name) and node.func.id == "__import__"
        or isinstance(node.func, ast.Attribute) and node.func.attr == "import_module"
      ):
        dependencies.add("__dynamic_import__.py")
        continue
      else:
        continue
      for name in names:
        if name.startswith(("app.", "scripts.")):
          dependencies.add(prefix + name.replace(".", "/") + ".py")
    return dependencies

  @staticmethod
  def _js_dependencies(relative: str, text: str) -> set[str]:
    parent = Path(relative).parent
    return {
      posixpath.normpath((parent / match.group("path")).as_posix())
      for match in JS_IMPORT_PATTERN.finditer(text)
    }

  @staticmethod
  def _resolve_dependency(candidate: str, paths: set[str]) -> str | None:
    normalized = Path(candidate).as_posix()
    options = (
      normalized, *(normalized + suffix for suffix in (".js", ".jsx", ".ts", ".tsx")),
      *(f"{normalized}/index{suffix}" for suffix in (".js", ".jsx", ".ts", ".tsx")),
      *((normalized[:-3] + "/__init__.py",) if normalized.endswith(".py") else ()),
    )
    return next((option for option in options if option in paths), None)

  def impacted_by(self, changed_paths: set[str]) -> tuple[str, ...]:
    impacted: set[str] = set()
    queue = deque(changed_paths)
    visited = set(changed_paths)
    while queue:
      current = queue.popleft()
      for consumer in sorted(self._reverse_edges.get(current, ())):
        if consumer in visited:
          continue
        visited.add(consumer)
        impacted.add(consumer)
        queue.append(consumer)
    return tuple(sorted(impacted))

  def relevant_unresolved(self, paths: set[str]) -> tuple[str, ...]:
    roots = {path.split("/", 1)[0] for path in paths}
    if "packages" in roots:
      return tuple(sorted(self._unresolved_sources))
    return tuple(sorted(
      source for source in self._unresolved_sources if source.split("/", 1)[0] in roots
    ))


class FeatureExtractor:
  def __init__(self, *, config: JobConfig, dependency_graph: LocalDependencyGraph | None = None):
    self.config = config
    self.dependency_graph = dependency_graph or LocalDependencyGraph()

  def extract(
    self,
    changes: ChangeSet,
    *,
    auxiliary_diff_embedding: tuple[float, ...] | None = None,
  ) -> FeatureVector:
    values: dict[str, float] = {
      "change.add": 0.0,
      "change.modify": 0.0,
      "change.delete": 0.0,
      "change.rename": 0.0,
      "change.copy": 0.0,
      "change.binary": 0.0,
      "change.manifest": 0.0,
      "change.lockfile": 0.0,
      "change.workflow": 0.0,
      "diff.files": float(len(changes.files)),
      "diff.additions": float(sum(item.additions for item in changes.files)),
      "diff.deletions": float(sum(item.deletions for item in changes.files)),
      "diff.lines": float(sum(item.additions + item.deletions for item in changes.files)),
      "dependency.unresolved_count": 0.0,
    }
    prefix_features = {
      prefix: "path." + prefix.rstrip("/").replace("/", ".").replace("_", "-")
      for prefix in self.config.known_path_prefixes
    }
    values.update({feature: 0.0 for feature in prefix_features.values()})
    unknown: set[str] = set()
    changed_paths: set[str] = set()
    for item in changes.files:
      paths = (item.path,) if item.previous_path is None else (item.path, item.previous_path)
      changed_paths.update(paths)
      values[f"change.{self._status_feature(item.status)}"] += 1.0
      values["change.binary"] += float(item.binary)
      for path in paths:
        lower_name = Path(path).name.lower()
        values["change.manifest"] += float(lower_name in MANIFEST_NAMES)
        values["change.lockfile"] += float(lower_name in LOCKFILE_NAMES)
        values["change.workflow"] += float(path.startswith(".github/workflows/"))
        matches = [feature for prefix, feature in prefix_features.items() if path.startswith(prefix)]
        if not matches:
          unknown.add(path)
        for feature in matches:
          values[feature] = 1.0
    impacts = self.dependency_graph.impacted_by(changed_paths)
    values["dependency.impacted_count"] = float(len(impacts))
    values["dependency.unresolved_count"] = float(
      len(self.dependency_graph.relevant_unresolved(changed_paths | set(impacts)))
    )
    if auxiliary_diff_embedding is not None:
      if len(auxiliary_diff_embedding) > 64:
        raise ValueError("auxiliary diff embedding exceeds the bounded dimension")
      for index, value in enumerate(auxiliary_diff_embedding):
        if not -1000 <= float(value) <= 1000:
          raise ValueError("auxiliary diff embedding contains an invalid value")
        values[f"aux.diff_embedding.{index}"] = float(value)
    return FeatureVector.create(
      values=values,
      unknown_paths=tuple(sorted(unknown)),
      dependency_impacts=impacts,
    )

  @staticmethod
  def _status_feature(status: str) -> str:
    return {"added": "add", "modified": "modify", "deleted": "delete", "renamed": "rename", "copied": "copy"}[status]
