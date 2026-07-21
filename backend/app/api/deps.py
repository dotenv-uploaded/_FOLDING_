import uuid
from collections.abc import Generator
from typing import Annotated

import jwt
from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlmodel import Session

from app import crud
from app.core.db import engine
from app.core.security import decode_supabase_token
from app.models import User

# Tokens are issued by Supabase Auth (supabase-js on the frontend), not by
# this backend — it only verifies them. Swagger's "Authorize" button accepts
# a raw Supabase access token here.
reusable_bearer = HTTPBearer(auto_error=False)


def get_db() -> Generator[Session]:
    with Session(engine) as session:
        yield session


SessionDep = Annotated[Session, Depends(get_db)]
TokenDep = Annotated[
    HTTPAuthorizationCredentials | None, Depends(reusable_bearer)
]


def get_current_user(session: SessionDep, token: TokenDep) -> User:
    if token is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail="Not authenticated"
        )
    try:
        payload = decode_supabase_token(token.credentials)
    except jwt.PyJWTError:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Could not validate credentials",
        )
    email = payload.get("email")
    try:
        user_id = uuid.UUID(payload.get("sub", ""))
    except ValueError:
        user_id = None
    if not user_id or not email:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Could not validate credentials",
        )
    user = crud.get_or_create_user(session=session, user_id=user_id, email=email)
    if not user.is_active:
        raise HTTPException(status_code=400, detail="Inactive user")
    return user


CurrentUser = Annotated[User, Depends(get_current_user)]


def get_current_active_superuser(current_user: CurrentUser) -> User:
    if not current_user.is_superuser:
        raise HTTPException(
            status_code=403, detail="The user doesn't have enough privileges"
        )
    return current_user
