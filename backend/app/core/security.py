from typing import Any

import jwt

from app.core.config import settings

ALGORITHM = "HS256"


def decode_supabase_token(token: str) -> dict[str, Any]:
    """Verify a Supabase Auth access token and return its claims.

    Supabase signs user JWTs with the project's JWT secret (HS256) and sets
    `aud="authenticated"` for logged-in users. Raises jwt.PyJWTError on any
    invalid/expired/mis-signed token.
    """
    return jwt.decode(
        token,
        settings.SUPABASE_JWT_SECRET,
        algorithms=[ALGORITHM],
        audience="authenticated",
    )
