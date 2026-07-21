import random
import string
import uuid
from datetime import UTC, datetime, timedelta

import jwt

from app.core.config import settings

# Fixed, well-known test-only account used by the `superuser_token_headers`
# fixture. Never a real Supabase user — just a local profile row.
TEST_SUPERUSER_EMAIL = "superuser@example.com"


def random_lower_string() -> str:
    return "".join(random.choices(string.ascii_lowercase, k=32))


def random_email() -> str:
    return f"{random_lower_string()}@{random_lower_string()}.com"


def mint_supabase_token(*, user_id: uuid.UUID, email: str) -> str:
    """Mint a token shaped like a Supabase Auth access token, signed with the
    same JWT secret the backend verifies against (SUPABASE_JWT_SECRET). This
    lets tests exercise auth without a live Supabase project — the backend
    can't tell the difference since it only checks the signature and claims.
    """
    now = datetime.now(UTC)
    payload = {
        "sub": str(user_id),
        "email": email,
        "aud": "authenticated",
        "role": "authenticated",
        "iat": now,
        "exp": now + timedelta(hours=1),
    }
    return jwt.encode(payload, settings.SUPABASE_JWT_SECRET, algorithm="HS256")
