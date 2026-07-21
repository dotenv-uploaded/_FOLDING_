import uuid
from collections.abc import Generator

import pytest
from fastapi.testclient import TestClient
from sqlmodel import Session, delete

from app import crud
from app.core.config import settings
from app.core.db import engine
from app.main import app
from app.models import Item, User
from tests.utils.user import (
    authentication_token_from_email,
    user_authentication_headers,
)
from tests.utils.utils import TEST_SUPERUSER_EMAIL


@pytest.fixture(scope="session", autouse=True)
def db() -> Generator[Session]:
    with Session(engine) as session:
        yield session
        statement = delete(Item)
        session.execute(statement)
        statement = delete(User)
        session.execute(statement)
        session.commit()


@pytest.fixture(scope="module")
def client() -> Generator[TestClient]:
    with TestClient(app) as c:
        yield c


@pytest.fixture(scope="module")
def superuser_token_headers(
    client: TestClient, db: Session  # noqa: ARG001 (client starts the app lifespan)
) -> dict[str, str]:
    user = crud.get_or_create_user(
        session=db, user_id=uuid.uuid4(), email=TEST_SUPERUSER_EMAIL
    )
    user.is_superuser = True
    db.add(user)
    db.commit()
    db.refresh(user)
    return user_authentication_headers(user=user)


@pytest.fixture(scope="module")
def normal_user_token_headers(
    client: TestClient, db: Session  # noqa: ARG001 (client starts the app lifespan)
) -> dict[str, str]:
    return authentication_token_from_email(email=settings.EMAIL_TEST_USER, db=db)
