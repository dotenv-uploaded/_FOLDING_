import uuid

from sqlmodel import Session

from app import crud
from app.models import User
from tests.utils.utils import mint_supabase_token, random_email


def create_random_user(db: Session) -> User:
    return crud.get_or_create_user(
        session=db, user_id=uuid.uuid4(), email=random_email()
    )


def user_authentication_headers(*, user: User) -> dict[str, str]:
    token = mint_supabase_token(user_id=user.id, email=user.email)
    return {"Authorization": f"Bearer {token}"}


def authentication_token_from_email(*, email: str, db: Session) -> dict[str, str]:
    """Return valid auth headers for the user with the given email, creating
    the local profile row first if it doesn't exist yet.
    """
    user = crud.get_user_by_email(session=db, email=email)
    if not user:
        user = crud.get_or_create_user(session=db, user_id=uuid.uuid4(), email=email)
    return user_authentication_headers(user=user)
