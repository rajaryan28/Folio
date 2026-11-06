import re
from functools import lru_cache

from pydantic import SecretStr, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    database_url: str = "postgresql+asyncpg://folio:folio@localhost:5432/folio"

    openai_api_key: SecretStr = SecretStr("")
    openai_base_url: str | None = None
    chat_model: str = "gpt-4o-mini"
    chat_temperature: float = 0.1  # negative = don't send the parameter
    embedding_model: str = "text-embedding-3-small"
    embedding_dim: int = 1536

    chunk_size: int = 1000
    chunk_overlap: int = 150
    retrieval_k: int = 6
    min_similarity: float = 0.15
    fts_config: str = "english"

    max_upload_mb: int = 25
    history_turns: int = 3

    @field_validator("fts_config")
    @classmethod
    def _safe_config(cls, v: str) -> str:
        # Interpolated into DDL/SQL as a regconfig literal, so keep it strict.
        if not re.fullmatch(r"[a-z_]+", v):
            raise ValueError("FTS_CONFIG must be a Postgres text search configuration name")
        return v

    @field_validator("openai_base_url", mode="before")
    @classmethod
    def _blank_to_none(cls, v):
        return v or None

    @property
    def async_database_url(self) -> str:
        url = self.database_url
        for prefix in ("postgresql://", "postgres://"):
            if url.startswith(prefix):
                return "postgresql+asyncpg://" + url[len(prefix):]
        return url


@lru_cache
def get_settings() -> Settings:
    return Settings()
