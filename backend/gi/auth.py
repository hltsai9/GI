"""Sign-in and roles. Company SSO (OIDC) is not wired yet; with DEV_AUTH=true the X-Dev-User header
names a seeded user."""
from __future__ import annotations

from dataclasses import dataclass

from fastapi import Depends, Request

from .config import config
from .db import connect, one


class HttpError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status
        self.message = message


@dataclass
class User:
    id: int
    name: str
    role: str  # floor | lead | viewer | admin


def current_user(request: Request) -> User:
    if not config.DEV_AUTH:
        raise HttpError(401, "SSO sign-in is not configured yet (set DEV_AUTH=true for development)")
    subject = request.headers.get("x-dev-user") or "dev-lead"
    with connect() as conn:
        u = one(conn, "SELECT id, name, role FROM app_user WHERE sso_subject = ? AND active", [subject])
    if not u:
        raise HttpError(401, f"unknown user {subject}")
    return User(**u)


def require_role(*roles: str):
    def check(user: User = Depends(current_user)) -> User:
        if user.role != "admin" and user.role not in roles:
            raise HttpError(403, f"needs role {' or '.join(roles)}")
        return user
    return check
