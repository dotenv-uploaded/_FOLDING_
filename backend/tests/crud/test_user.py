import uuid

from sqlmodel import Session

from app import crud
from app.models import User
from tests.utils.utils import random_email


def test_get_or_create_user_creates_new(db: Session) -> None:
    user_id = uuid.uuid4()
    email = random_email()
    user = crud.get_or_create_user(session=db, user_id=user_id, email=email)
    assert user.id == user_id
    assert user.email == email
    assert user.is_active is True
    assert user.is_superuser is False


def test_get_or_create_user_returns_existing(db: Session) -> None:
    user_id = uuid.uuid4()
    email = random_email()
    first = crud.get_or_create_user(session=db, user_id=user_id, email=email)
    second = crud.get_or_create_user(session=db, user_id=user_id, email=email)
    assert first.id == second.id


def test_get_or_create_user_syncs_changed_email(db: Session) -> None:
    user_id = uuid.uuid4()
    old_email = random_email()
    new_email = random_email()
    crud.get_or_create_user(session=db, user_id=user_id, email=old_email)
    updated = crud.get_or_create_user(session=db, user_id=user_id, email=new_email)
    assert updated.email == new_email

    user_2 = db.get(User, user_id)
    assert user_2
    assert user_2.email == new_email


def test_get_user_by_email(db: Session) -> None:
    email = random_email()
    user = crud.get_or_create_user(session=db, user_id=uuid.uuid4(), email=email)
    found = crud.get_user_by_email(session=db, email=email)
    assert found
    assert found.id == user.id
