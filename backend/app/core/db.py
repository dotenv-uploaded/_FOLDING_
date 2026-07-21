from sqlmodel import create_engine

# make sure all SQLModel models are imported (app.models) before initializing DB
# otherwise, SQLModel might fail to initialize relationships properly
# for more details: https://github.com/fastapi/full-stack-fastapi-template/issues/28
from app import models  # noqa: F401
from app.core.config import settings

engine = create_engine(
    str(settings.SQLALCHEMY_DATABASE_URI),
    connect_args={"sslmode": settings.POSTGRES_SSLMODE},
)

# Tables are managed with Alembic migrations (see `alembic upgrade head`).
# There's no local superuser to seed: accounts are created through Supabase
# Auth, and a `User` profile row is auto-provisioned on that user's first
# authenticated request (see app.crud.get_or_create_user). To grant admin
# rights, sign up normally, then set is_superuser=True on that row (e.g. via
# `PATCH /api/v1/users/{id}` from an existing superuser, or a one-off SQL
# update the first time).
