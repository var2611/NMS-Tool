use sqlx::SqlitePool;
use sqlx::Row;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::time::sleep;
use tauri::{AppHandle, Emitter};

// OIDs map (snmp2 uses &[u64])
const OID_SYS_UPTIME: &[u64] = &[1, 3, 6, 1, 2, 1, 1, 3, 0];
const OID_HR_PROCESSOR_LOAD: &[u64] = &[1, 3, 6, 1, 2, 1, 25, 3, 3, 1, 2];
const OID_HR_STORAGE_DESCR: &[u64] = &[1, 3, 6, 1, 2, 1, 25, 2, 3, 1, 3];
const OID_HR_STORAGE_USED: &[u64] = &[1, 3, 6, 1, 2, 1, 25, 2, 3, 1, 6];
const OID_HR_STORAGE_SIZE: &[u64] = &[1, 3, 6, 1, 2, 1, 25, 2, 3, 1, 5];

const OID_IF_OPER_STATUS: &[u64] = &[1, 3, 6, 1, 2, 1, 2, 2, 1, 8];
const OID_IF_IN_OCTETS: &[u64] = &[1, 3, 6, 1, 2, 1, 2, 2, 1, 10];
const OID_IF_OUT_OCTETS: &[u64] = &[1, 3, 6, 1, 2, 1, 2, 2, 1, 16];
const OID_IF_DESCR: &[u64] = &[1, 3, 6, 1, 2, 1, 2, 2, 1, 2];

const OID_PRT_SUPPLY_LEVEL: &[u64] = &[1, 3, 6, 1, 2, 1, 43, 11, 1, 1, 9];
const OID_PRT_SUPPLY_MAX: &[u64] = &[1, 3, 6, 1, 2, 1, 43, 11, 1, 1, 8];
const OID_PRT_SUPPLY_DESCR: &[u64] = &[1, 3, 6, 1, 2, 1, 43, 11, 1, 1, 6];

const OID_UBNT_SIGNAL: &[u64] = &[1, 3, 6, 1, 4, 1, 41112, 1, 4, 7, 1, 3, 1];
const OID_UBNT_NOISE: &[u64] = &[1, 3, 6, 1, 4, 1, 41112, 1, 4, 7, 1, 4, 1];
const OID_UBNT_CCQ: &[u64] = &[1, 3, 6, 1, 4, 1, 41112, 1, 4, 7, 1, 13, 1];

// Structure to store interface bandwidth tracking
pub struct PrevBytes {
    pub bytes_in: u64,
    pub bytes_out: u64,
    pub time: Instant,
}

pub type BandwidthCache = Arc<Mutex<HashMap<i32, HashMap<u32, PrevBytes>>>>;

#[derive(Clone, serde::Serialize)]
pub struct InterfaceMetric {
    pub index: u32,
    pub name: String,
    pub status: String,
    pub bytes_in: u64,
    pub bytes_out: u64,
    pub in_mbps: Option<f64>,
    pub out_mbps: Option<f64>,
}

#[derive(serde::Serialize, Clone)]
pub struct SupplyMetric {
    pub name: String,
    pub level_percent: f64,
    pub level_raw: i64,
    pub max_raw: i64,
}

#[derive(serde::Serialize, Clone)]
pub struct PolledMetrics {
    pub status: String,
    pub uptime_seconds: Option<i64>,
    pub cpu_percent: Option<f64>,
    pub memory_percent: Option<f64>,
    pub disk_percent: Option<f64>,
    pub signal_dbm: Option<f64>,
    pub noise_dbm: Option<f64>,
    pub ccq_percent: Option<f64>,
    pub toner_percent: Option<f64>,
    pub interfaces: Vec<InterfaceMetric>,
    pub supplies: Vec<SupplyMetric>,
}

#[derive(Debug, Clone)]
#[allow(dead_code)]
pub enum OwnedValue {
    Integer(i64),
    OctetString(Vec<u8>),
    ObjectIdentifier(String),
    IpAddress(Vec<u8>),
    Counter(u64),
    TimeTicks(u32),
    Null,
    Other(String),
}

fn to_owned_value(val: &snmp2::Value) -> OwnedValue {
    match val {
        snmp2::Value::Integer(i) => OwnedValue::Integer(*i as i64),
        snmp2::Value::OctetString(b) => OwnedValue::OctetString(b.to_vec()),
        snmp2::Value::ObjectIdentifier(o) => OwnedValue::ObjectIdentifier(o.to_string()),
        snmp2::Value::IpAddress(ip) => OwnedValue::IpAddress(ip.to_vec()),
        snmp2::Value::Counter32(c) => OwnedValue::Counter(*c as u64),
        snmp2::Value::Unsigned32(u) => OwnedValue::Counter(*u as u64),
        snmp2::Value::Counter64(c) => OwnedValue::Counter(*c),
        snmp2::Value::Timeticks(t) => OwnedValue::TimeTicks(*t),
        snmp2::Value::Null => OwnedValue::Null,
        _ => OwnedValue::Other(format!("{:?}", val)),
    }
}

#[allow(dead_code)]
pub struct Device {
    pub id: i32,
    pub ip_address: String,
    pub name: String,
    pub snmp_community: Option<String>,
    pub snmp_version: Option<String>,
    pub snmp_port: Option<i32>,
    pub device_type: Option<String>,
    pub poll_interval: Option<i32>,
    pub consecutive_failures: Option<i32>,
    pub tags: Option<serde_json::Value>,
    pub last_polled: Option<chrono::NaiveDateTime>,
}

pub fn get_opt_int_column(row: &sqlx::sqlite::SqliteRow, col: &str) -> Option<i32> {
    row.try_get::<i32, _>(col)
        .or_else(|_| row.try_get::<i64, _>(col).map(|v| v as i32))
        .ok()
}

pub async fn start_poller(
    pool: SqlitePool,
    cache: BandwidthCache,
    api_port: u16,
    secret_token: String,
    app: AppHandle,
) {
    log::info!("Starting background SNMP Poller (connected to SQLite)...");

    loop {
        // Run a cycle of polling
        if let Err(e) = run_poll_cycle(&pool, api_port, &secret_token, &cache, &app).await {
            log::error!("Poll cycle error: {}", e);
        }
        sleep(Duration::from_secs(1)).await;
    }
}

async fn run_poll_cycle(
    pool: &SqlitePool,
    api_port: u16,
    secret_token: &str,
    cache: &BandwidthCache,
    app: &AppHandle,
) -> Result<(), sqlx::Error> {
    // 1. Fetch active devices owned locally
    let device_rows = sqlx::query(
        "SELECT id, ip_address, name, snmp_community, snmp_version, snmp_port, device_type, poll_interval, consecutive_failures, tags, last_polled FROM devices WHERE is_active = 1 AND (source != 'desktop_sync' OR source IS NULL)"
    )
    .fetch_all(pool)
    .await?;

    let mut devices = Vec::new();
    for row in device_rows {
        let id = row.try_get::<i32, _>("id")
            .or_else(|_| row.try_get::<i64, _>("id").map(|v| v as i32))
            .unwrap_or(0);
        let ip_address = row.try_get::<String, _>("ip_address").unwrap_or_default();
        let name = row.try_get::<String, _>("name").unwrap_or_default();
        let snmp_community = row.try_get::<Option<String>, _>("snmp_community").unwrap_or(None);
        let snmp_version = row.try_get::<Option<String>, _>("snmp_version").unwrap_or(None);
        let snmp_port = get_opt_int_column(&row, "snmp_port");
        let device_type = row.try_get::<Option<String>, _>("device_type").unwrap_or(None);
        let poll_interval = get_opt_int_column(&row, "poll_interval");
        let consecutive_failures = get_opt_int_column(&row, "consecutive_failures");
        let tags_str = row.try_get::<Option<String>, _>("tags").unwrap_or(None);
        let tags = tags_str.and_then(|s| serde_json::from_str(&s).ok());
        let last_polled = row.try_get::<Option<chrono::NaiveDateTime>, _>("last_polled").unwrap_or(None);

        devices.push(Device {
            id,
            ip_address,
            name,
            snmp_community,
            snmp_version,
            snmp_port,
            device_type,
            poll_interval,
            consecutive_failures,
            tags,
            last_polled,
        });
    }

    // 2. Fetch global settings
    let snmp_timeout_setting = sqlx::query("SELECT value FROM system_settings WHERE key = 'snmp_timeout'")
        .fetch_optional(pool)
        .await?
        .and_then(|row| row.try_get::<Option<String>, _>("value").unwrap_or(None))
        .and_then(|v| v.parse::<u64>().ok())
        .unwrap_or(5); // fallback to 5 seconds

    let poll_interval_setting = sqlx::query("SELECT value FROM system_settings WHERE key = 'poll_interval'")
        .fetch_optional(pool)
        .await?
        .and_then(|row| row.try_get::<Option<String>, _>("value").unwrap_or(None))
        .and_then(|v| v.parse::<i32>().ok())
        .unwrap_or(5); // fallback to 5 seconds

    let now = chrono::Utc::now().naive_utc();

    for dev in devices {
        let interval = dev.poll_interval.unwrap_or(poll_interval_setting);
        let mut should_poll = true;
        if let Some(last) = dev.last_polled {
            let elapsed = now.signed_duration_since(last).num_seconds();
            if elapsed < interval as i64 {
                should_poll = false;
            }
        }

        if should_poll {
            let pool_clone = pool.clone();
            let cache_clone = cache.clone();
            let token = secret_token.to_string();
            let app_clone = app.clone();

            tokio::spawn(async move {
                poll_device_single(pool_clone, dev.id, cache_clone, token, api_port, snmp_timeout_setting, Some(app_clone)).await;
            });
        }
    }

    Ok(())
}

pub async fn poll_device_single(
    pool: SqlitePool,
    dev_id: i32,
    cache: BandwidthCache,
    token: String,
    api_port: u16,
    timeout_secs: u64,
    app: Option<AppHandle>,
) {
    // Fetch device details
    let r = match sqlx::query("SELECT id, ip_address, name, snmp_community, snmp_version, snmp_port, device_type, poll_interval, consecutive_failures, tags FROM devices WHERE id = ?")
        .bind(dev_id)
        .fetch_optional(&pool)
        .await {
            Ok(Some(row)) => row,
            _ => {
                log::error!("Failed to fetch device details for poll: {}", dev_id);
                return;
            }
        };

    let ip = r.try_get::<String, _>("ip_address").unwrap_or_default();
    let community = r.try_get::<Option<String>, _>("snmp_community").unwrap_or(None).unwrap_or_else(|| "public".to_string());
    let version = r.try_get::<Option<String>, _>("snmp_version").unwrap_or(None).unwrap_or_else(|| "v2c".to_string());
    let port = get_opt_int_column(&r, "snmp_port").unwrap_or(161) as u16;
    let device_type = r.try_get::<Option<String>, _>("device_type").unwrap_or(None).unwrap_or_else(|| "unknown".to_string());
    let current_failures = get_opt_int_column(&r, "consecutive_failures").unwrap_or(0);
    let tags_str = r.try_get::<Option<String>, _>("tags").unwrap_or(None);
    let tags: Option<serde_json::Value> = tags_str.and_then(|s| serde_json::from_str(&s).ok());

    // Extract monitored_interfaces from tags — only poll these interfaces
    let monitored_ifaces: Vec<u32> = tags
        .as_ref()
        .and_then(|t| t.as_object())
        .and_then(|o| o.get("monitored_interfaces"))
        .and_then(|i| i.as_array())
        .map(|a| a.iter().filter_map(|v| v.as_u64()).map(|v| v as u32).collect())
        .unwrap_or_default();

    // Perform ping latency test
    let ping_ms = ping_latency(&ip, 2.0).await;

    // Perform SNMP query in blocking pool since it uses sync sessions
    let monitored_for_poll = monitored_ifaces.clone();
    let metrics_res = tokio::task::spawn_blocking(move || {
        snmp_query_device(&ip, port, &community, &version, &device_type, timeout_secs, &monitored_for_poll)
    })
    .await;

    let mut polled = match metrics_res {
        Ok(Ok(m)) => m,
        _ => PolledMetrics {
            status: "offline".to_string(),
            uptime_seconds: None,
            cpu_percent: None,
            memory_percent: None,
            disk_percent: None,
            signal_dbm: None,
            noise_dbm: None,
            ccq_percent: None,
            toner_percent: None,
            interfaces: Vec::new(),
            supplies: Vec::new(),
        },
    };

    // If ping succeeded, override status or enrich
    if ping_ms.is_some() && polled.status == "offline" {
        polled.status = "warning".to_string();
    } else if ping_ms.is_none() && polled.status == "online" {
        polled.status = "online".to_string();
    }

    // Calculate interface bandwidth deltas within a nested scope to ensure MutexGuard is dropped before await
    {
        let mut cache_lock = cache.lock().unwrap();
        let dev_cache = cache_lock.entry(dev_id).or_insert_with(HashMap::new);

        let now_instant = Instant::now();
        for iface in &mut polled.interfaces {
            let prev = dev_cache.get(&iface.index);
            if let Some(p) = prev {
                let elapsed = now_instant.duration_since(p.time).as_secs_f64();
                if elapsed > 0.0 && iface.bytes_in >= p.bytes_in && iface.bytes_out >= p.bytes_out {
                    let in_diff = iface.bytes_in - p.bytes_in;
                    let out_diff = iface.bytes_out - p.bytes_out;
                    iface.in_mbps = Some(round_val((in_diff as f64 * 8.0) / elapsed / 1_000_000.0, 3));
                    iface.out_mbps = Some(round_val((out_diff as f64 * 8.0) / elapsed / 1_000_000.0, 3));
                }
            }
            dev_cache.insert(iface.index, PrevBytes {
                bytes_in: iface.bytes_in,
                bytes_out: iface.bytes_out,
                time: now_instant,
            });
        }
    }

    // Update device details in SQLite DB
    let mut new_failures = current_failures;
    let final_status = if polled.status == "online" {
        new_failures = 0;
        "online"
    } else {
        new_failures += 1;
        if new_failures >= 3 {
            "offline"
        } else if new_failures >= 1 {
            "warning"
        } else {
            "unknown"
        }
    };

    let last_seen_update = if polled.status == "online" {
        Some(chrono::Utc::now().naive_utc())
    } else {
        None
    };

    let uptime_val = polled.uptime_seconds;
    let last_polled_now = chrono::Utc::now().naive_utc();

    let update_res = if last_seen_update.is_some() {
        sqlx::query(
            "UPDATE devices SET status = ?, consecutive_failures = ?, last_polled = ?, last_seen = ?, uptime_seconds = ? WHERE id = ?"
        )
        .bind(final_status)
        .bind(new_failures)
        .bind(last_polled_now)
        .bind(last_seen_update)
        .bind(uptime_val)
        .bind(dev_id)
        .execute(&pool)
        .await
    } else {
        sqlx::query(
            "UPDATE devices SET status = ?, consecutive_failures = ?, last_polled = ?, uptime_seconds = ? WHERE id = ?"
        )
        .bind(final_status)
        .bind(new_failures)
        .bind(last_polled_now)
        .bind(uptime_val)
        .bind(dev_id)
        .execute(&pool)
        .await
    };

    if let Err(e) = update_res {
        log::error!("Failed to update device status: {}", e);
    }

    // Parse interface metrics to dict
    let mut iface_metrics_map = serde_json::Map::new();
    for iface in &polled.interfaces {
        let mut map = serde_json::Map::new();
        map.insert("name".to_string(), serde_json::Value::String(iface.name.clone()));
        map.insert("status".to_string(), serde_json::Value::String(iface.status.clone()));
        map.insert("bytes_in".to_string(), serde_json::Value::Number(serde_json::Number::from(iface.bytes_in)));
        map.insert("bytes_out".to_string(), serde_json::Value::Number(serde_json::Number::from(iface.bytes_out)));
        if let Some(in_m) = iface.in_mbps {
            if let Some(val) = serde_json::Number::from_f64(in_m) {
                map.insert("in_mbps".to_string(), serde_json::Value::Number(val));
            }
        }
        if let Some(out_m) = iface.out_mbps {
            if let Some(val) = serde_json::Number::from_f64(out_m) {
                map.insert("out_mbps".to_string(), serde_json::Value::Number(val));
            }
        }
        iface_metrics_map.insert(iface.index.to_string(), serde_json::Value::Object(map));
    }

    // Construct custom_metrics JSON
    let mut custom_metrics_json = serde_json::Map::new();
    if let Some(p) = ping_ms {
        if let Some(val) = serde_json::Number::from_f64(p) {
            custom_metrics_json.insert("ping_ms".to_string(), serde_json::Value::Number(val));
        }
    }
    if !iface_metrics_map.is_empty() {
        custom_metrics_json.insert("interfaces".to_string(), serde_json::Value::Object(iface_metrics_map));
    }

    // Write DeviceMetric row to database
    let cpu_percent = polled.cpu_percent;
    let memory_percent = polled.memory_percent;
    let disk_percent = polled.disk_percent;
    let signal_dbm = polled.signal_dbm;
    let noise_dbm = polled.noise_dbm;
    let ccq_percent = polled.ccq_percent;
    let toner_percent = polled.toner_percent;
    let custom_metrics_val = serde_json::Value::Object(custom_metrics_json);
    let pending_sync = "pending";

    // Find primary interface for legacy columns
    let mut primary_if_name = None;
    let mut primary_bytes_in = None;
    let mut primary_bytes_out = None;
    let mut primary_in_mbps = None;
    let mut primary_out_mbps = None;

    // Use the monitored_ifaces list already extracted above

    let primary_if = if !monitored_ifaces.is_empty() {
        polled.interfaces.iter().find(|i| monitored_ifaces.contains(&i.index))
    } else {
        polled.interfaces.first()
    };

    if let Some(i) = primary_if {
        primary_if_name = Some(i.name.clone());
        primary_bytes_in = Some(i.bytes_in as i64);
        primary_bytes_out = Some(i.bytes_out as i64);
        primary_in_mbps = i.in_mbps;
        primary_out_mbps = i.out_mbps;
    }

    let timestamp_now = chrono::Utc::now().naive_utc();

    let metric_insert_res = sqlx::query(
        "INSERT INTO device_metrics (device_id, timestamp, cpu_percent, memory_percent, disk_percent, interface_name, bytes_in, bytes_out, bandwidth_in_mbps, bandwidth_out_mbps, signal_dbm, noise_dbm, toner_percent, ccq_percent, custom_metrics, sync_status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    )
    .bind(dev_id)
    .bind(timestamp_now)
    .bind(cpu_percent)
    .bind(memory_percent)
    .bind(disk_percent)
    .bind(primary_if_name)
    .bind(primary_bytes_in)
    .bind(primary_bytes_out)
    .bind(primary_in_mbps)
    .bind(primary_out_mbps)
    .bind(signal_dbm)
    .bind(noise_dbm)
    .bind(toner_percent)
    .bind(ccq_percent)
    .bind(custom_metrics_val)
    .bind(pending_sync)
    .execute(&pool)
    .await;

    if let Err(e) = metric_insert_res {
        log::error!("Failed to insert device metrics: {}", e);
    }

    // Emit native event directly to WebView UI
    if let Some(ref handle) = app {
        handle.emit("device_update", serde_json::json!({
            "device_id": dev_id,
            "status": final_status,
            "metrics": {
                "cpu_percent": cpu_percent,
                "memory_percent": memory_percent,
                "disk_percent": disk_percent,
                "signal_dbm": signal_dbm,
                "noise_dbm": noise_dbm,
                "ccq_percent": ccq_percent,
                "toner_percent": toner_percent,
                "bandwidth_in_mbps": primary_in_mbps,
                "bandwidth_out_mbps": primary_out_mbps,
                "uptime_seconds": uptime_val,
            }
        })).ok();
    }

    // POST to Python REST API (Evaluate Alerts + Webhook / SMTP Notification)
    let client = reqwest::Client::new();
    let url = format!("http://127.0.0.1:{}/api/v1/internal/device-polled", api_port);
    
    let payload = serde_json::json!({
        "device_id": dev_id,
        "status": final_status,
        "ping_ms": ping_ms,
        "metrics": {
            "cpu_percent": cpu_percent,
            "memory_percent": memory_percent,
            "disk_percent": disk_percent,
            "signal_dbm": signal_dbm,
            "noise_dbm": noise_dbm,
            "ccq_percent": ccq_percent,
            "toner_percent": toner_percent,
            "bandwidth_in_mbps": primary_in_mbps,
            "bandwidth_out_mbps": primary_out_mbps,
            "uptime_seconds": uptime_val,
        },
        "interfaces": polled.interfaces,
        "supplies": polled.supplies,
        "ping_ms_custom": ping_ms,
    });

    match client.post(&url)
        .header("X-Secret-Token", &token)
        .json(&payload)
        .timeout(Duration::from_secs(5))
        .send()
        .await {
            Ok(resp) => {
                if !resp.status().is_success() {
                    log::warn!("Python API returned status: {}", resp.status());
                }
            }
            Err(e) => {
                log::error!("Failed to notify Python API: {}", e);
            }
        }
}

fn round_val(val: f64, precision: i32) -> f64 {
    let factor = 10f64.powi(precision);
    (val * factor).round() / factor
}

async fn ping_latency(ip: &str, timeout_secs: f64) -> Option<f64> {
    let timeout_ms = (timeout_secs * 1000.0) as u64;
    let timeout_ms_str = timeout_ms.to_string();
    let timeout_ceil_str = timeout_secs.ceil().to_string();
    let cmd = if cfg!(target_os = "windows") {
        vec!["-n", "1", "-w", &timeout_ms_str, ip]
    } else {
        vec!["-c", "1", "-W", &timeout_ceil_str, ip]
    };

    let mut cmd_builder = tokio::process::Command::new("ping");
    cmd_builder
        .args(&cmd)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null());

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        cmd_builder.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }

    let output = cmd_builder
        .spawn()
        .ok()?
        .wait_with_output()
        .await
        .ok()?;

    if output.status.success() {
        let stdout = String::from_utf8_lossy(&output.stdout);
        if let Some(ms_idx) = stdout.find("ms") {
            let search_str = &stdout[..ms_idx];
            if let Some(start_idx) = search_str.rfind(|c: char| c == ' ' || c == '=' || c == '<') {
                let num_str = search_str[start_idx + 1..].trim();
                if let Ok(val) = num_str.parse::<f64>() {
                    return Some((val * 100.0).round() / 100.0);
                }
            }
        }
    }
    None
}

// Synchronously query the device using SNMP
// `monitored_ifaces` controls which interfaces are polled for bandwidth.
// If empty, the interface walk is skipped entirely (new devices start with
// ping-only until the user selects interfaces in the UI).
fn snmp_query_device(
    ip: &str,
    port: u16,
    community: &str,
    version: &str,
    device_type: &str,
    timeout_secs: u64,
    monitored_ifaces: &[u32],
) -> Result<PolledMetrics, String> {
    use snmp2::{SyncSession, Oid};
    
    let addr = format!("{}:{}", ip, port);
    let timeout = Duration::from_secs(timeout_secs);
    
    let mut sess = if version == "v1" {
        SyncSession::new_v1(&addr, community.as_bytes(), Some(timeout), 1)
    } else {
        SyncSession::new_v2c(&addr, community.as_bytes(), Some(timeout), 1)
    }.map_err(|e| e.to_string())?;

    // 1. Get SysUpTime
    let uptime_oid = Oid::from(OID_SYS_UPTIME).unwrap();
    let mut uptime_seconds = None;
    if let Ok(resp) = sess.get(&uptime_oid) {
        if let Some((_, val)) = resp.varbinds.into_iter().next() {
            if let OwnedValue::TimeTicks(t) = to_owned_value(&val) {
                uptime_seconds = Some((t / 100) as i64);
            }
        }
    }

    // 2. Walk CPU: hrProcessorLoad
    let mut cpu_percent = None;
    let cpu_load_oid = Oid::from(OID_HR_PROCESSOR_LOAD).unwrap();
    if let Ok(walk_res) = snmp_walk_session(&mut sess, &cpu_load_oid) {
        let loads: Vec<f64> = walk_res.values()
            .filter_map(|v| match v {
                OwnedValue::Integer(i) => Some(*i as f64),
                _ => None
            })
            .collect();
        if !loads.is_empty() {
            cpu_percent = Some(round_val(loads.iter().sum::<f64>() / loads.len() as f64, 1));
        }
    }

    // 3. Walk Memory & Disk: hrStorage
    let mut memory_percent = None;
    let mut disk_percent = None;
    
    let storage_descr_oid = Oid::from(OID_HR_STORAGE_DESCR).unwrap();
    let storage_used_oid = Oid::from(OID_HR_STORAGE_USED).unwrap();
    let storage_size_oid = Oid::from(OID_HR_STORAGE_SIZE).unwrap();

    let storage_descrs = snmp_walk_session(&mut sess, &storage_descr_oid).unwrap_or_default();
    let storage_useds = snmp_walk_session(&mut sess, &storage_used_oid).unwrap_or_default();
    let storage_sizes = snmp_walk_session(&mut sess, &storage_size_oid).unwrap_or_default();

    for (oid, val) in &storage_descrs {
        let parts: Vec<&str> = oid.split('.').collect::<Vec<&str>>();
        if let Some(idx_str) = parts.last() {
            let descr = match val {
                OwnedValue::OctetString(b) => String::from_utf8_lossy(b).to_lowercase(),
                _ => continue,
            };
            
            let used_key = format!("1.3.6.1.2.1.25.2.3.1.6.{}", idx_str);
            let size_key = format!("1.3.6.1.2.1.25.2.3.1.5.{}", idx_str);

            let used = storage_useds.get(&used_key).and_then(|v| match v {
                OwnedValue::Integer(i) => Some(*i),
                OwnedValue::Counter(c) => Some(*c as i64),
                _ => None
            }).unwrap_or(0);

            let size = storage_sizes.get(&size_key).and_then(|v| match v {
                OwnedValue::Integer(i) => Some(*i),
                OwnedValue::Counter(c) => Some(*c as i64),
                _ => None
            }).unwrap_or(1);

            if size > 0 {
                let pct = round_val((used as f64 / size as f64) * 100.0, 1);
                if descr.contains("ram") || descr.contains("memory") || descr.contains("physical") {
                    memory_percent = Some(pct);
                } else if descr.contains("disk") || descr.trim() == "/" || descr.contains("c:") || descr.contains("d:") {
                    disk_percent = Some(pct);
                }
            }
        }
    }

    // 4. Walk interfaces — ONLY if the user has selected interfaces to monitor.
    //    New devices start with zero monitored interfaces (ping-only).
    //    The user must open "Interface Monitoring", select ports, and save.
    let mut interfaces = Vec::new();

    if !monitored_ifaces.is_empty() {
        let if_status_oid = Oid::from(OID_IF_OPER_STATUS).unwrap();
        let if_in_oid = Oid::from(OID_IF_IN_OCTETS).unwrap();
        let if_out_oid = Oid::from(OID_IF_OUT_OCTETS).unwrap();
        let if_descr_oid = Oid::from(OID_IF_DESCR).unwrap();

        let if_statuses = snmp_walk_session(&mut sess, &if_status_oid).unwrap_or_default();
        let if_ins = snmp_walk_session(&mut sess, &if_in_oid).unwrap_or_default();
        let if_outs = snmp_walk_session(&mut sess, &if_out_oid).unwrap_or_default();
        let if_descrs = snmp_walk_session(&mut sess, &if_descr_oid).unwrap_or_default();

        for (oid, val) in &if_statuses {
            let parts: Vec<&str> = oid.split('.').collect::<Vec<&str>>();
            if let Some(idx_str) = parts.last() {
                if let Ok(idx) = idx_str.parse::<u32>() {
                    // Only include interfaces that the user selected for monitoring
                    if !monitored_ifaces.contains(&idx) {
                        continue;
                    }

                    let status_val = match val {
                        OwnedValue::Integer(i) => *i,
                        _ => 2, // down
                    };

                    let in_key = format!("1.3.6.1.2.1.2.2.1.10.{}", idx_str);
                    let out_key = format!("1.3.6.1.2.1.2.2.1.16.{}", idx_str);
                    let desc_key = format!("1.3.6.1.2.1.2.2.1.2.{}", idx_str);

                    let bytes_in = if_ins.get(&in_key).and_then(|v| match v {
                        OwnedValue::Counter(c) => Some(*c),
                        OwnedValue::Integer(i) => Some(*i as u64),
                        _ => None
                    }).unwrap_or(0);

                    let bytes_out = if_outs.get(&out_key).and_then(|v| match v {
                        OwnedValue::Counter(c) => Some(*c),
                        OwnedValue::Integer(i) => Some(*i as u64),
                        _ => None
                    }).unwrap_or(0);

                    let name = if_descrs.get(&desc_key).map(|v| match v {
                        OwnedValue::OctetString(b) => String::from_utf8_lossy(b).into_owned(),
                        _ => format!("if{}", idx)
                    }).unwrap_or_else(|| format!("if{}", idx));

                    interfaces.push(InterfaceMetric {
                        index: idx,
                        name,
                        status: if status_val == 1 { "up".to_string() } else { "down".to_string() },
                        bytes_in,
                        bytes_out,
                        in_mbps: None,
                        out_mbps: None,
                    });
                }
            }
        }

        // Sort interfaces by index
        interfaces.sort_by_key(|i| i.index);
    }

    // 5. Printer metrics
    let mut supplies = Vec::new();
    let mut toner_percent = None;

    if device_type == "printer" {
        let level_oid = Oid::from(OID_PRT_SUPPLY_LEVEL).unwrap();
        let max_oid = Oid::from(OID_PRT_SUPPLY_MAX).unwrap();
        let desc_oid = Oid::from(OID_PRT_SUPPLY_DESCR).unwrap();

        let levels = snmp_walk_session(&mut sess, &level_oid).unwrap_or_default();
        let maxes = snmp_walk_session(&mut sess, &max_oid).unwrap_or_default();
        let descrs = snmp_walk_session(&mut sess, &desc_oid).unwrap_or_default();

        for (oid, val) in &levels {
            let parts: Vec<&str> = oid.split('.').collect::<Vec<&str>>();
            if parts.len() >= 2 {
                let idx_str = format!("{}.{}", parts[parts.len() - 2], parts[parts.len() - 1]);
                let level_val = match val {
                    OwnedValue::Integer(i) => *i,
                    _ => 0,
                };

                let max_key = format!("1.3.6.1.2.1.43.11.1.1.8.{}", idx_str);
                let desc_key = format!("1.3.6.1.2.1.43.11.1.1.6.{}", idx_str);

                let max_val = maxes.get(&max_key).and_then(|v| match v {
                    OwnedValue::Integer(i) => Some(*i),
                    _ => None
                }).unwrap_or(100);

                let name = descrs.get(&desc_key).map(|v| match v {
                    OwnedValue::OctetString(b) => String::from_utf8_lossy(b).into_owned(),
                    _ => format!("Supply {}", idx_str)
                }).unwrap_or_else(|| format!("Supply {}", idx_str));

                let pct = if max_val > 0 {
                    round_val((level_val as f64 / max_val as f64) * 100.0, 1)
                } else {
                    -1.0
                };

                supplies.push(SupplyMetric {
                    name,
                    level_percent: pct,
                    level_raw: level_val,
                    max_raw: max_val,
                });
            }
        }

        if !supplies.is_empty() {
            let toner = supplies.iter().find(|s| {
                let n = s.name.to_lowercase();
                n.contains("toner") || n.contains("ink")
            });
            if let Some(t) = toner {
                toner_percent = Some(t.level_percent);
            }
        }
    }

    // 6. RF Link metrics (Ubiquiti OIDs)
    let mut signal_dbm = None;
    let mut noise_dbm = None;
    let mut ccq_percent = None;

    if device_type == "rf_link" {
        let sig_oid = Oid::from(OID_UBNT_SIGNAL).unwrap();
        let noise_oid = Oid::from(OID_UBNT_NOISE).unwrap();
        let ccq_oid = Oid::from(OID_UBNT_CCQ).unwrap();

        if let Ok(resp) = sess.get(&sig_oid) {
            if let Some((_, val)) = resp.varbinds.into_iter().next() {
                let val_f = match to_owned_value(&val) {
                    OwnedValue::Integer(i) => i as f64,
                    OwnedValue::Counter(c) => c as f64,
                    _ => 0.0,
                };
                if val_f != 0.0 {
                    signal_dbm = Some(if val_f.abs() > 100.0 { val_f / 10.0 } else { val_f });
                }
            }
        }
        if let Ok(resp) = sess.get(&noise_oid) {
            if let Some((_, val)) = resp.varbinds.into_iter().next() {
                let val_f = match to_owned_value(&val) {
                    OwnedValue::Integer(i) => i as f64,
                    OwnedValue::Counter(c) => c as f64,
                    _ => 0.0,
                };
                if val_f != 0.0 {
                    noise_dbm = Some(if val_f.abs() > 100.0 { val_f / 10.0 } else { val_f });
                }
            }
        }
        if let Ok(resp) = sess.get(&ccq_oid) {
            if let Some((_, val)) = resp.varbinds.into_iter().next() {
                let val_f = match to_owned_value(&val) {
                    OwnedValue::Integer(i) => i as f64,
                    OwnedValue::Counter(c) => c as f64,
                    _ => 0.0,
                };
                if val_f != 0.0 {
                    ccq_percent = Some(if val_f.abs() > 100.0 { val_f / 10.0 } else { val_f });
                }
            }
        }
    }

    Ok(PolledMetrics {
        status: "online".to_string(),
        uptime_seconds,
        cpu_percent,
        memory_percent,
        disk_percent,
        signal_dbm,
        noise_dbm,
        ccq_percent,
        toner_percent,
        interfaces,
        supplies,
    })
}

// Walks an SNMP prefix using a SyncSession
fn snmp_walk_session(
    sess: &mut snmp2::SyncSession,
    prefix_oid: &snmp2::Oid
) -> Result<HashMap<String, OwnedValue>, String> {
    let mut results = HashMap::new();
    let mut current_oid: snmp2::Oid<'static> = prefix_oid.to_owned();

    loop {
        let response = match sess.getnext(&current_oid) {
            Ok(r) => r,
            Err(_) => break,
        };

        if let Some((oid, val)) = response.varbinds.into_iter().next() {
            if !oid.to_string().starts_with(&prefix_oid.to_string()) {
                break;
            }

            let oid_str = oid.to_string();
            let normalized = if oid_str.starts_with('.') {
                oid_str[1..].to_string()
            } else {
                oid_str
            };

            results.insert(normalized, to_owned_value(&val));
            current_oid = oid.to_owned();
        } else {
            break;
        }

        if results.len() > 128 { // safety cap per walk subtree
            break;
        }
    }
    Ok(results)
}

// Live SNMP walk to list device interfaces
pub fn list_device_interfaces_snmp(
    ip: &str,
    community: &str,
    version: &str,
    port: u16,
    timeout_secs: u64,
) -> Result<serde_json::Value, String> {
    use snmp2::{SyncSession, Oid};
    
    let addr = format!("{}:{}", ip, port);
    let timeout = Duration::from_secs(timeout_secs);
    
    let mut sess = if version == "v1" {
        SyncSession::new_v1(&addr, community.as_bytes(), Some(timeout), 1)
    } else {
        SyncSession::new_v2c(&addr, community.as_bytes(), Some(timeout), 1)
    }.map_err(|e| e.to_string())?;

    let if_descr_oid = Oid::from(&[1, 3, 6, 1, 2, 1, 2, 2, 1, 2]).unwrap();
    let if_status_oid = Oid::from(&[1, 3, 6, 1, 2, 1, 2, 2, 1, 8]).unwrap();
    let if_speed_oid = Oid::from(&[1, 3, 6, 1, 2, 1, 2, 2, 1, 5]).unwrap();
    let if_in_oid = Oid::from(&[1, 3, 6, 1, 2, 1, 2, 2, 1, 10]).unwrap();
    let if_out_oid = Oid::from(&[1, 3, 6, 1, 2, 1, 2, 2, 1, 16]).unwrap();

    let if_descrs = snmp_walk_session(&mut sess, &if_descr_oid).unwrap_or_default();
    let if_statuses = snmp_walk_session(&mut sess, &if_status_oid).unwrap_or_default();
    let if_speeds = snmp_walk_session(&mut sess, &if_speed_oid).unwrap_or_default();
    let if_ins = snmp_walk_session(&mut sess, &if_in_oid).unwrap_or_default();
    let if_outs = snmp_walk_session(&mut sess, &if_out_oid).unwrap_or_default();

    let mut interfaces = Vec::new();

    for (oid, val) in &if_descrs {
        let parts: Vec<&str> = oid.split('.').collect::<Vec<&str>>();
        if let Some(idx_str) = parts.last() {
            if let Ok(idx) = idx_str.parse::<u32>() {
                let name = match val {
                    OwnedValue::OctetString(b) => {
                        let s = String::from_utf8_lossy(b).into_owned();
                        s.trim_matches('\0').trim().to_string()
                    }
                    _ => format!("if{}", idx)
                };

                let status_val = if_statuses.get(&format!("1.3.6.1.2.1.2.2.1.8.{}", idx_str))
                    .and_then(|v| match v {
                        OwnedValue::Integer(i) => Some(*i),
                        _ => None,
                    }).unwrap_or(2);

                let speed_raw = if_speeds.get(&format!("1.3.6.1.2.1.2.2.1.5.{}", idx_str))
                    .and_then(|v| match v {
                        OwnedValue::Integer(i) => Some(*i),
                        OwnedValue::Counter(c) => Some(*c as i64),
                        _ => None,
                    }).unwrap_or(0);

                let bytes_in = if_ins.get(&format!("1.3.6.1.2.1.2.2.1.10.{}", idx_str))
                    .and_then(|v| match v {
                        OwnedValue::Counter(c) => Some(*c),
                        OwnedValue::Integer(i) => Some(*i as u64),
                        _ => None,
                    }).unwrap_or(0);

                let bytes_out = if_outs.get(&format!("1.3.6.1.2.1.2.2.1.16.{}", idx_str))
                    .and_then(|v| match v {
                        OwnedValue::Counter(c) => Some(*c),
                        OwnedValue::Integer(i) => Some(*i as u64),
                        _ => None,
                    }).unwrap_or(0);

                interfaces.push(serde_json::json!({
                    "index": idx,
                    "name": name,
                    "status": if status_val == 1 { "up" } else { "down" },
                    "speed_mbps": ((speed_raw as f64) / 1_000_000.0 * 10.0).round() / 10.0,
                    "bytes_in": bytes_in,
                    "bytes_out": bytes_out,
                }));
            }
        }
    }

    interfaces.sort_by_key(|i| i.get("index").and_then(|v| v.as_u64()).unwrap_or(0));

    Ok(serde_json::Value::Array(interfaces))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_list_interfaces() {
        let res = list_device_interfaces_snmp("172.16.17.54", "public", "v2c", 161, 5);
        println!("TEST RESULT: {:#?}", res);
    }
}


