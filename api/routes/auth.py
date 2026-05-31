"""auth.py"""
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from pydantic import BaseModel
from datetime import datetime, timedelta
import bcrypt as _bcrypt
from jose import jwt
from core.database import get_db, User
from core.config import settings

router = APIRouter()

def _hash_password(password: str) -> str:
    return _bcrypt.hashpw(password.encode(), _bcrypt.gensalt()).decode()

def _verify_password(password: str, hashed: str) -> bool:
    return _bcrypt.checkpw(password.encode(), hashed.encode())

class LoginRequest(BaseModel):
    username: str
    password: str

class ChangePasswordRequest(BaseModel):
    current_password: str
    new_password: str

def create_token(user_id: int, username: str, role: str) -> str:
    expire = datetime.utcnow() + timedelta(minutes=settings.access_token_expire_minutes)
    return jwt.encode(
        {"sub": str(user_id), "username": username, "role": role, "exp": expire},
        settings.secret_key, algorithm="HS256"
    )

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
        "role": user.role,
    }

@router.post("/change-password")
async def change_password(data: ChangePasswordRequest, db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(User).where(User.username == "admin"))
    user = result.scalar_one_or_none()
    if not user or not _verify_password(data.current_password, user.hashed_password):
        raise HTTPException(400, "Current password is incorrect")
    user.hashed_password = _hash_password(data.new_password)
    await db.commit()
    return {"message": "Password changed successfully"}
