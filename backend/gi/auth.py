"""Sign-in and roles. Company SSO (OIDC) is not wired yet; with DEV_AUTH=true the X-Dev-User header
names a seeded user."""
from __future__ import annotations

import hashlib
import hmac
import time
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
    if u["role"] == "admin" and not _valid_admin_token(subject, request.headers.get("x-admin-token")):
        raise HttpError(401, "admin is locked: unlock it with the passcode in Settings › This device")
    return User(**u)


def _key() -> bytes:
    return hashlib.sha256(b"gi-admin-token:" + (config.ADMIN_PASSCODE or "").encode()).digest()


def _sign(subject: str, expires: int) -> str:
    return hmac.new(_key(), f"{subject}:{expires}".encode(), hashlib.sha256).hexdigest()


def admin_token(subject: str = "dev-admin", hours: int | None = None) -> str:
    expires = int(time.time()) + 3600 * (hours or config.ADMIN_TOKEN_HOURS)
    return f"{expires}.{_sign(subject, expires)}"


def _valid_admin_token(subject: str, token: str | None) -> bool:
    if not config.ADMIN_PASSCODE or not token or "." not in token:
        return False
    expires, sig = token.split(".", 1)
    return expires.isdigit() and int(expires) > time.time() and hmac.compare_digest(sig, _sign(subject, int(expires)))


def unlock_admin(passcode: str) -> dict:
    """Checks the admin passcode (dev sign-in) and returns a signed token for the dev admin."""
    if not config.DEV_AUTH:
        raise HttpError(404, "not found")
    if not config.ADMIN_PASSCODE:
        raise HttpError(403, "Admin is locked on this site: no passcode is configured (setting ADMIN_PASSCODE).")
    if not hmac.compare_digest(passcode.encode(), config.ADMIN_PASSCODE.encode()):
        time.sleep(1)  # slows down guessing
        raise HttpError(403, "Wrong passcode.")
    token = admin_token()
    return {"token": token, "expires": int(token.split(".", 1)[0])}


def require_role(*roles: str):
    def check(user: User = Depends(current_user)) -> User:
        if user.role != "admin" and user.role not in roles:
            raise HttpError(403, f"needs role {' or '.join(roles)}")
        return user
    return check
