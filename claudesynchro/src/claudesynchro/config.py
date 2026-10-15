"""Settings, read from environment variables (the Docker way) with CLI overrides."""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path


def _env(name: str, default: str) -> str:
    value = os.environ.get(name)
    return value.strip() if value is not None and value.strip() != "" else default


def _env_bool(name: str, default: bool) -> bool:
    return _env(name, "true" if default else "false").lower() in ("1", "true", "yes", "on")


def _env_list(name: str, default: str) -> list[str]:
    return [p.strip().lower() for p in _env(name, default).split(",") if p.strip()]


def _default_data_dir() -> Path:
    if Path("/app/data").is_dir():
        return Path("/app/data/claudesynchro")
    return Path.home() / ".cache" / "claudesynchro"


@dataclass
class Settings:
    # Which subtitle languages to synchronise (ISO 639-1).
    languages: list[str] = field(default_factory=lambda: _env_list("CLAUDESYNCHRO_LANGUAGES", "pl"))
    # Reference sources, in order of preference.
    reference_order: list[str] = field(
        default_factory=lambda: _env_list("CLAUDESYNCHRO_REFERENCE", "embedded,external,transcript")
    )
    # Preferred reference languages; "*" allows any other language afterwards.
    reference_languages: list[str] = field(
        default_factory=lambda: _env_list("CLAUDESYNCHRO_REFERENCE_LANGUAGES", "en,*")
    )
    # Check external reference subtitles against the audio before trusting them.
    verify_external: bool = field(default_factory=lambda: _env_bool("CLAUDESYNCHRO_VERIFY_EXTERNAL", True))

    # What to show in scenes that exist in the video but not in the subtitles.
    gap_fill: str = field(default_factory=lambda: _env("CLAUDESYNCHRO_GAP_FILL", "english").lower())
    gap_fill_from_transcript: bool = field(
        default_factory=lambda: _env_bool("CLAUDESYNCHRO_GAP_FILL_FROM_TRANSCRIPT", False)
    )
    gap_fill_prefix: str = field(default_factory=lambda: os.environ.get("CLAUDESYNCHRO_GAP_FILL_PREFIX", ""))
    gap_fill_min_seconds: float = field(
        default_factory=lambda: float(_env("CLAUDESYNCHRO_GAP_FILL_MIN_SECONDS", "4"))
    )

    # Refuse to write a result below this confidence (0..1).
    min_confidence: float = field(default_factory=lambda: float(_env("CLAUDESYNCHRO_MIN_CONFIDENCE", "0.5")))

    # Backends: "local" or "openrouter".
    transcriber: str = field(default_factory=lambda: _env("CLAUDESYNCHRO_TRANSCRIBER", "local").lower())
    embeddings: str = field(default_factory=lambda: _env("CLAUDESYNCHRO_EMBEDDINGS", "local").lower())

    whisper_model: str = field(default_factory=lambda: _env("WHISPER_MODEL", "base"))
    whisper_compute_type: str = field(default_factory=lambda: _env("WHISPER_COMPUTE_TYPE", "int8"))
    whisper_beam_size: int = field(default_factory=lambda: int(_env("WHISPER_BEAM_SIZE", "1")))
    threads: int = field(default_factory=lambda: int(_env("CLAUDESYNCHRO_THREADS", "0")))

    embed_model_repo: str = field(
        default_factory=lambda: _env("CLAUDESYNCHRO_EMBED_MODEL", "Xenova/paraphrase-multilingual-MiniLM-L12-v2")
    )
    embed_model_file: str = field(
        default_factory=lambda: _env("CLAUDESYNCHRO_EMBED_MODEL_FILE", "onnx/model_quantized.onnx")
    )

    openrouter_api_key: str = field(default_factory=lambda: _env("OPENROUTER_API_KEY", ""))
    openrouter_base_url: str = field(
        default_factory=lambda: _env("OPENROUTER_BASE_URL", "https://openrouter.ai/api/v1")
    )
    openrouter_model: str = field(default_factory=lambda: _env("OPENROUTER_MODEL", "anthropic/claude-haiku-5.5"))
    openrouter_transcribe_model: str = field(
        default_factory=lambda: _env("OPENROUTER_TRANSCRIBE_MODEL", "openai/whisper-large-v3")
    )
    openrouter_embed_model: str = field(default_factory=lambda: _env("OPENROUTER_EMBED_MODEL", "baai/bge-m3"))

    data_dir: Path = field(default_factory=lambda: Path(_env("CLAUDESYNCHRO_DATA_DIR", str(_default_data_dir()))))

    @property
    def models_dir(self) -> Path:
        return self.data_dir / "models"

    @property
    def cache_dir(self) -> Path:
        return self.data_dir / "cache"

    @property
    def reports_dir(self) -> Path:
        return self.data_dir / "reports"

    @property
    def cpu_threads(self) -> int:
        return self.threads if self.threads > 0 else max(1, os.cpu_count() or 1)
