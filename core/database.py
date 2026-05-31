from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine, async_sessionmaker
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship
from sqlalchemy import String, Integer, Float, Boolean, DateTime, Text, JSON, ForeignKey, Enum
from datetime import datetime
from typing import Optional, List
import enum
from core.config import settings

# ─── Engine & Session ────────────────────────────────────────────────────────

engine = create_async_engine(
    settings.get_database_url,
    echo=settings.debug,
    future=True
)

AsyncSessionLocal = async_sessionmaker(engine, expire_on_commit=False)

async def get_db():
    async with AsyncSessionLocal() as session:
        try:
            yield session
            await session.commit()
        except Exception:
            await session.rollback()
            raise

# ─── Base ─────────────────────────────────────────────────────────────────────

class Base(DeclarativeBase):
    pass

# ─── Enums ────────────────────────────────────────────────────────────────────

class DeviceStatus(str, enum.Enum):
    online = "online"
    offline = "offline"
    warning = "warning"
    unknown = "unknown"

class DeviceType(str, enum.Enum):
    pc = "pc"
    laptop = "laptop"
    printer = "printer"
    rf_link = "rf_link"
    router = "router"
    switch = "switch"
    access_point = "access_point"
    server = "server"
    unknown = "unknown"

class AlertSeverity(str, enum.Enum):
    info = "info"
    warning = "warning"
    critical = "critical"

class AlertStatus(str, enum.Enum):
    new = "new"
    acknowledged = "acknowledged"
    resolved = "resolved"

class SnmpVersion(str, enum.Enum):
    v1 = "v1"
    v2c = "v2c"
    v3 = "v3"

class SyncStatus(str, enum.Enum):
    pending = "pending"
    synced = "synced"
    failed = "failed"

# ─── Models ───────────────────────────────────────────────────────────────────

class Device(Base):
    __tablename__ = "devices"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    name: Mapped[str] = mapped_column(String(200))
    ip_address: Mapped[str] = mapped_column(String(45), unique=True, index=True)
    mac_address: Mapped[Optional[str]] = mapped_column(String(17), nullable=True)
    device_type: Mapped[DeviceType] = mapped_column(Enum(DeviceType), default=DeviceType.unknown)
    status: Mapped[DeviceStatus] = mapped_column(Enum(DeviceStatus), default=DeviceStatus.unknown)
    
    # SNMP
    snmp_version: Mapped[SnmpVersion] = mapped_column(Enum(SnmpVersion), default=SnmpVersion.v2c)
    snmp_community: Mapped[str] = mapped_column(String(100), default="public")
    snmp_port: Mapped[int] = mapped_column(Integer, default=161)
    snmp_v3_username: Mapped[Optional[str]] = mapped_column(String(100), nullable=True)
    snmp_v3_auth_key: Mapped[Optional[str]] = mapped_column(String(200), nullable=True)
    snmp_v3_priv_key: Mapped[Optional[str]] = mapped_column(String(200), nullable=True)
    
    # Device info (from SNMP)
    sys_descr: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    sys_object_id: Mapped[Optional[str]] = mapped_column(String(200), nullable=True)
    sys_name: Mapped[Optional[str]] = mapped_column(String(200), nullable=True)
    sys_location: Mapped[Optional[str]] = mapped_column(String(200), nullable=True)
    sys_contact: Mapped[Optional[str]] = mapped_column(String(200), nullable=True)
    vendor: Mapped[Optional[str]] = mapped_column(String(100), nullable=True)
    model: Mapped[Optional[str]] = mapped_column(String(100), nullable=True)
    firmware: Mapped[Optional[str]] = mapped_column(String(100), nullable=True)
    
    # Monitoring
    poll_interval: Mapped[int] = mapped_column(Integer, default=300)  # seconds
    last_seen: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    last_polled: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    uptime_seconds: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    consecutive_failures: Mapped[int] = mapped_column(Integer, default=0)
    
    # Meta
    notes: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    tags: Mapped[Optional[dict]] = mapped_column(JSON, nullable=True)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    auto_discovered: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)
    
    # Sync
    sync_status: Mapped[SyncStatus] = mapped_column(Enum(SyncStatus), default=SyncStatus.pending)
    synced_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)

    # Relationships
    metrics: Mapped[List["DeviceMetric"]] = relationship("DeviceMetric", back_populates="device", cascade="all, delete-orphan")
    alerts: Mapped[List["Alert"]] = relationship("Alert", back_populates="device", cascade="all, delete-orphan")
    traps: Mapped[List["TrapEvent"]] = relationship("TrapEvent", back_populates="device", cascade="all, delete-orphan")


class DeviceMetric(Base):
    __tablename__ = "device_metrics"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    device_id: Mapped[int] = mapped_column(Integer, ForeignKey("devices.id"), index=True)
    timestamp: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, index=True)
    
    # Common metrics
    cpu_percent: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    memory_percent: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    disk_percent: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    
    # Interface/bandwidth
    interface_name: Mapped[Optional[str]] = mapped_column(String(100), nullable=True)
    bytes_in: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    bytes_out: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    bandwidth_in_mbps: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    bandwidth_out_mbps: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    
    # RF Link specific
    signal_dbm: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    noise_dbm: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    signal_quality: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    ccq_percent: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    
    # Printer specific
    toner_percent: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    paper_percent: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    
    # Extra custom metrics (from MIBs)
    custom_metrics: Mapped[Optional[dict]] = mapped_column(JSON, nullable=True)
    
    # Relationships
    device: Mapped["Device"] = relationship("Device", back_populates="metrics")


class TrapEvent(Base):
    __tablename__ = "trap_events"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    device_id: Mapped[Optional[int]] = mapped_column(Integer, ForeignKey("devices.id"), nullable=True)
    timestamp: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, index=True)
    
    source_ip: Mapped[str] = mapped_column(String(45), index=True)
    snmp_version: Mapped[str] = mapped_column(String(10))
    community: Mapped[Optional[str]] = mapped_column(String(100), nullable=True)
    
    trap_oid: Mapped[str] = mapped_column(String(500))
    trap_name: Mapped[Optional[str]] = mapped_column(String(200), nullable=True)
    trap_description: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    plain_english: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    
    severity: Mapped[AlertSeverity] = mapped_column(Enum(AlertSeverity), default=AlertSeverity.info)
    raw_data: Mapped[Optional[dict]] = mapped_column(JSON, nullable=True)
    
    rule_matched: Mapped[Optional[str]] = mapped_column(String(200), nullable=True)
    action_taken: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    
    sync_status: Mapped[SyncStatus] = mapped_column(Enum(SyncStatus), default=SyncStatus.pending)

    device: Mapped[Optional["Device"]] = relationship("Device", back_populates="traps")


class Alert(Base):
    __tablename__ = "alerts"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    device_id: Mapped[Optional[int]] = mapped_column(Integer, ForeignKey("devices.id"), nullable=True)
    timestamp: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, index=True)
    
    title: Mapped[str] = mapped_column(String(300))
    message: Mapped[str] = mapped_column(Text)
    severity: Mapped[AlertSeverity] = mapped_column(Enum(AlertSeverity), default=AlertSeverity.info)
    status: Mapped[AlertStatus] = mapped_column(Enum(AlertStatus), default=AlertStatus.new)
    
    source: Mapped[str] = mapped_column(String(100), default="polling")  # polling, trap, manual
    metric_name: Mapped[Optional[str]] = mapped_column(String(100), nullable=True)
    metric_value: Mapped[Optional[str]] = mapped_column(String(100), nullable=True)
    threshold: Mapped[Optional[str]] = mapped_column(String(100), nullable=True)
    
    acknowledged_by: Mapped[Optional[str]] = mapped_column(String(100), nullable=True)
    acknowledged_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    resolved_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    notes: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    
    sync_status: Mapped[SyncStatus] = mapped_column(Enum(SyncStatus), default=SyncStatus.pending)

    device: Mapped[Optional["Device"]] = relationship("Device", back_populates="alerts")


class TrapRule(Base):
    __tablename__ = "trap_rules"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    name: Mapped[str] = mapped_column(String(200))
    description: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    is_enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    
    # Matching
    trap_oid_pattern: Mapped[str] = mapped_column(String(500))
    source_ip_pattern: Mapped[Optional[str]] = mapped_column(String(100), nullable=True)
    device_type_filter: Mapped[Optional[str]] = mapped_column(String(50), nullable=True)
    
    # Classification
    severity: Mapped[AlertSeverity] = mapped_column(Enum(AlertSeverity), default=AlertSeverity.info)
    plain_english_template: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    
    # Actions
    create_alert: Mapped[bool] = mapped_column(Boolean, default=True)
    send_email: Mapped[bool] = mapped_column(Boolean, default=False)
    send_webhook: Mapped[bool] = mapped_column(Boolean, default=False)
    play_sound: Mapped[bool] = mapped_column(Boolean, default=False)
    
    # Suppression
    suppress_start_hour: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    suppress_end_hour: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    
    # Escalation
    escalate_after_count: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    escalate_within_minutes: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    escalate_to_severity: Mapped[Optional[str]] = mapped_column(String(20), nullable=True)
    
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)


class MibFile(Base):
    __tablename__ = "mib_files"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    name: Mapped[str] = mapped_column(String(200), unique=True)
    filename: Mapped[str] = mapped_column(String(300))
    file_path: Mapped[str] = mapped_column(String(500))
    file_size: Mapped[int] = mapped_column(Integer)
    
    is_standard: Mapped[bool] = mapped_column(Boolean, default=False)
    is_enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    
    oid_count: Mapped[int] = mapped_column(Integer, default=0)
    description: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    vendor: Mapped[Optional[str]] = mapped_column(String(100), nullable=True)
    
    parsed_oids: Mapped[Optional[dict]] = mapped_column(JSON, nullable=True)
    
    uploaded_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)


class SyncQueue(Base):
    __tablename__ = "sync_queue"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    entity_type: Mapped[str] = mapped_column(String(50))  # device, trap, alert, metric
    entity_id: Mapped[int] = mapped_column(Integer)
    operation: Mapped[str] = mapped_column(String(20))  # create, update, delete
    payload: Mapped[dict] = mapped_column(JSON)
    
    attempts: Mapped[int] = mapped_column(Integer, default=0)
    last_attempt: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    status: Mapped[SyncStatus] = mapped_column(Enum(SyncStatus), default=SyncStatus.pending)
    error: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)


class User(Base):
    __tablename__ = "users"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    username: Mapped[str] = mapped_column(String(100), unique=True, index=True)
    email: Mapped[Optional[str]] = mapped_column(String(200), nullable=True)
    hashed_password: Mapped[str] = mapped_column(String(300))
    role: Mapped[str] = mapped_column(String(20), default="viewer")  # admin, viewer
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    last_login: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)


class SystemSetting(Base):
    __tablename__ = "system_settings"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    key: Mapped[str] = mapped_column(String(100), unique=True, index=True)
    value: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    description: Mapped[Optional[str]] = mapped_column(String(300), nullable=True)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)


# ─── DB Init ──────────────────────────────────────────────────────────────────

async def init_db():
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    await seed_defaults()

async def seed_defaults():
    async with AsyncSessionLocal() as session:
        from sqlalchemy import select
        # Create default admin user if not exists
        result = await session.execute(select(User).where(User.username == "admin"))
        if not result.scalar_one_or_none():
            import bcrypt as _bcrypt
            hashed = _bcrypt.hashpw(b"admin", _bcrypt.gensalt()).decode()
            admin = User(
                username="admin",
                email="admin@local",
                hashed_password=hashed,
                role="admin"
            )
            session.add(admin)

        # Seed default trap rules
        result = await session.execute(select(TrapRule).limit(1))
        if not result.scalar_one_or_none():
            default_rules = [
                TrapRule(name="Link Down", trap_oid_pattern="1.3.6.1.6.3.1.1.5.3",
                         severity=AlertSeverity.critical,
                         plain_english_template="Network interface went DOWN on {device}",
                         create_alert=True, send_email=False),
                TrapRule(name="Link Up", trap_oid_pattern="1.3.6.1.6.3.1.1.5.4",
                         severity=AlertSeverity.info,
                         plain_english_template="Network interface came back UP on {device}",
                         create_alert=True),
                TrapRule(name="Cold Start", trap_oid_pattern="1.3.6.1.6.3.1.1.5.1",
                         severity=AlertSeverity.warning,
                         plain_english_template="{device} was restarted (cold start)",
                         create_alert=True),
                TrapRule(name="Warm Start", trap_oid_pattern="1.3.6.1.6.3.1.1.5.2",
                         severity=AlertSeverity.info,
                         plain_english_template="{device} was reloaded (warm start)",
                         create_alert=True),
                TrapRule(name="Auth Failure", trap_oid_pattern="1.3.6.1.6.3.1.1.5.5",
                         severity=AlertSeverity.warning,
                         plain_english_template="Authentication failure detected on {device}",
                         create_alert=True),
            ]
            for rule in default_rules:
                session.add(rule)

        await session.commit()
