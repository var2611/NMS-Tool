from pydantic_settings import BaseSettings
from pydantic import Field
from typing import Optional
from pathlib import Path
import os

BASE_DIR = Path(__file__).resolve().parent.parent

class Settings(BaseSettings):
    # App
    app_mode: str = Field("desktop", env="APP_MODE")
    app_name: str = "SentinelNMS"
    app_version: str = "1.0.2"
    debug: bool = Field(False, env="DEBUG")

    # API
    api_host: str = Field("127.0.0.1", env="API_HOST")
    api_port: int = Field(8765, env="API_PORT")
    secret_key: str = Field("dev-secret-key-change-in-prod", env="SECRET_KEY")
    access_token_expire_minutes: int = Field(1440, env="ACCESS_TOKEN_EXPIRE_MINUTES")

    # Database
    sqlite_db_path: str = Field("./data/nms.db", env="SQLITE_DB_PATH")
    database_url: Optional[str] = Field(None, env="DATABASE_URL")

    # SNMP
    snmp_trap_port: int = Field(162, env="SNMP_TRAP_PORT")
    snmp_default_community: str = Field("public", env="SNMP_DEFAULT_COMMUNITY")
    snmp_timeout: int = Field(5, env="SNMP_TIMEOUT")
    snmp_retries: int = Field(2, env="SNMP_RETRIES")

    # Cloud Sync
    sync_enabled: bool = Field(False, env="SYNC_ENABLED")
    sync_server_url: Optional[str] = Field(None, env="SYNC_SERVER_URL")
    sync_api_key: Optional[str] = Field(None, env="SYNC_API_KEY")
    sync_site_name: str = Field("Desktop-Agent", env="SYNC_SITE_NAME")
    sync_interval_minutes: int = Field(5, env="SYNC_INTERVAL_MINUTES")

    # Notifications
    smtp_host: Optional[str] = Field(None, env="SMTP_HOST")
    smtp_port: int = Field(587, env="SMTP_PORT")
    smtp_user: Optional[str] = Field(None, env="SMTP_USER")
    smtp_password: Optional[str] = Field(None, env="SMTP_PASSWORD")
    smtp_from: str = Field("nms@yourdomain.com", env="SMTP_FROM")
    webhook_url: Optional[str] = Field(None, env="WEBHOOK_URL")

    # Logging
    log_level: str = Field("INFO", env="LOG_LEVEL")
    log_file: str = Field("./data/nms.log", env="LOG_FILE")

    @property
    def get_database_url(self) -> str:
        if self.database_url:
            return self.database_url
        db_path = Path(self.sqlite_db_path)
        db_path.parent.mkdir(parents=True, exist_ok=True)
        return f"sqlite+aiosqlite:///{db_path}"

    @property
    def is_desktop(self) -> bool:
        return self.app_mode == "desktop"

    @property
    def is_server(self) -> bool:
        return self.app_mode == "server"

    class Config:
        env_file = ".env"
        case_sensitive = False

settings = Settings()
