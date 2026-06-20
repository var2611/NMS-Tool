"""auth.py — authentication, JWT, current-user deps, and user management."""
from fastapi import APIRouter, Depends, HTTPException, Header
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from pydantic import BaseModel
from typing import Optional, List
from datetime import datetime, timedelta
import bcrypt as _bcrypt
from jose import jwt, JWTError
from core.database import get_db, User
from core.config import settings

router = APIRouter()


# ─── Password helpers ─────────────────────────────────────────────────────────

def _hash_password(password: str) -> str:
    return _bcrypt.hashpw(password.encode(), _bcrypt.gensalt()).decode()

def _verify_password(password: str, hashed: str) -> bool:
    try:
        return _bcrypt.checkpw(password.encode(), hashed.encode())
    except Exception:
        return False


# ─── JWT ──────────────────────────────────────────────────────────────────────

def create_token(user_id: int, username: str, role: str) -> str:
    expire = datetime.utcnow() + timedelta(minutes=settings.access_token_expire_minutes)
    return jwt.encode(
        {"sub": str(user_id), "username": username, "role": role, "exp": expire},
        settings.secret_key, algorithm="HS256"
    )


# ─── Current-user dependencies ────────────────────────────────────────────────

async def get_current_user(
    authorization: Optional[str] = Header(None),
    db: AsyncSession = Depends(get_db),
) -> User:
    """Decode the Bearer token and return the live User row."""
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(401, "Missing or invalid Authorization header")
    token = authorization.split(" ", 1)[1]
    try:
        payload = jwt.decode(token, settings.secret_key, algorithms=["HS256"])
        user_id = int(payload.get("sub"))
    except (JWTError, ValueError, TypeError):
        raise HTTPException(401, "Invalid or expired token")

    result = await db.execute(select(User).where(User.id == user_id, User.is_active == True))
    user = result.scalar_one_or_none()
    if not user:
        raise HTTPException(401, "User not found or deactivated")
    return user


async def require_admin(user: User = Depends(get_current_user)) -> User:
    """Allow only admin users through."""
    if user.role != "admin":
        raise HTTPException(403, "Admin privileges required")
    return user


# ─── Schemas ──────────────────────────────────────────────────────────────────

class LoginRequest(BaseModel):
    username: str
    password: str

class ChangePasswordRequest(BaseModel):
    current_password: str
    new_password: str

class UserCreate(BaseModel):
    username: str
    password: str
    full_name: Optional[str] = None
    email: Optional[str] = None
    role: str = "viewer"                  # admin | operator | viewer
    allowed_sites: Optional[List[str]] = None

class UserUpdate(BaseModel):
    full_name: Optional[str] = None
    email: Optional[str] = None
    role: Optional[str] = None
    allowed_sites: Optional[List[str]] = None
    is_active: Optional[bool] = None

class ResetPasswordRequest(BaseModel):
    new_password: str

class VerifyPasswordRequest(BaseModel):
    password: str


def _user_out(u: User) -> dict:
    return {
        "id": u.id,
        "username": u.username,
        "full_name": u.full_name,
        "email": u.email,
        "role": u.role,
        "allowed_sites": u.allowed_sites or [],
        "is_active": u.is_active,
        "created_at": u.created_at.isoformat() if u.created_at else None,
        "last_login": u.last_login.isoformat() if u.last_login else None,
    }


# ─── Auth endpoints ───────────────────────────────────────────────────────────

@router.post("/login")
async def login(data: LoginRequest, db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(User).where(User.username == data.username, User.is_active == True))
    user = result.scalar_one_or_none()
    if not user or not _verify_password(data.password, user.hashed_password):
        raise HTTPException(401, "Invalid username or password")
    user.last_login = datetime.utcnow()
    await db.commit()
    return {
        "access_token": create_token(user.id, user.username, user.role),
        "token_type": "bearer",
        "username": user.username,
        "full_name": user.full_name,
        "role": user.role,
        "allowed_sites": user.allowed_sites or [],
    }


@router.post("/verify-admin-password")
async def verify_admin_password(data: VerifyPasswordRequest, db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(User).where(User.username == "admin", User.is_active == True))
    user = result.scalar_one_or_none()
    if not user or not _verify_password(data.password, user.hashed_password):
        raise HTTPException(401, "Incorrect password")
    return {"success": True}


@router.get("/me")
async def get_me(user: User = Depends(get_current_user)):
    return _user_out(user)


@router.post("/change-password")
async def change_password(
    data: ChangePasswordRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Change the CURRENTLY authenticated user's password."""
    if user.role == "viewer":
        raise HTTPException(403, "View-only users cannot change password")
    if not _verify_password(data.current_password, user.hashed_password):
        raise HTTPException(400, "Current password is incorrect")
    if len(data.new_password) < 4:
        raise HTTPException(400, "New password too short (min 4 characters)")
    user.hashed_password = _hash_password(data.new_password)
    await db.commit()
    return {"message": "Password changed successfully"}


# ─── User management (admin only) ─────────────────────────────────────────────

@router.get("/users")
async def list_users(_admin: User = Depends(require_admin), db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(User).order_by(User.username))
    return [_user_out(u) for u in result.scalars().all()]


@router.post("/users", status_code=201)
async def create_user(data: UserCreate, _admin: User = Depends(require_admin), db: AsyncSession = Depends(get_db)):
    if data.role not in ("admin", "operator", "viewer"):
        raise HTTPException(400, "Role must be admin, operator, or viewer")
    # Duplicate username check
    existing = await db.execute(select(User).where(User.username == data.username))
    if existing.scalar_one_or_none():
        raise HTTPException(400, f"Username '{data.username}' already exists")
    if len(data.password) < 4:
        raise HTTPException(400, "Password too short (min 4 characters)")

    user = User(
        username=data.username,
        hashed_password=_hash_password(data.password),
        full_name=data.full_name,
        email=data.email,
        role=data.role,
        # admins implicitly see all sites → store null
        allowed_sites=None if data.role == "admin" else (data.allowed_sites or []),
        is_active=True,
    )
    db.add(user)
    await db.commit()
    await db.refresh(user)
    return _user_out(user)


@router.put("/users/{user_id}")
async def update_user(user_id: int, data: UserUpdate, _admin: User = Depends(require_admin), db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(User).where(User.id == user_id))
    user = result.scalar_one_or_none()
    if not user:
        raise HTTPException(404, "User not found")

    if data.role is not None:
        if data.role not in ("admin", "operator", "viewer"):
            raise HTTPException(400, "Invalid role")
        user.role = data.role
        if data.role == "admin":
            user.allowed_sites = None   # admins see everything
    if data.full_name is not None:    user.full_name = data.full_name
    if data.email is not None:        user.email = data.email
    if data.allowed_sites is not None and user.role != "admin":
        user.allowed_sites = data.allowed_sites
    if data.is_active is not None:    user.is_active = data.is_active

    await db.commit()
    await db.refresh(user)
    return _user_out(user)


@router.post("/users/{user_id}/reset-password")
async def reset_password(user_id: int, data: ResetPasswordRequest, _admin: User = Depends(require_admin), db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(User).where(User.id == user_id))
    user = result.scalar_one_or_none()
    if not user:
        raise HTTPException(404, "User not found")
    if len(data.new_password) < 4:
        raise HTTPException(400, "Password too short (min 4 characters)")
    user.hashed_password = _hash_password(data.new_password)
    await db.commit()
    return {"message": f"Password reset for {user.username}"}


@router.delete("/users/{user_id}")
async def delete_user(user_id: int, admin: User = Depends(require_admin), db: AsyncSession = Depends(get_db)):
    if user_id == admin.id:
        raise HTTPException(400, "You cannot delete your own account")
    result = await db.execute(select(User).where(User.id == user_id))
    user = result.scalar_one_or_none()
    if not user:
        raise HTTPException(404, "User not found")
    # Never allow deleting the last admin
    if user.role == "admin":
        admin_count = await db.execute(select(User).where(User.role == "admin", User.is_active == True))
        if len(admin_count.scalars().all()) <= 1:
            raise HTTPException(400, "Cannot delete the last admin account")
    await db.delete(user)
    await db.commit()
    return {"message": f"User {user.username} deleted"}
