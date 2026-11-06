from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field


class DocumentOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    filename: str
    size_bytes: int
    pages: int | None
    chunk_count: int
    created_at: datetime


class UploadItem(BaseModel):
    filename: str
    status: Literal["added", "duplicate", "failed"]
    document: DocumentOut | None = None
    error: str | None = None


class UploadResponse(BaseModel):
    results: list[UploadItem]


class Turn(BaseModel):
    role: Literal["user", "assistant"]
    content: str = Field(max_length=12000)


class ChatRequest(BaseModel):
    question: str = Field(min_length=1, max_length=4000)
    history: list[Turn] = Field(default_factory=list, max_length=40)
    document_ids: list[int] | None = None
