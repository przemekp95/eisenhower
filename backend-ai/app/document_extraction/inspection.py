from __future__ import annotations

from html.parser import HTMLParser
from pathlib import Path, PurePosixPath
import re
from xml.etree import ElementTree
from zipfile import BadZipFile, ZipFile, is_zipfile

import magic
from pypdf import PdfReader

from .models import DocumentInspection, PromptInjectionSignal, SecretScanResult


PDF_MIME = "application/pdf"
DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
PPTX_MIME = "application/vnd.openxmlformats-officedocument.presentationml.presentation"
HTML_MIME = "text/html"

_MAX_ARCHIVE_MEMBERS = 10_000
_MAX_ARCHIVE_UNCOMPRESSED_BYTES = 512 * 1024**2
_MAX_XML_MEMBER_BYTES = 32 * 1024**2
_MAX_COMPRESSION_RATIO = 200

_EXECUTABLE_SUFFIXES = frozenset({
  ".app",
  ".bat",
  ".bin",
  ".cmd",
  ".com",
  ".dll",
  ".dylib",
  ".exe",
  ".hta",
  ".jar",
  ".js",
  ".jse",
  ".msi",
  ".ps1",
  ".scr",
  ".sh",
  ".so",
  ".vbe",
  ".vbs",
  ".wsf",
})

_SECRET_PATTERNS = {
  "api_key": re.compile(
    r"(?i)\b(?:api[_-]?key|access[_-]?token|auth[_-]?token|secret[_-]?key)\b"
    r"\s*(?:=|:)\s*[\"']?[a-z0-9_./+=-]{8,}"
  ),
  "cloud_access_key": re.compile(r"\b(?:AKIA|ASIA)[A-Z0-9]{16}\b"),
  "email_pii": re.compile(r"(?i)(?<![\w.-])[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+"),
  "jwt": re.compile(r"(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{8,}(?![A-Za-z0-9_-])"),
  "password_assignment": re.compile(
    r"(?i)\b(?:password|passwd|pwd)\b\s*(?:=|:)\s*[\"']?[^\s\"'<>]{8,}"
  ),
  "phone_pii": re.compile(
    r"(?<!\w)(?:\+\d{1,3}[\s.-]?)?(?:\(?\d{2,3}\)?[\s.-]?){2,4}\d{2,4}(?!\w)"
  ),
  "private_key": re.compile(r"-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----"),
}

_PROMPT_PATTERNS = {
  "instruction_override": re.compile(
    r"(?i)\b(?:ignore|disregard|override|forget)\b.{0,80}\b(?:previous|prior|above|system|developer)\b.{0,30}\binstructions?\b"
  ),
  "role_impersonation": re.compile(r"(?i)\b(?:you are now|act as|pretend to be)\b"),
  "system_prompt_exfiltration": re.compile(
    r"(?i)\b(?:reveal|show|print|return|repeat|expose)\b.{0,80}\b(?:system|developer)\s+(?:message|prompt|instructions?)\b"
  ),
  "tool_execution": re.compile(
    r"(?i)(?:<\s*tool[_-]?call\b|\b(?:execute|run)\b.{0,40}\b(?:command|shell|terminal|tool)\b)"
  ),
}


class _RawTextHTMLParser(HTMLParser):
  def __init__(self):
    super().__init__(convert_charrefs=True)
    self.fragments: list[str] = []

  def handle_data(self, data: str) -> None:
    self.fragments.append(data)

  @property
  def text(self) -> str:
    return "\n".join(self.fragments)


class LocalDocumentInspector:
  """Inspect approved document formats locally and return only typed findings."""

  def inspect(self, path: Path) -> DocumentInspection:
    candidate = Path(path)
    media_type = _mime(candidate)
    try:
      size_bytes = candidate.stat().st_size
      extension = candidate.suffix.lower()
      if extension == ".pdf":
        return self._inspect_pdf(candidate, media_type, size_bytes)
      if extension in {".docx", ".pptx"}:
        return self._inspect_ooxml(candidate, media_type, size_bytes, extension)
      if extension == ".html":
        return self._inspect_html(candidate, media_type, size_bytes)
      return _failed_inspection(
        media_type,
        archive=_archive_media_type(media_type) or is_zipfile(candidate),
        size_bytes=size_bytes,
      )
    except Exception:
      return _failed_inspection(media_type, size_bytes=_safe_size(candidate))

  def _inspect_pdf(
    self,
    path: Path,
    detected_media_type: str,
    size_bytes: int,
  ) -> DocumentInspection:
    try:
      reader = PdfReader(path, strict=True)
      encrypted = bool(reader.is_encrypted)
      if encrypted:
        return _inspection(
          media_type=detected_media_type,
          page_count=0,
          encrypted=True,
          malformed=False,
          raw_text=None,
          size_bytes=size_bytes,
        )
      page_count = len(reader.pages)
      raw_text = "\n".join(page.extract_text() or "" for page in reader.pages)
      return _inspection(
        media_type=detected_media_type,
        page_count=page_count,
        encrypted=False,
        malformed=page_count < 1,
        raw_text=raw_text if page_count else None,
        size_bytes=size_bytes,
      )
    except Exception:
      return _failed_inspection(detected_media_type, size_bytes=size_bytes)

  def _inspect_html(
    self,
    path: Path,
    detected_media_type: str,
    size_bytes: int,
  ) -> DocumentInspection:
    try:
      decoded = path.read_bytes().decode("utf-8", errors="strict")
      parser = _RawTextHTMLParser()
      parser.feed(decoded)
      parser.close()
    except (OSError, UnicodeDecodeError, ValueError):
      return _failed_inspection(detected_media_type, size_bytes=size_bytes)
    return _inspection(
      media_type=detected_media_type,
      page_count=1,
      encrypted=False,
      malformed=False,
      raw_text=parser.text,
      size_bytes=size_bytes,
    )

  def _inspect_ooxml(
    self,
    path: Path,
    detected_media_type: str,
    size_bytes: int,
    extension: str,
  ) -> DocumentInspection:
    if not is_zipfile(path):
      return _failed_inspection(detected_media_type, size_bytes=size_bytes)
    try:
      with ZipFile(path) as archive:
        members = archive.infolist()
        names = [member.filename for member in members]
        if not _safe_archive(members, names):
          return _failed_inspection(
            detected_media_type,
            archive=True,
            size_bytes=size_bytes,
          )
        package_kind = _package_kind(archive, names)
        expected_kind = extension.removeprefix(".")
        if package_kind is None:
          return _failed_inspection(
            detected_media_type,
            archive=True,
            size_bytes=size_bytes,
          )
        canonical_media_type = DOCX_MIME if package_kind == "docx" else PPTX_MIME
        if package_kind != expected_kind:
          return _failed_inspection(
            canonical_media_type,
            archive=True,
            size_bytes=size_bytes,
          )
        encrypted = any(member.flag_bits & 0x1 for member in members)
        embedded_executable = _contains_executable(names, archive)
        external_relationship = _contains_external_relationship(archive, names)
        if package_kind == "docx":
          page_count = _docx_page_count(archive, names)
          content_names = [
            name for name in names
            if name.startswith("word/") and name.endswith(".xml")
          ]
        else:
          content_names = [
            name for name in names
            if re.fullmatch(r"ppt/slides/slide\d+\.xml", name)
          ]
          page_count = len(content_names)
        raw_text = _xml_text(archive, content_names)
        malformed = external_relationship or page_count < 1
        return _inspection(
          media_type=canonical_media_type,
          page_count=max(page_count, 0),
          encrypted=encrypted,
          archive=False,
          embedded_executable=embedded_executable,
          malformed=malformed,
          raw_text=None if encrypted else raw_text,
          size_bytes=size_bytes,
          uncompressed_bytes=sum(member.file_size for member in members),
          member_count=len(members),
        )
    except (BadZipFile, KeyError, OSError, UnicodeDecodeError, ValueError, ElementTree.ParseError):
      return _failed_inspection(detected_media_type, archive=True, size_bytes=size_bytes)


def _mime(path: Path) -> str:
  try:
    value = str(magic.from_file(str(path), mime=True)).lower().split(";", maxsplit=1)[0].strip()
  except (OSError, TypeError):
    return "application/octet-stream"
  return value or "application/octet-stream"


def _safe_archive(members, names: list[str]) -> bool:
  if not members or len(members) > _MAX_ARCHIVE_MEMBERS or len(set(names)) != len(names):
    return False
  total_uncompressed = 0
  for member in members:
    name = member.filename
    pure_path = PurePosixPath(name)
    unsafe_path = (
      not name or "\\" in name or pure_path.is_absolute() or ".." in pure_path.parts
    )
    invalid_size = member.file_size < 0 or member.compress_size < 0
    if unsafe_path or invalid_size:
      return False
    total_uncompressed += member.file_size
    if total_uncompressed > _MAX_ARCHIVE_UNCOMPRESSED_BYTES:
      return False
    if (
      member.file_size > 0
      and member.compress_size == 0
      or member.compress_size > 0
      and member.file_size / member.compress_size > _MAX_COMPRESSION_RATIO
    ):
      return False
  return True


def _package_kind(archive: ZipFile, names: list[str]) -> str | None:
  if "[Content_Types].xml" not in names or "_rels/.rels" not in names:
    return None
  content_types = _read_xml(archive, "[Content_Types].xml")
  values = {
    value
    for element in content_types.iter()
    if (value := element.attrib.get("ContentType"))
  }
  if any("wordprocessingml.document.main+xml" in value for value in values):
    return "docx"
  if any("presentationml.presentation.main+xml" in value for value in values):
    return "pptx"
  return None


def _contains_external_relationship(archive: ZipFile, names: list[str]) -> bool:
  for name in names:
    if not name.endswith(".rels"):
      continue
    root = _read_xml(archive, name)
    if any(
      element.attrib.get("TargetMode", "").casefold() == "external"
      for element in root.iter()
    ):
      return True
  return False


def _contains_executable(names: list[str], archive: ZipFile) -> bool:
  for name in names:
    path = PurePosixPath(name)
    suffix = path.suffix.casefold()
    if suffix == ".bin" and re.fullmatch(
      r"(?:word|ppt)/printerSettings/printerSettings\d+\.bin",
      name,
      flags=re.IGNORECASE,
    ):
      continue
    if suffix in _EXECUTABLE_SUFFIXES or path.name.casefold() == "vbaproject.bin":
      return True
  content_types = _read_xml(archive, "[Content_Types].xml")
  return any(
    "macroenabled" in value.casefold() or "vba" in value.casefold()
    for element in content_types.iter()
    if (value := element.attrib.get("ContentType"))
  )


def _docx_page_count(archive: ZipFile, names: list[str]) -> int:
  if "docProps/app.xml" not in names:
    return 0
  root = _read_xml(archive, "docProps/app.xml")
  pages = [element.text for element in root.iter() if _local_name(element.tag) == "Pages"]
  if len(pages) != 1 or pages[0] is None or not pages[0].strip().isdigit():
    return 0
  return int(pages[0].strip())


def _xml_text(archive: ZipFile, names: list[str]) -> str:
  fragments = []
  for name in names:
    root = _read_xml(archive, name)
    fragments.extend(
      element.text
      for element in root.iter()
      if _local_name(element.tag) in {"t", "delText", "instrText"} and element.text
    )
  return "\n".join(fragments)


def _read_xml(archive: ZipFile, name: str) -> ElementTree.Element:
  info = archive.getinfo(name)
  if info.file_size > _MAX_XML_MEMBER_BYTES:
    raise ValueError("XML member exceeds local inspection limit")
  data = archive.read(info)
  prefix = data[:4096].upper()
  if b"<!DOCTYPE" in prefix or b"<!ENTITY" in prefix:
    raise ValueError("XML declarations with external expansion are forbidden")
  return ElementTree.fromstring(data)


def _local_name(tag: str) -> str:
  return tag.rsplit("}", maxsplit=1)[-1]


def _scan_secrets(raw_text: str | None) -> SecretScanResult:
  if raw_text is None:
    return SecretScanResult(completed=False, secret_detected=False)
  finding_types = sorted(
    finding_type
    for finding_type, pattern in _SECRET_PATTERNS.items()
    if pattern.search(raw_text)
  )
  return SecretScanResult(
    completed=True,
    secret_detected=bool(finding_types),
    finding_types=finding_types,
  )


def _scan_prompt_injection(raw_text: str | None) -> PromptInjectionSignal:
  if raw_text is None:
    return PromptInjectionSignal(completed=False, detected=False)
  categories = sorted(
    category
    for category, pattern in _PROMPT_PATTERNS.items()
    if pattern.search(raw_text)
  )
  return PromptInjectionSignal(
    completed=True,
    detected=bool(categories),
    categories=categories,
  )


def _inspection(
  *,
  media_type: str,
  page_count: int,
  encrypted: bool,
  malformed: bool,
  raw_text: str | None,
  size_bytes: int,
  archive: bool = False,
  embedded_executable: bool = False,
  uncompressed_bytes: int = 0,
  member_count: int = 0,
) -> DocumentInspection:
  wall_seconds, memory_bytes = _resource_estimate(
    size_bytes=size_bytes,
    page_count=page_count,
    uncompressed_bytes=uncompressed_bytes,
    member_count=member_count,
  )
  return DocumentInspection(
    media_type=media_type,
    page_count=page_count,
    encrypted=encrypted,
    archive=archive,
    embedded_executable=embedded_executable,
    malformed=malformed,
    estimated_wall_seconds=wall_seconds,
    estimated_peak_memory_bytes=memory_bytes,
    secret_scan=_scan_secrets(raw_text),
    prompt_injection=_scan_prompt_injection(raw_text),
  )


def _failed_inspection(
  media_type: str,
  *,
  archive: bool = False,
  size_bytes: int = 0,
) -> DocumentInspection:
  return _inspection(
    media_type=media_type,
    page_count=0,
    encrypted=False,
    archive=archive,
    embedded_executable=False,
    malformed=True,
    raw_text=None,
    size_bytes=size_bytes,
  )


def _resource_estimate(
  *,
  size_bytes: int,
  page_count: int,
  uncompressed_bytes: int,
  member_count: int,
) -> tuple[float, int]:
  working_set = max(size_bytes, uncompressed_bytes)
  memory_bytes = max(64 * 1024**2, size_bytes * 20, working_set * 6)
  wall_seconds = max(
    0.1,
    size_bytes / (2 * 1024**2) + page_count * 0.05 + member_count * 0.002,
  )
  return round(wall_seconds, 6), memory_bytes


def _archive_media_type(media_type: str) -> bool:
  return media_type in {
    "application/gzip",
    "application/x-7z-compressed",
    "application/x-rar",
    "application/x-tar",
    "application/zip",
  }


def _safe_size(path: Path) -> int:
  try:
    return max(path.stat().st_size, 0)
  except OSError:
    return 0
