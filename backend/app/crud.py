import uuid

from sqlmodel import Session, select

from app.models import Item, ItemCreate, User, UserUpdate


def get_user_by_email(*, session: Session, email: str) -> User | None:
    statement = select(User).where(User.email == email)
    session_user = session.exec(statement).first()
    return session_user


def get_or_create_user(*, session: Session, user_id: uuid.UUID, email: str) -> User:
    """Fetch the local profile row for a Supabase-authenticated user,
    creating it on first sight. Supabase Auth is the source of truth for the
    account itself (id, email, password) — this row only holds app-local
    fields (is_superuser, full_name, ...).
    """
    user = session.get(User, user_id)
    if user:
        if user.email != email:
            user.email = email
            session.add(user)
            session.commit()
            session.refresh(user)
        return user

    user = User(id=user_id, email=email)
    session.add(user)
    session.commit()
    session.refresh(user)
    return user


def update_user(*, session: Session, db_user: User, user_in: UserUpdate) -> User:
    user_data = user_in.model_dump(exclude_unset=True)
    db_user.sqlmodel_update(user_data)
    session.add(db_user)
    session.commit()
    session.refresh(db_user)
    return db_user


def create_item(*, session: Session, item_in: ItemCreate, owner_id: uuid.UUID) -> Item:
    db_item = Item.model_validate(item_in, update={"owner_id": owner_id})
    session.add(db_item)
    session.commit()
    session.refresh(db_item)
    return db_item
