from __future__ import annotations

import io
import json
import logging
from pathlib import Path
from typing import Any, BinaryIO, Protocol, runtime_checkable
from urllib.parse import urlparse

try:
    from minio import Minio
    from minio.error import S3Error
    MINIO_AVAILABLE = True
except ImportError:
    MINIO_AVAILABLE = False


logger = logging.getLogger(__name__)


@runtime_checkable
class ObjectStorage(Protocol):
    """Protokół wspólny dla wszystkich magazynów obiektów"""
    
    def exists(self, path: str) -> bool:
        """Sprawdź czy obiekt istnieje"""
        ...
    
    def get(self, path: str) -> bytes | None:
        """Pobierz obiekt jako bajty"""
        ...
    
    def get_json(self, path: str) -> Any | None:
        """Pobierz obiekt jako JSON"""
        ...
    
    def put(self, path: str, data: bytes | BinaryIO, content_type: str = "application/octet-stream") -> bool:
        """Zapisz obiekt do magazynu"""
        ...
    
    def put_json(self, path: str, data: Any) -> bool:
        """Zapisz obiekt jako JSON"""
        ...
    
    def delete(self, path: str) -> bool:
        """Usuń obiekt"""
        ...
    
    def list(self, prefix: str = "") -> list[str]:
        """Wylistuj obiekty z danym prefiksem"""
        ...


class FileSystemStorage:
    """Implementacja magazynu na lokalnym systemie plików"""
    
    def __init__(self, root_dir: Path | str):
        self.root = Path(root_dir).resolve()
        self.root.mkdir(parents=True, exist_ok=True)
    
    def _resolve_path(self, path: str) -> Path:
        resolved = (self.root / path.lstrip("/")).resolve()
        # Zabezpieczenie przed path traversal
        if not resolved.is_relative_to(self.root):
            raise ValueError(f"Nieprawidłowa ścieżka: {path}")
        return resolved
    
    def exists(self, path: str) -> bool:
        return self._resolve_path(path).exists()
    
    def get(self, path: str) -> bytes | None:
        try:
            return self._resolve_path(path).read_bytes()
        except (FileNotFoundError, IsADirectoryError, PermissionError):
            return None
    
    def get_json(self, path: str) -> Any | None:
        data = self.get(path)
        if not data:
            return None
        try:
            return json.loads(data.decode("utf-8"))
        except (json.JSONDecodeError, UnicodeDecodeError):
            return None
    
    def put(self, path: str, data: bytes | BinaryIO, content_type: str = "application/octet-stream") -> bool:
        target = self._resolve_path(path)
        target.parent.mkdir(parents=True, exist_ok=True)
        
        try:
            if isinstance(data, bytes):
                target.write_bytes(data)
            else:
                with target.open("wb") as f:
                    f.write(data.read())
            return True
        except (PermissionError, IOError):
            return False
    
    def put_json(self, path: str, data: Any) -> bool:
        return self.put(path, json.dumps(data, ensure_ascii=False, indent=2).encode("utf-8"), "application/json")
    
    def delete(self, path: str) -> bool:
        try:
            self._resolve_path(path).unlink(missing_ok=True)
            return True
        except (IsADirectoryError, PermissionError):
            return False
    
    def list(self, prefix: str = "") -> list[str]:
        prefix_path = self._resolve_path(prefix)
        if not prefix_path.exists():
            return []
        
        results = []
        for item in prefix_path.rglob("*"):
            if item.is_file():
                results.append(str(item.relative_to(self.root)))
        return sorted(results)



class MinIOStorage:
    """Implementacja magazynu MinIO (S3 kompatybilny)"""
    
    def __init__(
        self,
        endpoint: str,
        access_key: str,
        secret_key: str,
        bucket: str,
        secure: bool = False,
        region: str = "us-east-1",
    ):
        if not MINIO_AVAILABLE:
            raise RuntimeError("Biblioteka minio nie jest zainstalowana")
        
        self.client = Minio(
            endpoint=endpoint,
            access_key=access_key,
            secret_key=secret_key,
            secure=secure,
            region=region,
        )
        self.bucket = bucket
        
        # Automatyczne tworzenie bucketu jeżeli nie istnieje
        if not self.client.bucket_exists(self.bucket):
            logger.info(f"Tworzenie brakującego bucketa: {self.bucket}")
            self.client.make_bucket(self.bucket)
    
    def exists(self, path: str) -> bool:
        try:
            self.client.stat_object(self.bucket, path.lstrip("/"))
            return True
        except S3Error as e:
            if e.code == "NoSuchKey":
                return False
            logger.warning(f"Błąd sprawdzania obiektu MinIO: {e}")
            return False
    
    def get(self, path: str) -> bytes | None:
        try:
            response = self.client.get_object(self.bucket, path.lstrip("/"))
            try:
                return response.read()
            finally:
                response.close()
                response.release_conn()
        except S3Error as e:
            if e.code != "NoSuchKey":
                logger.warning(f"Błąd pobierania obiektu MinIO: {e}")
            return None
    
    def get_json(self, path: str) -> Any | None:
        data = self.get(path)
        if not data:
            return None
        try:
            return json.loads(data.decode("utf-8"))
        except (json.JSONDecodeError, UnicodeDecodeError):
            return None
    
    def put(self, path: str, data: bytes | BinaryIO, content_type: str = "application/octet-stream") -> bool:
        try:
            if isinstance(data, bytes):
                stream = io.BytesIO(data)
                length = len(data)
            else:
                stream = data
                stream.seek(0, io.SEEK_END)
                length = stream.tell()
                stream.seek(0)
            
            self.client.put_object(
                bucket_name=self.bucket,
                object_name=path.lstrip("/"),
                data=stream,
                length=length,


class FallbackStorage:
    """Magazyn z fallbackiem: najpierw próbuje MinIO, jeżeli nie działa używa lokalnego FS"""
    
    def __init__(self, primary: ObjectStorage, fallback: ObjectStorage):
        self.primary = primary
        self.fallback = fallback
        self._primary_healthy = True
    
    def _check_health(self) -> bool:
        try:
            # Prosty test dostępności
            self.primary.list("/")
            self._primary_healthy = True
            return True
        except Exception:
            self._primary_healthy = False
            return False
    
    def exists(self, path: str) -> bool:
        if self._check_health():
            return self.primary.exists(path)
        return self.fallback.exists(path)
    
    def get(self, path: str) -> bytes | None:
        if self._check_health():
            return self.primary.get(path) or self.fallback.get(path)
        return self.fallback.get(path)
    
    def get_json(self, path: str) -> Any | None:
        if self._check_health():
            return self.primary.get_json(path) or self.fallback.get_json(path)
        return self.fallback.get_json(path)
    
    def put(self, path: str, data: bytes | BinaryIO, content_type: str = "application/octet-stream") -> bool:
        if self._check_health():
            return self.primary.put(path, data, content_type)
        return self.fallback.put(path, data, content_type)
    
    def put_json(self, path: str, data: Any) -> bool:
        if self._check_health():
            return self.primary.put_json(path, data)
        return self.fallback.put_json(path, data)
    
    def delete(self, path: str) -> bool:
        ok = True
        if self._check_health():
            ok = self.primary.delete(path)
        return ok and self.fallback.delete(path)
    
    def list(self, prefix: str = "") -> list[str]:
        if self._check_health():
            primary_items = set(self.primary.list(prefix))
            fallback_items = set(self.fallback.list(prefix))
            return sorted(primary_items.union(fallback_items))
        return self.fallback.list(prefix)


def create_storage(
    minio_endpoint: str | None = None,
    minio_access_key: str | None = None,
    minio_secret_key: str | None = None,
    minio_bucket: str | None = None,
    minio_secure: bool = False,
    fallback_root: Path | str | None = None,
) -> ObjectStorage:
    """
    Fabryka tworząca magazyn obiektów.
    Jeżeli wszystkie parametry MinIO są podane i dostępny, tworzy FallbackStorage z MinIO jako primary.
    W przeciwnym wypadku zwraca tylko FileSystemStorage.
    """
    fallback = FileSystemStorage(fallback_root or Path.cwd() / "data")
    
    if not MINIO_AVAILABLE or not all([minio_endpoint, minio_access_key, minio_secret_key, minio_bucket]):
        logger.info("Używanie wyłącznie lokalnego magazynu plików")
        return fallback
    
    try:
        minio_storage = MinIOStorage(
            endpoint=minio_endpoint,
            access_key=minio_access_key,
            secret_key=minio_secret_key,
            bucket=minio_bucket,
            secure=minio_secure,
        )
        logger.info(f"Połączono z MinIO: {minio_endpoint}, bucket: {minio_bucket}. Włączono fallback na lokalny FS.")
        return FallbackStorage(minio_storage, fallback)
    except Exception as e:
        logger.warning(f"Nie udało się połączyć z MinIO: {e}. Używanie tylko lokalnego magazynu.")
        return fallback

                content_type=content_type,
            )
            return True
        except S3Error as e:
            logger.warning(f"Błąd zapisu obiektu MinIO: {e}")
            return False
    
    def put_json(self, path: str, data: Any) -> bool:
        return self.put(path, json.dumps(data, ensure_ascii=False, indent=2).encode("utf-8"), "application/json")
    
    def delete(self, path: str) -> bool:
        try:
            self.client.remove_object(self.bucket, path.lstrip("/"))
            return True
        except S3Error as e:
            logger.warning(f"Błąd usuwania obiektu MinIO: {e}")
            return False
    
    def list(self, prefix: str = "") -> list[str]:
        try:
            objects = self.client.list_objects(self.bucket, prefix=prefix.lstrip("/"), recursive=True)
            return sorted(obj.object_name for obj in objects if not obj.is_dir)
        except S3Error as e:
            logger.warning(f"Błąd listowania obiektów MinIO: {e}")
            return []
