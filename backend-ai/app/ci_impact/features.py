from __future__ import annotations

import ast
from collections import defaultdict, deque
from io import BytesIO
from pathlib import Path
import posixpath
import re
import subprocess
import tarfile

from app.ci_impact.models import ChangeSet, FeatureVector, JobConfig


MANIFEST_NAMES = {
  "package.json", "requirements.txt", "pyproject.toml", "dockerfile", "docker-compose.yml",
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
  def from_repository(cls, root: Path, *, maximum_files: int = 20_000) -> "LocalDependencyGraph":
    candidates = sorted(
      path for path in root.rglob("*")
      if path.is_file() and not path.is_symlink() and path.suffix.lower() in {".py", ".js", ".jsx", ".ts", ".tsx"}
      and not any(part in {"node_modules", "venv", ".git", "dist", "build"} for part in path.parts)
    )
    if len(candidates) > maximum_files:
      raise ValueError("dependency graph file limit exceeded")
    sources: dict[str, str] = {}
    unreadable: set[str] = set()
    for path in candidates:
      try:
        sources[path.relative_to(root).as_posix()] = path.read_text(encoding="utf-8")
      except (OSError, UnicodeDecodeError):
        unreadable.add(path.relative_to(root).as_posix())
    return cls._from_sources(sources, initial_unresolved=unreadable)

  @classmethod
  def from_git_revision(
    cls,
    root: Path,
    revision: str,
    *,
    maximum_files: int = 20_000,
    maximum_archive_bytes: int = 128 * 1024 * 1024,
  ) -> "LocalDependencyGraph":
    if not re.fullmatch(r"[a-f0-9]{40}", revision):
      raise ValueError("dependency graph revision must be a full Git SHA")
    with subprocess.Popen(
      ["git", "archive", "--format=tar", revision],
      cwd=root,
      stdout=subprocess.PIPE,
      stderr=subprocess.PIPE,
    ) as process:
      try:
        if process.stdout is None:
          raise ValueError("dependency graph archive stdout is unavailable")
        archive_bytes = process.stdout.read(maximum_archive_bytes + 1)
        if len(archive_bytes) > maximum_archive_bytes:
          process.kill()
          process.communicate()
          raise ValueError("dependency graph archive limit exceeded")
        _, stderr = process.communicate(timeout=120)
      except subprocess.TimeoutExpired as issue:
        process.kill()
        process.communicate()
        raise ValueError("dependency graph archive timed out") from issue
      if process.returncode != 0:
        message = stderr.decode("utf-8", errors="replace")[:500]
        raise ValueError(f"dependency graph archive failed: {message}")
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
      for dependency in dependencies:
        resolved = cls._resolve_dependency(dependency, relative_paths)
        if resolved is None:
          unresolved_sources.add(relative)
        else:
          reverse[resolved].add(relative)
    return cls(dict(reverse), unresolved_sources)

  @staticmethod
  def _python_dependencies(relative: str, text: str) -> set[str]:
    try:
      tree = ast.parse(text)
    except SyntaxError:
      return set()
    prefix = "backend-ai/" if relative.startswith("backend-ai/") else ""
    dependencies: set[str] = set()
    for node in ast.walk(tree):
      names: list[str] = []
      if isinstance(node, ast.Import):
        names.extend(alias.name for alias in node.names)
      elif isinstance(node, ast.ImportFrom) and node.module:
        names.append(node.module)
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

  def impacted_by(self, changed_paths: set[str], *, maximum_depth: int = 20) -> tuple[str, ...]:
    impacted: set[str] = set()
    queue = deque((path, 0) for path in changed_paths)
    visited = set(changed_paths)
    while queue:
      current, depth = queue.popleft()
      if depth >= maximum_depth:
        continue
      for consumer in sorted(self._reverse_edges.get(current, ())):
        if consumer in visited:
          continue
        visited.add(consumer)
        impacted.add(consumer)
        queue.append((consumer, depth + 1))
    return tuple(sorted(impacted))

  def relevant_unresolved(self, paths: set[str]) -> tuple[str, ...]:
    return tuple(sorted(paths & self._unresolved_sources))


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
