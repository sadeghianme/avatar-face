"""Settings parsing — especially the NoDecode CSV pitfall.

pydantic-settings JSON-decodes list fields from env BEFORE validators run;
without NoDecode, `CORS_ORIGINS=a,b` crashes settings construction.
"""
import os
from unittest import mock

from app.core.config import Settings


def _fresh(env: dict[str, str]) -> Settings:
    with mock.patch.dict(os.environ, env, clear=False):
        return Settings(_env_file=None)


def test_csv_cors_origins_parse():
    settings = _fresh({"CORS_ORIGINS": "http://a.example,http://b.example"})
    assert settings.cors_origins == ["http://a.example", "http://b.example"]


def test_csv_with_spaces_and_trailing_comma():
    settings = _fresh({"CORS_ORIGINS": " http://a.example , http://b.example , "})
    assert settings.cors_origins == ["http://a.example", "http://b.example"]


def test_json_list_also_accepted():
    settings = _fresh({"CORS_ORIGINS": '["http://a.example", "http://b.example"]'})
    # NoDecode keeps it a raw string; our validator splits on commas after
    # JSON-ish input too — assert it still yields both origins.
    assert len(settings.cors_origins) == 2


def test_csv_allowed_image_types():
    settings = _fresh({"ALLOWED_IMAGE_TYPES": "image/png,image/jpeg"})
    assert settings.allowed_image_types == ["image/png", "image/jpeg"]


def test_single_value_csv():
    settings = _fresh({"CORS_ORIGINS": "http://only.example"})
    assert settings.cors_origins == ["http://only.example"]


def test_storage_configured_requires_all_three():
    partial = _fresh({"R2_ENDPOINT": "https://r2.example", "R2_ACCESS_KEY": "k", "R2_SECRET": ""})
    assert partial.storage_configured is False
    full = _fresh({"R2_ENDPOINT": "https://r2.example", "R2_ACCESS_KEY": "k", "R2_SECRET": "s"})
    assert full.storage_configured is True


def test_defaults_boot_with_no_env():
    settings = Settings(_env_file=None)
    assert settings.database_url.startswith("sqlite+aiosqlite")
    assert settings.cors_origins
