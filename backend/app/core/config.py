"""Application settings.

Everything has a working default so the app boots with zero configuration:
SQLite for the database, an HMAC-signed local-filesystem storage fallback,
and the always-on offline TTS provider.
"""
from __future__ import annotations

from functools import lru_cache
from pathlib import Path
from typing import Annotated

from pydantic import field_validator
from pydantic_settings import BaseSettings, NoDecode, SettingsConfigDict

BACKEND_DIR = Path(__file__).resolve().parents[2]


def _split_csv(value: str | list[str]) -> list[str]:
    if isinstance(value, list):
        return [item.strip() for item in value if item.strip()]
    value = value.strip()
    if value.startswith("["):  # JSON-style list still works alongside CSV
        import json

        try:
            return [str(item).strip() for item in json.loads(value)]
        except ValueError:
            pass
    return [item.strip() for item in value.split(",") if item.strip()]


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=str(BACKEND_DIR / ".env"),
        env_file_encoding="utf-8",
        extra="ignore",
    )

    # --- Core ---
    app_name: str = "Liveface"
    environment: str = "development"
    debug: bool = False
    # Public origin of this API; embedded third-party pages need ABSOLUTE URLs
    # for textures/audio, so storage URLs are built from this base.
    public_base_url: str = "http://localhost:7002"

    # --- Database ---
    database_url: str = f"sqlite+aiosqlite:///{BACKEND_DIR / 'liveface.sqlite3'}"

    # --- Auth ---
    jwt_secret: str = "dev-only-change-me"

    # --- Transactional email (password reset) ---
    resend_api_key: str | None = None
    # Must be on a domain verified in Resend, or delivery is rejected.
    email_from: str | None = None
    # Where the reset link points — the dashboard, not the API.
    app_base_url: str = "http://localhost:5174"
    jwt_algorithm: str = "HS256"
    access_token_minutes: int = 15
    refresh_token_days: int = 30

    # --- CORS (dashboard origins; /embed/* has its own reflective CORS) ---
    # NoDecode: pydantic-settings JSON-decodes list fields from .env BEFORE
    # validators run, so a plain `CORS_ORIGINS=a,b` would crash settings
    # construction without it.
    cors_origins: Annotated[list[str], NoDecode] = ["http://localhost:5174"]

    # --- Storage (Cloudflare R2 / any S3). All three set => S3 mode. ---
    r2_endpoint: str | None = None
    r2_access_key: str | None = None
    r2_secret: str | None = None
    r2_bucket: str = "liveface"
    r2_region: str = "auto"
    local_storage_dir: str = str(BACKEND_DIR / "local_storage")
    presign_expiry_seconds: int = 3600

    # --- Uploads ---
    allowed_image_types: Annotated[list[str], NoDecode] = [
        "image/jpeg",
        "image/png",
        "image/webp",
    ]
    max_upload_bytes: int = 10 * 1024 * 1024

    # --- Rig ---
    rig_model_path: str | None = None  # MediaPipe FaceLandmarker .task file
    # MediaPipe selfie segmenter .tflite. Unset simply disables background
    # removal; nothing else depends on it.
    segment_model_path: str | None = None
    # Kokoro local TTS. Set by the Dockerfile; absent in dev unless downloaded.
    kokoro_model_path: str | None = None
    kokoro_voices_path: str | None = None

    # --- 3D avatars: hosts allowed for GLB imports by URL (SSRF guard).
    # Ready Player Me shut down Jan 2026; Avaturn et al. are compatible. ---
    model_url_hosts: Annotated[list[str], NoDecode] = [
        "api.avaturn.me",
        "assets.avaturn.me",
        "models.readyplayer.me",  # kept for self-hosted RPM archives
    ]

    # --- TTS provider keys (env-level; the dashboard can override via DB) ---
    azure_speech_key: str | None = None
    azure_speech_region: str | None = None
    elevenlabs_api_key: str | None = None
    google_tts_credentials_json: str | None = None
    openai_api_key: str | None = None
    # Avatar image generation (Gemini image-to-image).
    gemini_api_key: str | None = None

    # --- Credentials encryption (Fernet). Falls back to a key derived from
    # jwt_secret so encrypted-at-rest works out of the box. ---
    credential_encryption_key: str | None = None

    # --- Embed API ---
    embed_rate_limit_per_minute: int = 60

    # --- Usage ---
    monthly_char_limit: int = 100_000

    # Image generation is metered per image and is the one feature here that
    # can run up a real bill by being clicked twice.
    image_generation_monthly_limit: int = 100
    # An ESTIMATE used only for the dashboard figure — set it to your provider's
    # actual per-image rate. Nothing bills from this; it exists so the number
    # on screen means something rather than being a bare count.
    image_generation_cost_usd: float = 0.04

    # Staged and generated images nobody kept. A day is far longer than any
    # real editing session and still bounds the pile; 0 disables the sweep.
    candidate_retention_hours: int = 24
    candidate_sweep_interval_minutes: int = 60

    @property
    def storage_configured(self) -> bool:
        return all((self.r2_endpoint, self.r2_access_key, self.r2_secret))

    @field_validator("cors_origins", "allowed_image_types", "model_url_hosts", mode="before")
    @classmethod
    def _decode_csv(cls, value: object) -> list[str]:
        if isinstance(value, (str, list)):
            return _split_csv(value)
        raise ValueError("expected a comma-separated string or a list")


@lru_cache
def get_settings() -> Settings:
    return Settings()
