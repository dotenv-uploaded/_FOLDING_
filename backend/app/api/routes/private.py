import uuid
from typing import Any

from fastapi import APIRouter
from pydantic import BaseModel

from app.api.deps import SessionDep
from app.models import User, UserPublic

router = APIRouter(tags=["private"], prefix="/private")


class PrivateUserCreate(BaseModel):
    id: uuid.UUID
    email: str
    full_name: str | None = None
    is_superuser: bool = False


@router.post("/users/", response_model=UserPublic)
def create_user(user_in: PrivateUserCreate, session: SessionDep) -> Any:
    """
    Local-dev-only helper (mounted only when ENVIRONMENT=local) that seeds a
    local profile row directly, bypassing Supabase Auth. Useful for tests
    and fixtures where you already have a Supabase user id (real or
    fabricated) and just need the matching app-side row to exist.
    """

    user = User(
        id=user_in.id,
        email=user_in.email,
        full_name=user_in.full_name,
        is_superuser=user_in.is_superuser,
    )

    session.add(user)
    session.commit()

    return user
