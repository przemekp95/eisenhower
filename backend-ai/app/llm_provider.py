from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any, Optional, Callable
import os
import platform
import logging

from .config import Settings


logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class LLMConfig:
    model_path: Path
    model_name: str
    quant_level: str = "Q4_K_M"
    n_ctx: int = 2048
    n_threads: int = 4
    n_gpu_layers: int = 0
    use_mmap: bool = True
    use_mlock: bool = False
    temperature: float = 0.1
    top_p: float = 0.9
    repeat_penalty: float = 1.1
    max_tokens: int = 512


@dataclass(frozen=True)
class DeviceInfo:
    device: str
    has_cuda: bool
    has_metal: bool
    cpu_cores: int
    total_memory_gb: float
    recommended_gpu_layers: int
    recommended_threads: int


class LLMProviderError(RuntimeError):
    pass


class LLMProvider:
    """
    Obsługa lokalnych modeli LLM z llama.cpp / llama-cpp-python
    Automatyczne wykrywanie urządzenia, obsługa kwantyzacji, fallback na CPU
    """

    def __init__(self, settings: Settings, config: Optional[LLMConfig] = None):
        self.settings = settings
        self.config = config or self._autodetect_config()
        self._llm: Any = None
        self._available = False
        self._last_error: Optional[str] = None
        self.device_info = self._detect_device()

    def _autodetect_config(self) -> LLMConfig:
        model_dir = self.settings.model_cache_dir / "llm_models"
        model_dir.mkdir(parents=True, exist_ok=True)
        
        device = self._detect_device()
        
        return LLMConfig(
            model_path=model_dir / "llama-3.2-8b-instruct-q4_k_m.gguf",
            model_name="Llama 3.2 8B Instruct",
            n_ctx=2048,
            n_threads=device.recommended_threads,
            n_gpu_layers=device.recommended_gpu_layers,
            temperature=0.1,
        )

    def _detect_device(self) -> DeviceInfo:
        has_cuda = False
        has_metal = False
        cpu_cores = os.cpu_count() or 4
        
        try:
            import torch
            has_cuda = torch.cuda.is_available()
        except ImportError:
            has_cuda = False

        if platform.system() == "Darwin":
            has_metal = True

        try:
            import psutil
            total_memory_gb = round(psutil.virtual_memory().total / (1024 ** 3), 1)
        except ImportError:
            total_memory_gb = 8.0

        recommended_gpu_layers = 0
        if has_cuda:
            recommended_gpu_layers = 99
        elif has_metal:
            recommended_gpu_layers = 20

        recommended_threads = max(1, min(cpu_cores - 1, 8))

        device_type = "cuda" if has_cuda else "metal" if has_metal else "cpu"

        return DeviceInfo(
            device=device_type,
            has_cuda=has_cuda,
            has_metal=has_metal,
            cpu_cores=cpu_cores,
            total_memory_gb=total_memory_gb,
            recommended_gpu_layers=recommended_gpu_layers,
            recommended_threads=recommended_threads,
        )

    def is_available(self) -> bool:
        return self._available and self._llm is not None

    def ensure_ready(self) -> None:
        if self._available and self._llm is not None:
            return

        try:
            from langchain_community.llms import LlamaCpp
            
            if not self.config.model_path.exists():
                self._last_error = f"Model file not found: {self.config.model_path}"
                raise LLMProviderError(self._last_error)

            self._llm = LlamaCpp(
                model_path=str(self.config.model_path),
                n_ctx=self.config.n_ctx,
                n_threads=self.config.n_threads,
                n_gpu_layers=self.config.n_gpu_layers,
                use_mmap=self.config.use_mmap,
                use_mlock=self.config.use_mlock,
                temperature=self.config.temperature,
                top_p=self.config.top_p,
                repeat_penalty=self.config.repeat_penalty,
                max_tokens=self.config.max_tokens,
                verbose=False,
                streaming=False,
            )

            self._available = True
            self._last_error = None
            logger.info(f"Local LLM loaded successfully on {self.device_info.device}")

        except ImportError as e:
            self._last_error = f"llama-cpp-python not installed: {str(e)}"
            self._available = False
            raise LLMProviderError(self._last_error) from e
        except Exception as e:
            self._last_error = f"Failed to load LLM: {str(e)}"
            self._available = False
            raise LLMProviderError(self._last_error) from e

    def get_llm(self) -> Any:
        self.ensure_ready()
        return self._llm

    def status(self) -> dict[str, Any]:
        return {
            "available": self._available,
            "model_name": self.config.model_name,
            "model_path": str(self.config.model_path),
            "model_exists": self.config.model_path.exists(),
            "quantization": self.config.quant_level,
            "device": self.device_info.device,
            "device_info": {
                "has_cuda": self.device_info.has_cuda,
                "has_metal": self.device_info.has_metal,
                "cpu_cores": self.device_info.cpu_cores,
                "total_memory_gb": self.device_info.total_memory_gb,
            },
            "config": {
                "n_ctx": self.config.n_ctx,
                "n_threads": self.config.n_threads,
                "n_gpu_layers": self.config.n_gpu_layers,
                "temperature": self.config.temperature,
                "max_tokens": self.config.max_tokens,
            },
            "last_error": self._last_error,
        }
