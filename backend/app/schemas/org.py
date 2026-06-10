from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, ConfigDict, EmailStr, Field

from app.models.org import Role


class OrgCreate(BaseModel):
    name: str = Field(min_length=1, max_length=128)


class OrgUpdate(BaseModel):
    name: str = Field(min_length=1, max_length=128)


class OrgOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    name: str
    created_at: datetime


class OrgWithRole(OrgOut):
    role: Role


class MemberOut(BaseModel):
    membership_id: str
    user_id: str
    username: str
    email: str
    display_name: str
    role: Role
    joined_at: datetime


class RoleUpdate(BaseModel):
    role: Role


class InviteCreate(BaseModel):
    email: EmailStr
    role: Role = Role.member


class InviteOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    email: str
    role: Role
    token: str
    created_at: datetime
    accepted_at: datetime | None
    revoked_at: datetime | None


class InvitePublic(BaseModel):
    org_name: str
    email: str
    role: Role
