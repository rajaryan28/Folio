from pgvector.asyncpg import register_vector
from sqlalchemy import event, text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.config import get_settings
from app.models import Base

settings = get_settings()

engine = create_async_engine(settings.async_database_url, pool_pre_ping=True)


@event.listens_for(engine.sync_engine, "connect")
def _register_vector(dbapi_connection, _record):
    try:
        dbapi_connection.run_async(register_vector)
    except Exception:
        # The extension doesn't exist on the very first connection;
        # init_db() disposes the pool after creating it.
        pass


SessionLocal = async_sessionmaker(engine, expire_on_commit=False)


async def get_session():
    async with SessionLocal() as session:
        yield session


async def init_db() -> None:
    async with engine.begin() as conn:
        await conn.execute(text("CREATE EXTENSION IF NOT EXISTS vector"))
    await engine.dispose()  # new connections will now register the vector codec
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
