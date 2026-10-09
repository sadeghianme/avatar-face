from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, ConfigDict, EmailStr, Field, field_validator
from pydantic_core import PydanticCustomError


def no_nul(password: str) -> str:
    """bcrypt would read a NUL byte as the end of the password
    (core.security.hash_password refuses one): a 422 here, not a 500."""
    if "\x00" in password:
        raise PydanticCustomError("password_nul", "A password cannot contain a NUL character")
    return password


class RegisterRequest(BaseModel):
    email: EmailStr
    username: str = Field(min_length=3, max_length=64, pattern=r"^[a-zA-Z0-9_.-]+$")
    password: str = Field(min_length=8, max_length=128)
    display_name: str = Field(default="", max_length=128)

    @field_validator("password")
    @classmethod
    def password_has_no_nul(cls, value: str) -> str:
        return no_nul(value)


class LoginRequest(BaseModel):
    username_or_email: str
    password: str


class AccessToken(BaseModel):
    """A session's access token, for the Authorization header, kept in
    memory by the dashboard. Its refresh token is never in a body: it is the
    httpOnly cookie the same response sets (api.auth)."""

    access_token: str
    token_type: str = "bearer"
    # Seconds the access token is good for.
    expires_in: int


class UserOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    email: str
    username: str
    display_name: str
    created_at: datetime
