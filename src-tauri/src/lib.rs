mod snmp_poller;
mod trap_listener;

use std::sync::Mutex;
use tauri::{AppHandle, Manager};
use tauri::tray::{TrayIconBuilder};
use tauri::menu::{Menu, MenuItem};
use tauri_plugin_shell::ShellExt;
use tauri_plugin_autostart::ManagerExt;
use sqlx::{Row, Column, TypeInfo};
use serde_json::{Map, Value};

struct SidecarChild(Mutex<Option<tauri_plugin_shell::process::CommandChild>>);
struct ApiPort(u16);
struct SecretToken(String);

#[tauri::command]
fn get_app_version() -> String {
    "3.0.0".to_string()
}

#[tauri::command]
fn get_user_data_path(app: AppHandle) -> Result<String, String> {
    app.path()
        .app_data_dir()
        .map(|p| p.to_string_lossy().to_string())
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn get_auto_launch(app: AppHandle) -> Result<bool, String> {
    app.autolaunch()
        .is_enabled()
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn set_auto_launch(app: AppHandle, enabled: bool) -> Result<(), String> {
    let autolaunch = app.autolaunch();
    if enabled {
        autolaunch.enable().map_err(|e| e.to_string())
    } else {
        autolaunch.disable().map_err(|e| e.to_string())
    }
}

// Auto-updater stubs for compatibility with window.electronAPI
#[tauri::command]
fn start_update_download() -> Result<(), String> {
    Ok(())
}

#[tauri::command]
fn install_update_now() -> Result<(), String> {
    Ok(())
}

#[tauri::command]
fn check_for_updates_now() -> Result<(), String> {
    Ok(())
}

#[tauri::command]
fn open_releases_page() -> Result<(), String> {
    open_path_or_url("https://github.com/var2611/NMS-Tool/releases");
    Ok(())
}

pub fn get_opt_int_column(row: &sqlx::sqlite::SqliteRow, col: &str) -> Option<i32> {
    row.try_get::<i32, _>(col)
        .or_else(|_| row.try_get::<i64, _>(col).map(|v| v as i32))
        .ok()
}

fn sqlite_row_to_json(row: &sqlx::sqlite::SqliteRow) -> Value {
    let mut map = Map::new();
    for col in row.columns() {
        let name = col.name();
        let type_name = col.type_info().name();
        
        let value = match type_name {
            "INTEGER" | "INT" | "BIGINT" | "TINYINT" | "SMALLINT" => {
                if let Ok(val) = row.try_get::<i64, _>(name) {
                    Value::Number(val.into())
                } else if let Ok(val) = row.try_get::<i32, _>(name) {
                    Value::Number(val.into())
                } else if let Ok(val) = row.try_get::<bool, _>(name) {
                    Value::Bool(val)
                } else {
                    Value::Null
                }
            }
            "REAL" | "DOUBLE" | "FLOAT" => {
                if let Ok(val) = row.try_get::<f64, _>(name) {
                    if let Some(num) = serde_json::Number::from_f64(val) {
                        Value::Number(num)
                    } else {
                        Value::Null
                    }
                } else {
                    Value::Null
                }
            }
            "TEXT" | "VARCHAR" | "CHAR" => {
                if let Ok(val) = row.try_get::<String, _>(name) {
                    if (val.starts_with('{') && val.ends_with('}')) || (val.starts_with('[') && val.ends_with(']')) {
                        if let Ok(json_val) = serde_json::from_str::<Value>(&val) {
                            json_val
                        } else {
                            Value::String(val)
                        }
                    } else {
                        Value::String(val)
                    }
                } else {
                    Value::Null
                }
            }
            "BOOLEAN" | "BOOL" => {
                if let Ok(val) = row.try_get::<bool, _>(name) {
                    Value::Bool(val)
                } else if let Ok(val) = row.try_get::<i64, _>(name) {
                    Value::Bool(val != 0)
                } else {
                    Value::Null
                }
            }
            "DATETIME" | "TIMESTAMP" => {
                if let Ok(val) = row.try_get::<chrono::NaiveDateTime, _>(name) {
                    Value::String(val.to_string())
                } else if let Ok(val) = row.try_get::<chrono::DateTime<chrono::Utc>, _>(name) {
                    Value::String(val.to_rfc3339())
                } else if let Ok(val) = row.try_get::<String, _>(name) {
                    Value::String(val)
                } else {
                    Value::Null
                }
            }
            "JSON" => {
                if let Ok(val) = row.try_get::<String, _>(name) {
                    serde_json::from_str(&val).unwrap_or(Value::String(val))
                } else if let Ok(val) = row.try_get::<Value, _>(name) {
                    val
                } else {
                    Value::Null
                }
            }
            _ => {
                if let Ok(val) = row.try_get::<String, _>(name) {
                    if (val.starts_with('{') && val.ends_with('}')) || (val.starts_with('[') && val.ends_with(']')) {
                        serde_json::from_str(&val).unwrap_or(Value::String(val))
                    } else {
                        Value::String(val)
                    }
                } else if let Ok(val) = row.try_get::<i64, _>(name) {
                    Value::Number(val.into())
                } else if let Ok(val) = row.try_get::<f64, _>(name) {
                    serde_json::Number::from_f64(val).map(Value::Number).unwrap_or(Value::Null)
                } else if let Ok(val) = row.try_get::<bool, _>(name) {
                    Value::Bool(val)
                } else {
                    Value::Null
                }
            }
        };
        map.insert(name.to_string(), value);
    }
    Value::Object(map)
}

async fn forward_to_sidecar(
    method: &str,
    path: &str,
    params: &serde_json::Value,
    data: &serde_json::Value,
    port: u16,
    token: &str,
) -> Result<serde_json::Value, String> {
    let client = reqwest::Client::new();
    let url = format!("http://127.0.0.1:{}/api/v1{}", port, path);
    
    let mut req = match method {
        "GET" => client.get(&url),
        "POST" => client.post(&url),
        "PUT" => client.put(&url),
        "PATCH" => client.patch(&url),
        "DELETE" => client.delete(&url),
        _ => return Err(format!("Unsupported method: {}", method)),
    };
    
    req = req.header("X-Secret-Token", token);
    
    if let Some(map) = params.as_object() {
        let mut query_items = Vec::new();
        for (k, v) in map {
            if let Some(s) = v.as_str() {
                query_items.push((k.clone(), s.to_string()));
            } else {
                query_items.push((k.clone(), v.to_string()));
            }
        }
        req = req.query(&query_items);
    }
    
    if !data.is_null() {
        req = req.json(data);
    }
    
    match req.send().await {
        Ok(resp) => {
            let status = resp.status();
            let text = resp.text().await.map_err(|e| e.to_string())?;
            if status.is_success() {
                if text.trim().is_empty() {
                    Ok(serde_json::Value::Object(serde_json::Map::new()))
                } else {
                    serde_json::from_str(&text).map_err(|e| format!("Invalid JSON response: {}. Raw: {}", e, text))
                }
            } else {
                if let Ok(json_err) = serde_json::from_str::<serde_json::Value>(&text) {
                    if let Some(detail) = json_err.get("detail") {
                        return Err(detail.as_str().unwrap_or(&detail.to_string()).to_string());
                    }
                }
                Err(format!("HTTP Error {}: {}", status, text))
            }
        }
        Err(e) => Err(format!("Failed to reach sidecar: {}", e)),
    }
}

#[tauri::command]
async fn handle_api_request(
    url: String,
    method: String,
    params: serde_json::Value,
    data: serde_json::Value,
    pool: tauri::State<'_, sqlx::SqlitePool>,
    cache: tauri::State<'_, snmp_poller::BandwidthCache>,
    api_port: tauri::State<'_, ApiPort>,
    secret_token: tauri::State<'_, SecretToken>,
    app: AppHandle,
) -> Result<serde_json::Value, String> {
    let parts: Vec<&str> = url.split('/').filter(|s| !s.is_empty()).collect();
    
    match (method.as_str(), parts.as_slice()) {
        ("GET", ["devices"]) => {
            let mut sql = "SELECT * FROM devices WHERE is_active = 1".to_string();
            let mut query_params = Vec::new();

            if let Some(status) = params.get("status").and_then(|v| v.as_str()) {
                sql.push_str(" AND status = ?");
                query_params.push(status.to_string());
            }
            if let Some(device_type) = params.get("device_type").and_then(|v| v.as_str()) {
                sql.push_str(" AND device_type = ?");
                query_params.push(device_type.to_string());
            }
            if let Some(search) = params.get("search").and_then(|v| v.as_str()) {
                sql.push_str(" AND (name LIKE ? OR ip_address LIKE ? OR sys_name LIKE ?)");
                let pattern = format!("%{}%", search);
                query_params.push(pattern.clone());
                query_params.push(pattern.clone());
                query_params.push(pattern);
            }

            sql.push_str(" ORDER BY name");

            let limit = params.get("limit").and_then(|v| v.as_i64()).unwrap_or(100);
            let offset = params.get("offset").and_then(|v| v.as_i64()).unwrap_or(0);
            sql.push_str(&format!(" LIMIT {} OFFSET {}", limit, offset));

            let mut q = sqlx::query(&sql);
            for param in query_params {
                q = q.bind(param);
            }

            let rows = q.fetch_all(&*pool).await.map_err(|e| e.to_string())?;
            let list: Vec<serde_json::Value> = rows.iter().map(sqlite_row_to_json).collect();
            Ok(serde_json::Value::Array(list))
        }
        
        ("GET", ["devices", "summary"]) => {
            let total: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM devices WHERE is_active = 1")
                .fetch_one(&*pool).await.map_err(|e| e.to_string())?;
            let online: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM devices WHERE status = 'online' AND is_active = 1")
                .fetch_one(&*pool).await.map_err(|e| e.to_string())?;
            let offline: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM devices WHERE status = 'offline' AND is_active = 1")
                .fetch_one(&*pool).await.map_err(|e| e.to_string())?;
            let warning: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM devices WHERE status = 'warning' AND is_active = 1")
                .fetch_one(&*pool).await.map_err(|e| e.to_string())?;

            let type_rows = sqlx::query("SELECT device_type, COUNT(*) as cnt FROM devices WHERE is_active = 1 GROUP BY device_type")
                .fetch_all(&*pool).await.map_err(|e| e.to_string())?;

            let mut by_type = serde_json::Map::new();
            for row in type_rows {
                let t: String = row.try_get("device_type").unwrap_or_else(|_| "unknown".to_string());
                let cnt: i64 = row.try_get("cnt").unwrap_or(0);
                by_type.insert(t, serde_json::Value::Number(cnt.into()));
            }

            let health_score = if total > 0 {
                ((online as f64 / total as f64) * 100.0).round() as i64
            } else {
                0
            };

            let summary = serde_json::json!({
                "total": total,
                "online": online,
                "offline": offline,
                "warning": warning,
                "health_score": health_score,
                "by_type": by_type,
            });
            Ok(summary)
        }
        
        ("GET", ["devices", "deleted"]) => {
            let rows = sqlx::query("SELECT * FROM devices WHERE is_active = 0 ORDER BY name")
                .fetch_all(&*pool).await.map_err(|e| e.to_string())?;
            let list: Vec<serde_json::Value> = rows.iter().map(sqlite_row_to_json).collect();
            Ok(serde_json::Value::Array(list))
        }
        
        ("GET", ["devices", id_str]) if id_str.parse::<i32>().is_ok() => {
            let id = id_str.parse::<i32>().unwrap();
            let row = sqlx::query("SELECT * FROM devices WHERE id = ?")
                .bind(id)
                .fetch_optional(&*pool).await.map_err(|e| e.to_string())?;
            match row {
                Some(r) => Ok(sqlite_row_to_json(&r)),
                None => Err("Device not found".to_string()),
            }
        }
        
        ("POST", ["devices"]) => {
            let ip_address = data.get("ip_address").and_then(|v| v.as_str()).ok_or("ip_address is required")?;
            let existing = sqlx::query("SELECT is_active FROM devices WHERE ip_address = ?")
                .bind(ip_address)
                .fetch_optional(&*pool).await.map_err(|e| e.to_string())?;
            if let Some(r) = existing {
                let is_active: bool = r.try_get("is_active").unwrap_or(true);
                if !is_active {
                    return Err("Device with IP was removed earlier — restore it from Removed devices instead of re-adding".to_string());
                }
                return Err("Device with IP already exists".to_string());
            }

            let name = data.get("name").and_then(|v| v.as_str()).ok_or("name is required")?;
            let device_type = data.get("device_type").and_then(|v| v.as_str()).unwrap_or("unknown");
            let snmp_community = data.get("snmp_community").and_then(|v| v.as_str()).unwrap_or("public");
            let snmp_version = data.get("snmp_version").and_then(|v| v.as_str()).unwrap_or("v2c");
            let snmp_port = data.get("snmp_port").and_then(|v| v.as_i64()).unwrap_or(161) as i32;
            let poll_interval = data.get("poll_interval").and_then(|v| v.as_i64()).unwrap_or(300) as i32;
            let notes = data.get("notes").and_then(|v| v.as_str());
            let tags_str = data.get("tags").map(|v| v.to_string());
            let mib_id = data.get("mib_id").and_then(|v| v.as_i64());
            let latitude = data.get("latitude").and_then(|v| v.as_f64());
            let longitude = data.get("longitude").and_then(|v| v.as_f64());
            let assoc_id = data.get("associated_device_id").and_then(|v| v.as_i64());

            let now = chrono::Utc::now().naive_utc().to_string();

            let insert_res = sqlx::query(
                "INSERT INTO devices (name, ip_address, device_type, status, snmp_version, snmp_community, snmp_port, poll_interval, notes, tags, mib_id, latitude, longitude, associated_device_id, is_active, auto_discovered, source, created_at, updated_at, consecutive_failures) VALUES (?, ?, ?, 'unknown', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0, 'manual', ?, ?, 0)"
            )
            .bind(name)
            .bind(ip_address)
            .bind(device_type)
            .bind(snmp_version)
            .bind(snmp_community)
            .bind(snmp_port)
            .bind(poll_interval)
            .bind(notes)
            .bind(tags_str)
            .bind(mib_id)
            .bind(latitude)
            .bind(longitude)
            .bind(assoc_id)
            .bind(&now)
            .bind(&now)
            .execute(&*pool).await.map_err(|e| e.to_string())?;

            let new_id = insert_res.last_insert_rowid() as i32;

            let mut associated_ip = None;
            if let Some(aid) = assoc_id {
                let ip_row = sqlx::query("SELECT ip_address FROM devices WHERE id = ?")
                    .bind(aid as i32)
                    .fetch_optional(&*pool).await.map_err(|e| e.to_string())?;
                if let Some(r) = ip_row {
                    associated_ip = r.try_get::<Option<String>, _>("ip_address").unwrap_or(None);
                }
            }

            let sync_payload = serde_json::json!({
                "name": name,
                "ip_address": ip_address,
                "device_type": device_type,
                "status": "unknown",
                "snmp_community": snmp_community,
                "snmp_port": snmp_port,
                "poll_interval": poll_interval,
                "notes": notes,
                "sys_descr": serde_json::Value::Null,
                "sys_name": serde_json::Value::Null,
                "sys_location": serde_json::Value::Null,
                "sys_contact": serde_json::Value::Null,
                "vendor": serde_json::Value::Null,
                "model": serde_json::Value::Null,
                "auto_discovered": false,
                "last_seen": serde_json::Value::Null,
                "uptime_seconds": serde_json::Value::Null,
                "latitude": latitude,
                "longitude": longitude,
                "associated_ip": associated_ip,
            });

            sqlx::query(
                "INSERT INTO sync_queue (entity_type, entity_id, operation, payload, attempts, status, created_at) VALUES ('device', ?, 'create', ?, 0, 'pending', ?)"
            )
            .bind(new_id)
            .bind(&sync_payload.to_string())
            .bind(&now)
            .execute(&*pool).await.map_err(|e| e.to_string())?;

            let created_row = sqlx::query("SELECT * FROM devices WHERE id = ?")
                .bind(new_id)
                .fetch_one(&*pool).await.map_err(|e| e.to_string())?;
            Ok(sqlite_row_to_json(&created_row))
        }
        
        ("PUT", ["devices", id_str]) if id_str.parse::<i32>().is_ok() => {
            let id = id_str.parse::<i32>().unwrap();

            let existing = sqlx::query("SELECT * FROM devices WHERE id = ?")
                .bind(id)
                .fetch_optional(&*pool).await.map_err(|e| e.to_string())?;
            let existing = match existing {
                Some(r) => r,
                None => return Err("Device not found".to_string()),
            };

            let cur_name = existing.try_get::<String, _>("name").unwrap_or_default();
            let cur_device_type = existing.try_get::<Option<String>, _>("device_type").unwrap_or(None).unwrap_or_else(|| "unknown".to_string());
            let cur_snmp_community = existing.try_get::<Option<String>, _>("snmp_community").unwrap_or(None).unwrap_or_else(|| "public".to_string());
            let cur_snmp_version = existing.try_get::<Option<String>, _>("snmp_version").unwrap_or(None).unwrap_or_else(|| "v2c".to_string());
            let cur_snmp_port = get_opt_int_column(&existing, "snmp_port").unwrap_or(161);
            let cur_poll_interval = get_opt_int_column(&existing, "poll_interval").unwrap_or(300);
            let cur_notes = existing.try_get::<Option<String>, _>("notes").unwrap_or(None);
            let cur_tags_str = existing.try_get::<Option<String>, _>("tags").unwrap_or(None);
            let cur_mib_id = existing.try_get::<Option<i32>, _>("mib_id").ok().flatten();
            let cur_latitude = existing.try_get::<Option<f64>, _>("latitude").unwrap_or(None);
            let cur_longitude = existing.try_get::<Option<f64>, _>("longitude").unwrap_or(None);
            let cur_assoc_id = existing.try_get::<Option<i32>, _>("associated_device_id").ok().flatten();
            let cur_is_active = existing.try_get::<bool, _>("is_active").unwrap_or(true);

            let mut assoc_sent = false;
            let mut assoc_value = None;
            if let Some(v) = data.get("associated_device_id") {
                assoc_sent = true;
                assoc_value = v.as_i64().map(|x| x as i32);
            }

            if assoc_sent {
                if let Some(av) = assoc_value {
                    if av == id {
                        return Err("A device cannot be associated with itself".to_string());
                    }
                    let check_assoc = sqlx::query("SELECT id FROM devices WHERE id = ?")
                        .bind(av)
                        .fetch_optional(&*pool).await.map_err(|e| e.to_string())?;
                    if check_assoc.is_none() {
                        return Err("Associated device not found".to_string());
                    }
                }
            }

            let name = data.get("name").and_then(|v| v.as_str()).unwrap_or(&cur_name);
            let device_type = data.get("device_type").and_then(|v| v.as_str()).unwrap_or(&cur_device_type);
            let snmp_community = data.get("snmp_community").and_then(|v| v.as_str()).unwrap_or(&cur_snmp_community);
            let snmp_version = data.get("snmp_version").and_then(|v| v.as_str()).unwrap_or(&cur_snmp_version);

            let snmp_port = data.get("snmp_port").and_then(|v| v.as_i64()).map(|n| n as i32).unwrap_or(cur_snmp_port);
            let poll_interval = data.get("poll_interval").and_then(|v| v.as_i64()).map(|n| n as i32).unwrap_or(cur_poll_interval);

            let notes = if data.get("notes").is_some() {
                data.get("notes").and_then(|v| v.as_str()).map(|s| s.to_string())
            } else {
                cur_notes
            };

            let tags_str = if data.get("tags").is_some() {
                data.get("tags").map(|v| v.to_string())
            } else {
                cur_tags_str
            };

            let mib_id = if data.get("mib_id").is_some() {
                data.get("mib_id").and_then(|v| v.as_i64()).map(|n| n as i32)
            } else {
                cur_mib_id
            };

            let latitude = if data.get("latitude").is_some() {
                data.get("latitude").and_then(|v| v.as_f64())
            } else {
                cur_latitude
            };

            let longitude = if data.get("longitude").is_some() {
                data.get("longitude").and_then(|v| v.as_f64())
            } else {
                cur_longitude
            };

            let assoc_id = if assoc_sent {
                assoc_value
            } else {
                cur_assoc_id
            };

            let is_active = if let Some(b) = data.get("is_active").and_then(|v| v.as_bool()) {
                b
            } else {
                cur_is_active
            };

            let now = chrono::Utc::now().naive_utc().to_string();
            
            sqlx::query(
                "UPDATE devices SET name = ?, device_type = ?, snmp_community = ?, snmp_version = ?, snmp_port = ?, poll_interval = ?, notes = ?, tags = ?, mib_id = ?, latitude = ?, longitude = ?, associated_device_id = ?, is_active = ?, updated_at = ? WHERE id = ?"
            )
            .bind(name)
            .bind(device_type)
            .bind(snmp_community)
            .bind(snmp_version)
            .bind(snmp_port)
            .bind(poll_interval)
            .bind(notes)
            .bind(tags_str)
            .bind(mib_id)
            .bind(latitude)
            .bind(longitude)
            .bind(assoc_id)
            .bind(if is_active { 1 } else { 0 })
            .bind(&now)
            .bind(id)
            .execute(&*pool).await.map_err(|e| e.to_string())?;

            let updated_row = sqlx::query("SELECT * FROM devices WHERE id = ?")
                .bind(id)
                .fetch_one(&*pool).await.map_err(|e| e.to_string())?;

            let mut associated_ip = None;
            let updated_assoc_id: Option<i32> = match updated_row.try_get::<Option<i32>, _>("associated_device_id") {
                Ok(val) => val,
                Err(_) => updated_row.try_get::<Option<i64>, _>("associated_device_id").ok().flatten().map(|v| v as i32),
            };
            if let Some(aid) = updated_assoc_id {
                let ip_row = sqlx::query("SELECT ip_address FROM devices WHERE id = ?")
                    .bind(aid)
                    .fetch_optional(&*pool).await.map_err(|e| e.to_string())?;
                if let Some(r) = ip_row {
                    associated_ip = r.try_get::<Option<String>, _>("ip_address").unwrap_or(None);
                }
            }

            let sync_payload = serde_json::json!({
                "name":           updated_row.try_get::<String, _>("name").unwrap_or_default(),
                "ip_address":     updated_row.try_get::<String, _>("ip_address").unwrap_or_default(),
                "device_type":    updated_row.try_get::<Option<String>, _>("device_type").unwrap_or(None).unwrap_or_else(|| "unknown".to_string()),
                "status":         updated_row.try_get::<Option<String>, _>("status").unwrap_or(None).unwrap_or_else(|| "unknown".to_string()),
                "snmp_community": updated_row.try_get::<Option<String>, _>("snmp_community").unwrap_or(None),
                "snmp_port":      get_opt_int_column(&updated_row, "snmp_port"),
                "poll_interval":  get_opt_int_column(&updated_row, "poll_interval"),
                "notes":          updated_row.try_get::<Option<String>, _>("notes").unwrap_or(None),
                "sys_descr":      updated_row.try_get::<Option<String>, _>("sys_descr").unwrap_or(None),
                "sys_name":       updated_row.try_get::<Option<String>, _>("sys_name").unwrap_or(None),
                "sys_location":   updated_row.try_get::<Option<String>, _>("sys_location").unwrap_or(None),
                "sys_contact":    updated_row.try_get::<Option<String>, _>("sys_contact").unwrap_or(None),
                "vendor":         updated_row.try_get::<Option<String>, _>("vendor").unwrap_or(None),
                "model":          updated_row.try_get::<Option<String>, _>("model").unwrap_or(None),
                "auto_discovered": updated_row.try_get::<bool, _>("auto_discovered").unwrap_or(false),
                "last_seen":      updated_row.try_get::<Option<chrono::NaiveDateTime>, _>("last_seen").ok().flatten().map(|dt| dt.to_string()),
                "uptime_seconds": get_opt_int_column(&updated_row, "uptime_seconds"),
                "latitude":       updated_row.try_get::<Option<f64>, _>("latitude").unwrap_or(None),
                "longitude":      updated_row.try_get::<Option<f64>, _>("longitude").unwrap_or(None),
                "associated_ip":  associated_ip,
            });

            sqlx::query(
                "INSERT INTO sync_queue (entity_type, entity_id, operation, payload, attempts, status, created_at) VALUES ('device', ?, 'update', ?, 0, 'pending', ?)"
            )
            .bind(id)
            .bind(&sync_payload.to_string())
            .bind(&now)
            .execute(&*pool).await.map_err(|e| e.to_string())?;

            Ok(sqlite_row_to_json(&updated_row))
        }
        
        ("DELETE", ["devices", id_str]) if id_str.parse::<i32>().is_ok() => {
            let id = id_str.parse::<i32>().unwrap();
            let device = sqlx::query("SELECT ip_address FROM devices WHERE id = ?")
                .bind(id)
                .fetch_optional(&*pool).await.map_err(|e| e.to_string())?;
            let device = match device {
                Some(d) => d,
                None => return Err("Device not found".to_string()),
            };
            let ip_address: String = device.try_get("ip_address").unwrap_or_default();

            sqlx::query("UPDATE devices SET is_active = 0 WHERE id = ?")
                .bind(id)
                .execute(&*pool).await.map_err(|e| e.to_string())?;

            let now = chrono::Utc::now().naive_utc().to_string();
            let sync_payload = serde_json::json!({ "ip_address": ip_address });
            sqlx::query(
                "INSERT INTO sync_queue (entity_type, entity_id, operation, payload, attempts, status, created_at) VALUES ('device', ?, 'delete', ?, 0, 'pending', ?)"
            )
            .bind(id)
            .bind(&sync_payload.to_string())
            .bind(&now)
            .execute(&*pool).await.map_err(|e| e.to_string())?;

            Ok(serde_json::json!({ "message": "Device removed" }))
        }
        
        ("DELETE", ["devices", id_str, "purge"]) if id_str.parse::<i32>().is_ok() => {
            let id = id_str.parse::<i32>().unwrap();
            let device = sqlx::query("SELECT name, ip_address FROM devices WHERE id = ?")
                .bind(id)
                .fetch_optional(&*pool).await.map_err(|e| e.to_string())?;
            let device = match device {
                Some(d) => d,
                None => return Err("Device not found".to_string()),
            };
            let name: String = device.try_get("name").unwrap_or_default();
            let ip_address: String = device.try_get("ip_address").unwrap_or_default();

            sqlx::query("DELETE FROM device_metrics WHERE device_id = ?").bind(id).execute(&*pool).await.map_err(|e| e.to_string())?;
            sqlx::query("DELETE FROM alerts WHERE device_id = ?").bind(id).execute(&*pool).await.map_err(|e| e.to_string())?;
            sqlx::query("DELETE FROM trap_events WHERE device_id = ?").bind(id).execute(&*pool).await.map_err(|e| e.to_string())?;
            sqlx::query("DELETE FROM sync_queue WHERE entity_id = ? AND entity_type IN ('device', 'metric')").bind(id).execute(&*pool).await.map_err(|e| e.to_string())?;
            sqlx::query("DELETE FROM devices WHERE id = ?").bind(id).execute(&*pool).await.map_err(|e| e.to_string())?;

            let now = chrono::Utc::now().naive_utc().to_string();
            let sync_payload = serde_json::json!({ "ip_address": ip_address });
            sqlx::query(
                "INSERT INTO sync_queue (entity_type, entity_id, operation, payload, attempts, status, created_at) VALUES ('device', ?, 'delete', ?, 0, 'pending', ?)"
            )
            .bind(id)
            .bind(&sync_payload.to_string())
            .bind(&now)
            .execute(&*pool).await.map_err(|e| e.to_string())?;

            Ok(serde_json::json!({ "message": format!("\"{}\" and all of its history were permanently deleted", name) }))
        }
        
        ("POST", ["devices", id_str, "restore"]) if id_str.parse::<i32>().is_ok() => {
            let id = id_str.parse::<i32>().unwrap();
            let device = sqlx::query("SELECT * FROM devices WHERE id = ?")
                .bind(id)
                .fetch_optional(&*pool).await.map_err(|e| e.to_string())?;
            let device_row = match device {
                Some(d) => d,
                None => return Err("Device not found".to_string()),
            };
            let is_active: bool = device_row.try_get("is_active").unwrap_or(true);
            if is_active {
                return Err("Device is not deleted".to_string());
            }

            let now = chrono::Utc::now().naive_utc().to_string();
            sqlx::query("UPDATE devices SET is_active = 1, updated_at = ? WHERE id = ?")
                .bind(&now)
                .bind(id)
                .execute(&*pool).await.map_err(|e| e.to_string())?;

            let restored_row = sqlx::query("SELECT * FROM devices WHERE id = ?")
                .bind(id)
                .fetch_one(&*pool).await.map_err(|e| e.to_string())?;

            let mut associated_ip = None;
            let updated_assoc_id: Option<i32> = match restored_row.try_get::<Option<i32>, _>("associated_device_id") {
                Ok(val) => val,
                Err(_) => restored_row.try_get::<Option<i64>, _>("associated_device_id").ok().flatten().map(|v| v as i32),
            };
            if let Some(aid) = updated_assoc_id {
                let ip_row = sqlx::query("SELECT ip_address FROM devices WHERE id = ?")
                    .bind(aid)
                    .fetch_optional(&*pool).await.map_err(|e| e.to_string())?;
                if let Some(r) = ip_row {
                    associated_ip = r.try_get::<Option<String>, _>("ip_address").unwrap_or(None);
                }
            }

            let sync_payload = serde_json::json!({
                "name":           restored_row.try_get::<String, _>("name").unwrap_or_default(),
                "ip_address":     restored_row.try_get::<String, _>("ip_address").unwrap_or_default(),
                "device_type":    restored_row.try_get::<Option<String>, _>("device_type").unwrap_or(None).unwrap_or_else(|| "unknown".to_string()),
                "status":         restored_row.try_get::<Option<String>, _>("status").unwrap_or(None).unwrap_or_else(|| "unknown".to_string()),
                "snmp_community": restored_row.try_get::<Option<String>, _>("snmp_community").unwrap_or(None),
                "snmp_port":      get_opt_int_column(&restored_row, "snmp_port"),
                "poll_interval":  get_opt_int_column(&restored_row, "poll_interval"),
                "notes":          restored_row.try_get::<Option<String>, _>("notes").unwrap_or(None),
                "sys_descr":      restored_row.try_get::<Option<String>, _>("sys_descr").unwrap_or(None),
                "sys_name":       restored_row.try_get::<Option<String>, _>("sys_name").unwrap_or(None),
                "sys_location":   restored_row.try_get::<Option<String>, _>("sys_location").unwrap_or(None),
                "sys_contact":    restored_row.try_get::<Option<String>, _>("sys_contact").unwrap_or(None),
                "vendor":         restored_row.try_get::<Option<String>, _>("vendor").unwrap_or(None),
                "model":          restored_row.try_get::<Option<String>, _>("model").unwrap_or(None),
                "auto_discovered": restored_row.try_get::<bool, _>("auto_discovered").unwrap_or(false),
                "last_seen":      restored_row.try_get::<Option<chrono::NaiveDateTime>, _>("last_seen").ok().flatten().map(|dt| dt.to_string()),
                "uptime_seconds": get_opt_int_column(&restored_row, "uptime_seconds"),
                "latitude":       restored_row.try_get::<Option<f64>, _>("latitude").unwrap_or(None),
                "longitude":      restored_row.try_get::<Option<f64>, _>("longitude").unwrap_or(None),
                "associated_ip":  associated_ip,
            });

            sqlx::query(
                "INSERT INTO sync_queue (entity_type, entity_id, operation, payload, attempts, status, created_at) VALUES ('device', ?, 'create', ?, 0, 'pending', ?)"
            )
            .bind(id)
            .bind(&sync_payload.to_string())
            .bind(&now)
            .execute(&*pool).await.map_err(|e| e.to_string())?;

            Ok(sqlite_row_to_json(&restored_row))
        }
        
        ("POST", ["devices", id_str, "poll"]) if id_str.parse::<i32>().is_ok() => {
            let id = id_str.parse::<i32>().unwrap();
            let snmp_timeout_setting = sqlx::query("SELECT value FROM system_settings WHERE key = 'snmp_timeout'")
                .fetch_optional(&*pool)
                .await
                .ok()
                .flatten()
                .and_then(|row| row.try_get::<Option<String>, _>("value").unwrap_or(None))
                .and_then(|v| v.parse::<u64>().ok())
                .unwrap_or(5);

            let pool_clone = pool.inner().clone();
            let cache_clone = cache.inner().clone();
            let api_port_val = api_port.0;
            let secret_token_val = secret_token.0.clone();
            let app_clone = app.clone();

            tauri::async_runtime::spawn(async move {
                snmp_poller::poll_device_single(
                    pool_clone,
                    id,
                    cache_clone,
                    secret_token_val,
                    api_port_val,
                    snmp_timeout_setting,
                    Some(app_clone),
                )
                .await;
            });

            Ok(serde_json::json!({ "message": "Poll triggered" }))
        }
        
        ("GET", ["devices", id_str, "metrics"]) if id_str.parse::<i32>().is_ok() => {
            let id = id_str.parse::<i32>().unwrap();
            let hours = params.get("hours").and_then(|v| v.as_i64()).unwrap_or(24);
            let since = chrono::Utc::now() - chrono::Duration::hours(hours);
            let since_str = since.naive_utc().to_string();

            let metrics_rows = sqlx::query(
                "SELECT * FROM device_metrics WHERE device_id = ? AND timestamp >= ? ORDER BY timestamp ASC"
            )
            .bind(id)
            .bind(&since_str)
            .fetch_all(&*pool).await.map_err(|e| e.to_string())?;

            let mut list = Vec::new();
            for row in metrics_rows {
                let custom_str: Option<String> = row.try_get("custom_metrics").unwrap_or(None);
                let custom: serde_json::Value = custom_str.and_then(|s| serde_json::from_str(&s).ok()).unwrap_or(serde_json::json!({}));
                
                let timestamp_str: String = row.try_get::<String, _>("timestamp")
                    .or_else(|_| row.try_get::<chrono::NaiveDateTime, _>("timestamp").map(|dt| dt.to_string()))
                    .unwrap_or_default();

                list.push(serde_json::json!({
                    "timestamp": timestamp_str,
                    "cpu_percent": row.try_get::<Option<f64>, _>("cpu_percent").unwrap_or(None),
                    "memory_percent": row.try_get::<Option<f64>, _>("memory_percent").unwrap_or(None),
                    "disk_percent": row.try_get::<Option<f64>, _>("disk_percent").unwrap_or(None),
                    "bandwidth_in_mbps": row.try_get::<Option<f64>, _>("bandwidth_in_mbps").unwrap_or(None),
                    "bandwidth_out_mbps": row.try_get::<Option<f64>, _>("bandwidth_out_mbps").unwrap_or(None),
                    "signal_dbm": row.try_get::<Option<f64>, _>("signal_dbm").unwrap_or(None),
                    "ccq_percent": row.try_get::<Option<f64>, _>("ccq_percent").unwrap_or(None),
                    "toner_percent": row.try_get::<Option<f64>, _>("toner_percent").unwrap_or(None),
                    "ping_ms": custom.get("ping_ms"),
                    "interfaces": custom.get("interfaces").unwrap_or(&serde_json::Value::Object(serde_json::Map::new())),
                    "mib_metrics": custom.get("mib_metrics").unwrap_or(&serde_json::Value::Object(serde_json::Map::new())),
                }));
            }
            Ok(serde_json::Value::Array(list))
        }

        ("POST", ["devices", id_str, "interfaces"]) if id_str.parse::<i32>().is_ok() => {
            let id = id_str.parse::<i32>().unwrap();
            let indexes = data.get("indexes").ok_or("indexes field is required")?;

            let dev_row = sqlx::query("SELECT tags FROM devices WHERE id = ?")
                .bind(id)
                .fetch_optional(&*pool).await.map_err(|e| e.to_string())?;
            let dev_row = match dev_row {
                Some(r) => r,
                None => return Err("Device not found".to_string()),
            };
            let tags_str: Option<String> = dev_row.try_get("tags").unwrap_or(None);
            let mut tags: serde_json::Value = tags_str.and_then(|s| serde_json::from_str(&s).ok()).unwrap_or(serde_json::json!({}));

            if let Some(obj) = tags.as_object_mut() {
                obj.insert("monitored_interfaces".to_string(), indexes.clone());
            }

            let new_tags_str = tags.to_string();
            let now = chrono::Utc::now().naive_utc().to_string();
            sqlx::query("UPDATE devices SET tags = ?, updated_at = ? WHERE id = ?")
                .bind(&new_tags_str)
                .bind(&now)
                .bind(id)
                .execute(&*pool).await.map_err(|e| e.to_string())?;

            Ok(serde_json::json!({ "monitored": indexes }))
        }

        ("POST", ["devices", id_str, "mib-metrics"]) if id_str.parse::<i32>().is_ok() => {
            let id = id_str.parse::<i32>().unwrap();
            let metrics = data.get("metrics").ok_or("metrics field is required")?;

            let dev_row = sqlx::query("SELECT tags FROM devices WHERE id = ?")
                .bind(id)
                .fetch_optional(&*pool).await.map_err(|e| e.to_string())?;
            let dev_row = match dev_row {
                Some(r) => r,
                None => return Err("Device not found".to_string()),
            };
            let tags_str: Option<String> = dev_row.try_get("tags").unwrap_or(None);
            let mut tags: serde_json::Value = tags_str.and_then(|s| serde_json::from_str(&s).ok()).unwrap_or(serde_json::json!({}));

            if let Some(obj) = tags.as_object_mut() {
                obj.insert("monitored_mib_metrics".to_string(), metrics.clone());
            }

            let new_tags_str = tags.to_string();
            let now = chrono::Utc::now().naive_utc().to_string();
            sqlx::query("UPDATE devices SET tags = ?, updated_at = ? WHERE id = ?")
                .bind(&new_tags_str)
                .bind(&now)
                .bind(id)
                .execute(&*pool).await.map_err(|e| e.to_string())?;

            Ok(serde_json::json!({ "monitored_mib_metrics": metrics }))
        }

        ("GET", ["alerts"]) => {
            let status = params.get("status").and_then(|v| v.as_str());
            let severity = params.get("severity").and_then(|v| v.as_str());
            let hours = params.get("hours").and_then(|v| v.as_i64()).unwrap_or(72);
            let limit = params.get("limit").and_then(|v| v.as_i64()).unwrap_or(100);

            let since = chrono::Utc::now() - chrono::Duration::hours(hours);
            let since_str = since.naive_utc().to_string();

            let mut sql = "SELECT a.*, d.name as device_name FROM alerts a JOIN devices d ON a.device_id = d.id WHERE a.timestamp >= ?".to_string();
            let mut query_params = Vec::new();
            query_params.push(since_str);

            if let Some(s) = status {
                sql.push_str(" AND a.status = ?");
                query_params.push(s.to_string());
            }
            if let Some(sev) = severity {
                sql.push_str(" AND a.severity = ?");
                query_params.push(sev.to_string());
            }

            sql.push_str(" ORDER BY a.timestamp DESC LIMIT ?");

            let mut q = sqlx::query(&sql);
            for param in query_params {
                q = q.bind(param);
            }
            q = q.bind(limit as i32);

            let rows = q.fetch_all(&*pool).await.map_err(|e| e.to_string())?;
            let mut list = Vec::new();
            for row in rows {
                list.push(sqlite_row_to_json(&row));
            }
            Ok(serde_json::Value::Array(list))
        }

        ("GET", ["alerts", "summary"]) => {
            let since = (chrono::Utc::now() - chrono::Duration::hours(24)).naive_utc().to_string();

            let total: i64 = sqlx::query_scalar("SELECT COUNT(a.id) FROM alerts a JOIN devices d ON a.device_id = d.id WHERE a.timestamp >= ?")
                .bind(&since)
                .fetch_one(&*pool).await.map_err(|e| e.to_string())?;

            let critical: i64 = sqlx::query_scalar("SELECT COUNT(a.id) FROM alerts a JOIN devices d ON a.device_id = d.id WHERE a.timestamp >= ? AND a.severity = 'critical'")
                .bind(&since)
                .fetch_one(&*pool).await.map_err(|e| e.to_string())?;

            let unack: i64 = sqlx::query_scalar("SELECT COUNT(a.id) FROM alerts a JOIN devices d ON a.device_id = d.id WHERE a.status = 'new'")
                .fetch_one(&*pool).await.map_err(|e| e.to_string())?;

            Ok(serde_json::json!({
                "last_24h": total,
                "critical_24h": critical,
                "unacknowledged": unack,
            }))
        }

        ("POST", ["alerts", id_str, "acknowledge"]) if id_str.parse::<i32>().is_ok() => {
            let id = id_str.parse::<i32>().unwrap();
            let ack_by = data.get("acknowledged_by").and_then(|v| v.as_str()).unwrap_or("admin");
            let notes = data.get("notes").and_then(|v| v.as_str());

            let row = sqlx::query("SELECT id FROM alerts WHERE id = ?")
                .bind(id)
                .fetch_optional(&*pool).await.map_err(|e| e.to_string())?;
            if row.is_none() {
                return Err("Alert not found".to_string());
            }

            let now = chrono::Utc::now().naive_utc().to_string();
            sqlx::query("UPDATE alerts SET status = 'acknowledged', acknowledged_by = ?, acknowledged_at = ?, notes = ? WHERE id = ?")
                .bind(ack_by)
                .bind(&now)
                .bind(notes)
                .bind(id)
                .execute(&*pool).await.map_err(|e| e.to_string())?;

            Ok(serde_json::json!({ "message": "Alert acknowledged" }))
        }

        ("POST", ["alerts", id_str, "resolve"]) if id_str.parse::<i32>().is_ok() => {
            let id = id_str.parse::<i32>().unwrap();

            let row = sqlx::query("SELECT id FROM alerts WHERE id = ?")
                .bind(id)
                .fetch_optional(&*pool).await.map_err(|e| e.to_string())?;
            if row.is_none() {
                return Err("Alert not found".to_string());
            }

            let now = chrono::Utc::now().naive_utc().to_string();
            sqlx::query("UPDATE alerts SET status = 'resolved', resolved_at = ? WHERE id = ?")
                .bind(&now)
                .bind(id)
                .execute(&*pool).await.map_err(|e| e.to_string())?;

            Ok(serde_json::json!({ "message": "Alert resolved" }))
        }

        ("GET", ["traps", "events"]) => {
            let hours = params.get("hours").and_then(|v| v.as_i64()).unwrap_or(24);
            let severity = params.get("severity").and_then(|v| v.as_str());
            let source_ip = params.get("source_ip").and_then(|v| v.as_str());
            let limit = params.get("limit").and_then(|v| v.as_i64()).unwrap_or(100);

            let since = chrono::Utc::now() - chrono::Duration::hours(hours);
            let since_str = since.naive_utc().to_string();

            let mut sql = "SELECT t.* FROM trap_events t JOIN devices d ON t.device_id = d.id WHERE t.timestamp >= ?".to_string();
            let mut query_params = Vec::new();
            query_params.push(since_str);

            if let Some(sev) = severity {
                sql.push_str(" AND t.severity = ?");
                query_params.push(sev.to_string());
            }
            if let Some(ip) = source_ip {
                sql.push_str(" AND t.source_ip = ?");
                query_params.push(ip.to_string());
            }

            sql.push_str(" ORDER BY t.timestamp DESC LIMIT ?");

            let mut q = sqlx::query(&sql);
            for param in query_params {
                q = q.bind(param);
            }
            q = q.bind(limit as i32);

            let rows = q.fetch_all(&*pool).await.map_err(|e| e.to_string())?;
            let mut list = Vec::new();
            for row in rows {
                list.push(sqlite_row_to_json(&row));
            }
            Ok(serde_json::Value::Array(list))
        }

        ("GET", ["traps", "events", "stats"]) => {
            let since = (chrono::Utc::now() - chrono::Duration::hours(24)).naive_utc().to_string();

            let total: i64 = sqlx::query_scalar("SELECT COUNT(t.id) FROM trap_events t JOIN devices d ON t.device_id = d.id WHERE t.timestamp >= ?")
                .bind(&since)
                .fetch_one(&*pool).await.map_err(|e| e.to_string())?;

            let critical: i64 = sqlx::query_scalar("SELECT COUNT(t.id) FROM trap_events t JOIN devices d ON t.device_id = d.id WHERE t.timestamp >= ? AND t.severity = 'critical'")
                .bind(&since)
                .fetch_one(&*pool).await.map_err(|e| e.to_string())?;

            Ok(serde_json::json!({
                "last_24h_total": total,
                "last_24h_critical": critical,
            }))
        }

        ("GET", ["traps", "rules"]) => {
            let rows = sqlx::query("SELECT * FROM trap_rules ORDER BY name")
                .fetch_all(&*pool).await.map_err(|e| e.to_string())?;
            let list: Vec<serde_json::Value> = rows.iter().map(sqlite_row_to_json).collect();
            Ok(serde_json::Value::Array(list))
        }

        ("POST", ["traps", "rules"]) => {
            let name = data.get("name").and_then(|v| v.as_str()).ok_or("name is required")?;
            let descr = data.get("description").and_then(|v| v.as_str());
            let trap_oid_pattern = data.get("trap_oid_pattern").and_then(|v| v.as_str()).ok_or("trap_oid_pattern is required")?;
            let severity = data.get("severity").and_then(|v| v.as_str()).unwrap_or("info");
            let tmpl = data.get("plain_english_template").and_then(|v| v.as_str());
            let create_alert = data.get("create_alert").and_then(|v| v.as_bool()).unwrap_or(true);
            let send_email = data.get("send_email").and_then(|v| v.as_bool()).unwrap_or(false);
            let send_webhook = data.get("send_webhook").and_then(|v| v.as_bool()).unwrap_or(false);
            let play_sound = data.get("play_sound").and_then(|v| v.as_bool()).unwrap_or(false);
            let sup_start = data.get("suppress_start_hour").and_then(|v| v.as_i64());
            let sup_end = data.get("suppress_end_hour").and_then(|v| v.as_i64());

            let now = chrono::Utc::now().naive_utc().to_string();

            let insert_res = sqlx::query(
                "INSERT INTO trap_rules (name, description, is_enabled, trap_oid_pattern, severity, plain_english_template, create_alert, send_email, send_webhook, play_sound, suppress_start_hour, suppress_end_hour, created_at, updated_at) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
            )
            .bind(name)
            .bind(descr)
            .bind(trap_oid_pattern)
            .bind(severity)
            .bind(tmpl)
            .bind(if create_alert { 1 } else { 0 })
            .bind(if send_email { 1 } else { 0 })
            .bind(if send_webhook { 1 } else { 0 })
            .bind(if play_sound { 1 } else { 0 })
            .bind(sup_start.map(|x| x as i32))
            .bind(sup_end.map(|x| x as i32))
            .bind(&now)
            .bind(&now)
            .execute(&*pool).await.map_err(|e| e.to_string())?;

            let new_id = insert_res.last_insert_rowid();

            Ok(serde_json::json!({
                "id": new_id,
                "name": name,
                "message": "Rule created"
            }))
        }

        ("PUT", ["traps", "rules", id_str]) if id_str.parse::<i32>().is_ok() => {
            let id = id_str.parse::<i32>().unwrap();

            let existing = sqlx::query("SELECT * FROM trap_rules WHERE id = ?")
                .bind(id)
                .fetch_optional(&*pool).await.map_err(|e| e.to_string())?;
            let row = match existing {
                Some(r) => r,
                None => return Err("Rule not found".to_string()),
            };

            let cur_name = row.try_get::<String, _>("name").unwrap_or_default();
            let cur_descr = row.try_get::<Option<String>, _>("description").unwrap_or(None);
            let cur_pattern = row.try_get::<String, _>("trap_oid_pattern").unwrap_or_default();
            let cur_severity = row.try_get::<String, _>("severity").unwrap_or_else(|_| "info".to_string());
            let cur_template = row.try_get::<Option<String>, _>("plain_english_template").unwrap_or(None);
            let cur_create_alert = row.try_get::<bool, _>("create_alert").unwrap_or(true);
            let cur_send_email = row.try_get::<bool, _>("send_email").unwrap_or(false);
            let cur_send_webhook = row.try_get::<bool, _>("send_webhook").unwrap_or(false);
            let cur_play_sound = row.try_get::<bool, _>("play_sound").unwrap_or(false);
            let cur_sup_start = row.try_get::<Option<i32>, _>("suppress_start_hour").ok().flatten();
            let cur_sup_end = row.try_get::<Option<i32>, _>("suppress_end_hour").ok().flatten();

            let name = data.get("name").and_then(|v| v.as_str()).unwrap_or(&cur_name);
            let description = if data.get("description").is_some() {
                data.get("description").and_then(|v| v.as_str()).map(|s| s.to_string())
            } else {
                cur_descr
            };
            let pattern = data.get("trap_oid_pattern").and_then(|v| v.as_str()).unwrap_or(&cur_pattern);
            let severity = data.get("severity").and_then(|v| v.as_str()).unwrap_or(&cur_severity);
            let template = if data.get("plain_english_template").is_some() {
                data.get("plain_english_template").and_then(|v| v.as_str()).map(|s| s.to_string())
            } else {
                cur_template
            };
            let create_alert = data.get("create_alert").and_then(|v| v.as_bool()).unwrap_or(cur_create_alert);
            let send_email = data.get("send_email").and_then(|v| v.as_bool()).unwrap_or(cur_send_email);
            let send_webhook = data.get("send_webhook").and_then(|v| v.as_bool()).unwrap_or(cur_send_webhook);
            let play_sound = data.get("play_sound").and_then(|v| v.as_bool()).unwrap_or(cur_play_sound);

            let suppress_start = if data.get("suppress_start_hour").is_some() {
                data.get("suppress_start_hour").and_then(|v| v.as_i64()).map(|n| n as i32)
            } else {
                cur_sup_start
            };
            let suppress_end = if data.get("suppress_end_hour").is_some() {
                data.get("suppress_end_hour").and_then(|v| v.as_i64()).map(|n| n as i32)
            } else {
                cur_sup_end
            };

            let now = chrono::Utc::now().naive_utc().to_string();

            sqlx::query(
                "UPDATE trap_rules SET name = ?, description = ?, trap_oid_pattern = ?, severity = ?, plain_english_template = ?, create_alert = ?, send_email = ?, send_webhook = ?, play_sound = ?, suppress_start_hour = ?, suppress_end_hour = ?, updated_at = ? WHERE id = ?"
            )
            .bind(name)
            .bind(description)
            .bind(pattern)
            .bind(severity)
            .bind(template)
            .bind(if create_alert { 1 } else { 0 })
            .bind(if send_email { 1 } else { 0 })
            .bind(if send_webhook { 1 } else { 0 })
            .bind(if play_sound { 1 } else { 0 })
            .bind(suppress_start)
            .bind(suppress_end)
            .bind(&now)
            .bind(id)
            .execute(&*pool).await.map_err(|e| e.to_string())?;

            Ok(serde_json::json!({ "message": "Rule updated" }))
        }

        ("PATCH", ["traps", "rules", id_str, "toggle"]) if id_str.parse::<i32>().is_ok() => {
            let id = id_str.parse::<i32>().unwrap();
            let existing = sqlx::query("SELECT is_enabled FROM trap_rules WHERE id = ?")
                .bind(id)
                .fetch_optional(&*pool).await.map_err(|e| e.to_string())?;
            let row = match existing {
                Some(r) => r,
                None => return Err("Rule not found".to_string()),
            };
            let is_enabled: bool = row.try_get("is_enabled").unwrap_or(true);
            let new_val = !is_enabled;

            sqlx::query("UPDATE trap_rules SET is_enabled = ? WHERE id = ?")
                .bind(if new_val { 1 } else { 0 })
                .bind(id)
                .execute(&*pool).await.map_err(|e| e.to_string())?;

            Ok(serde_json::json!({ "id": id, "is_enabled": new_val }))
        }

        ("DELETE", ["traps", "rules", id_str]) if id_str.parse::<i32>().is_ok() => {
            let id = id_str.parse::<i32>().unwrap();
            let existing = sqlx::query("SELECT id FROM trap_rules WHERE id = ?")
                .bind(id)
                .fetch_optional(&*pool).await.map_err(|e| e.to_string())?;
            if existing.is_none() {
                return Err("Rule not found".to_string());
            }

            sqlx::query("DELETE FROM trap_rules WHERE id = ?")
                .bind(id)
                .execute(&*pool).await.map_err(|e| e.to_string())?;

            Ok(serde_json::json!({ "message": "Rule deleted" }))
        }

        ("GET", ["reports", "summary"]) => {
            let days = params.get("days").and_then(|v| v.as_i64()).unwrap_or(7);
            let since = (chrono::Utc::now() - chrono::Duration::days(days)).naive_utc().to_string();

            let total_devices: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM devices WHERE is_active = 1")
                .fetch_one(&*pool).await.map_err(|e| e.to_string())?;

            let total_alerts: i64 = sqlx::query_scalar("SELECT COUNT(a.id) FROM alerts a JOIN devices d ON a.device_id = d.id WHERE a.timestamp >= ?")
                .bind(&since)
                .fetch_one(&*pool).await.map_err(|e| e.to_string())?;

            let critical_alerts: i64 = sqlx::query_scalar("SELECT COUNT(a.id) FROM alerts a JOIN devices d ON a.device_id = d.id WHERE a.timestamp >= ? AND a.severity = 'critical'")
                .bind(&since)
                .fetch_one(&*pool).await.map_err(|e| e.to_string())?;

            let total_traps: i64 = sqlx::query_scalar("SELECT COUNT(t.id) FROM trap_events t JOIN devices d ON t.device_id = d.id WHERE t.timestamp >= ?")
                .bind(&since)
                .fetch_one(&*pool).await.map_err(|e| e.to_string())?;

            let mut alerts_by_day = Vec::new();
            for i in 0..days {
                let day_start = (chrono::Utc::now().date_naive() - chrono::Duration::days(days - i - 1)).and_hms_opt(0, 0, 0).unwrap();
                let day_end = day_start + chrono::Duration::days(1);
                
                let count: i64 = sqlx::query_scalar("SELECT COUNT(a.id) FROM alerts a JOIN devices d ON a.device_id = d.id WHERE a.timestamp >= ? AND a.timestamp < ?")
                    .bind(&day_start.to_string())
                    .bind(&day_end.to_string())
                    .fetch_one(&*pool).await.map_err(|e| e.to_string())?;
                    
                alerts_by_day.push(serde_json::json!({
                    "date": day_start.format("%Y-%m-%d").to_string(),
                    "count": count,
                }));
            }

            Ok(serde_json::json!({
                "period_days": days,
                "total_devices": total_devices,
                "total_alerts": total_alerts,
                "critical_alerts": critical_alerts,
                "total_traps": total_traps,
                "alerts_by_day": alerts_by_day,
                "generated_at": chrono::Utc::now().to_rfc3339(),
            }))
        }

        ("GET", ["reports", "uptime"]) => {
            let devices_rows = sqlx::query("SELECT name, ip_address, status, uptime_seconds, last_seen, consecutive_failures FROM devices WHERE is_active = 1")
                .fetch_all(&*pool).await.map_err(|e| e.to_string())?;

            let mut list = Vec::new();
            for row in devices_rows {
                let name: String = row.try_get("name").unwrap_or_default();
                let ip: String = row.try_get("ip_address").unwrap_or_default();
                let status: String = row.try_get("status").unwrap_or_else(|_| "unknown".to_string());
                let uptime_seconds = get_opt_int_column(&row, "uptime_seconds").unwrap_or(0);
                let last_seen_dt: Option<chrono::NaiveDateTime> = row.try_get("last_seen").ok();
                let failures = get_opt_int_column(&row, "consecutive_failures").unwrap_or(0);
                
                list.push(serde_json::json!({
                    "name": name,
                    "ip": ip,
                    "status": status,
                    "uptime_hours": uptime_seconds / 3600,
                    "last_seen": last_seen_dt.map(|dt| dt.to_string()),
                    "failures": failures,
                }));
            }
            Ok(serde_json::Value::Array(list))
        }
        
        _ => {
            forward_to_sidecar(&method, &url, &params, &data, api_port.0, &secret_token.0).await
        }
    }
}

fn get_free_port(start_port: u16) -> u16 {
    for port in start_port..65535 {
        if std::net::TcpListener::bind(("127.0.0.1", port)).is_ok() {
            return port;
        }
    }
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    listener.local_addr().unwrap().port()
}

fn generate_token() -> String {
    use rand::RngCore;
    let mut key = [0u8; 16];
    rand::thread_rng().fill_bytes(&mut key);
    hex::encode(key)
}

fn open_path_or_url(path: &str) {
    #[cfg(target_os = "macos")]
    std::process::Command::new("open").arg(path).spawn().ok();

    #[cfg(target_os = "linux")]
    std::process::Command::new("xdg-open").arg(path).spawn().ok();

    #[cfg(target_os = "windows")]
    std::process::Command::new("cmd").args(&["/c", "start", path]).spawn().ok();
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let port = get_free_port(8765);
    let token = generate_token();

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_autostart::Builder::new().build())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_log::Builder::new().build())
        .manage(SidecarChild(Mutex::new(None)))
        .manage(ApiPort(port))
        .manage(SecretToken(token.clone()))
        .invoke_handler(tauri::generate_handler![
            get_app_version,
            get_user_data_path,
            get_auto_launch,
            set_auto_launch,
            start_update_download,
            install_update_now,
            check_for_updates_now,
            open_releases_page,
            handle_api_request
        ])
        .setup(move |app| {
            let app_dir = app.path().app_data_dir().expect("Failed to get AppData directory");
            std::fs::create_dir_all(app_dir.join("data").join("mibs")).ok();

            // Locate .env and copy .env.example if missing
            let env_file = app_dir.join(".env");
            if !env_file.exists() {
                if let Ok(resource_dir) = app.path().resource_dir() {
                    let example_file = resource_dir.join(".env.example");
                    if example_file.exists() {
                        std::fs::copy(example_file, env_file).ok();
                    }
                }
            }

            // Copy bundled MIBs to appData/data/mibs
            if let Ok(resource_dir) = app.path().resource_dir() {
                let mibs_dir = resource_dir.join("mibs");
                if mibs_dir.exists() {
                    if let Ok(entries) = std::fs::read_dir(mibs_dir) {
                        for entry in entries.flatten() {
                            let path = entry.path();
                            if path.is_file() {
                                if let Some(filename) = path.file_name() {
                                    let dest = app_dir.join("data").join("mibs").join(filename);
                                    if !dest.exists() {
                                        std::fs::copy(path, dest).ok();
                                    }
                                }
                            }
                        }
                    }
                }
            }

            let db_path = app_dir.join("nms.db").to_string_lossy().to_string();
            let log_path = app_dir.join("nms.log").to_string_lossy().to_string();

            // Pre-create the database file if it does not exist to prevent sqlx connection failure
            let db_file_path = std::path::Path::new(&db_path);
            if !db_file_path.exists() {
                if let Some(parent) = db_file_path.parent() {
                    let _ = std::fs::create_dir_all(parent);
                }
                let _ = std::fs::File::create(db_file_path);
            }

            // Create SQLite Connection Pool and manage it
            let db_url = format!("sqlite://{}?mode=rwc", db_path);
            let pool = tauri::async_runtime::block_on(async {
                sqlx::sqlite::SqlitePoolOptions::new()
                    .max_connections(10)
                    .connect(&db_url)
                    .await
                    .expect("Failed to connect to SQLite")
            });
            app.manage(pool.clone());

            // Create Bandwidth Cache and manage it
            let cache: snmp_poller::BandwidthCache = std::sync::Arc::new(std::sync::Mutex::new(std::collections::HashMap::new()));
            app.manage(cache.clone());

            // Spawns Python Sidecar
            log::info!("Spawning nms-backend sidecar on port {}...", port);
            let sidecar = app.shell().sidecar("nms-backend")
                .expect("Failed to locate nms-backend sidecar")
                .args(&[
                    "--host", "127.0.0.1",
                    "--port", &port.to_string(),
                    "--log-level", "warning"
                ])
                .env("SECRET_TOKEN", &token)
                .env("APP_MODE", "desktop")
                .env("SQLITE_DB_PATH", &db_path)
                .env("LOG_FILE", &log_path);

            let (mut rx, child) = sidecar.spawn()
                .expect("Failed to spawn nms-backend sidecar");

            // Store sidecar child handle
            *app.state::<SidecarChild>().0.lock().unwrap() = Some(child);

            let app_handle_stdout = app.handle().clone();
            // Forward sidecar output to system logs
            tauri::async_runtime::spawn(async move {
                use tauri_plugin_shell::process::CommandEvent;
                use tauri::Emitter;
                while let Some(event) = rx.recv().await {
                    match event {
                        CommandEvent::Stdout(line) => {
                            let line_str = String::from_utf8_lossy(&line);
                            let trimmed = line_str.trim();
                            if trimmed.starts_with("TAURI_EVENT:") {
                                if let Some(json_str) = trimmed.strip_prefix("TAURI_EVENT:") {
                                    if let Ok(event_val) = serde_json::from_str::<serde_json::Value>(json_str) {
                                        if let (Some(ev_type), Some(ev_data)) = (event_val.get("type").and_then(|v| v.as_str()), event_val.get("data")) {
                                            if ev_type == "device_update" {
                                                app_handle_stdout.emit(ev_type, ev_data).ok();
                                            } else {
                                                let payload = serde_json::json!({
                                                    "data": ev_data,
                                                    "ts": event_val.get("ts").and_then(|v| v.as_str()).unwrap_or("")
                                                });
                                                app_handle_stdout.emit(ev_type, payload).ok();
                                            }
                                        }
                                    }
                                }
                            } else {
                                log::info!("[sidecar stdout] {}", trimmed);
                            }
                        }
                        CommandEvent::Stderr(line) => {
                            log::error!("[sidecar stderr] {}", String::from_utf8_lossy(&line).trim());
                        }
                        CommandEvent::Terminated(status) => {
                            log::info!("[sidecar exit] {:?}", status);
                            break;
                        }
                        _ => {}
                    }
                }
            });

            // Start SNMP Poller
            let pool_clone = pool.clone();
            let cache_clone = cache.clone();
            let token_clone = token.clone();
            let app_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                snmp_poller::start_poller(pool_clone, cache_clone, port, token_clone, app_handle).await;
            });

            // Start SNMP Trap Listener
            let token_clone = token.clone();
            tauri::async_runtime::spawn(async move {
                trap_listener::start_trap_listener(port, token_clone).await;
            });

            // Setup Main Window programmatically to inject initialization_script
            let preload_js = include_str!("../preload.js");
            let window = tauri::WebviewWindowBuilder::new(
                app,
                "main",
                tauri::WebviewUrl::App("index.html".into())
            )
            .title("SentinelNMS")
            .inner_size(1280.0, 820.0)
            .resizable(true)
            .fullscreen(false)
            .initialization_script(preload_js)
            .build()
            .unwrap();

            // Prevent close and hide to system tray instead
            let window_clone = window.clone();
            window.on_window_event(move |event| {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    window_clone.hide().unwrap();
                    api.prevent_close();
                }
            });

            // Setup System Tray
            let quit_i = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let open_i = MenuItem::with_id(app, "open", "Open SentinelNMS", true, None::<&str>)?;
            let open_db_i = MenuItem::with_id(app, "open_dashboard", "Open Dashboard", true, None::<&str>)?;
            let open_logs_i = MenuItem::with_id(app, "open_logs", "Open Logs Folder", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&open_i, &open_db_i, &open_logs_i, &quit_i])?;

            let _tray = TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .menu(&menu)
                .on_menu_event(move |handle, event| {
                    match event.id.as_ref() {
                        "quit" => {
                            if let Some(child) = handle.state::<SidecarChild>().0.lock().unwrap().take() {
                                    let _ = child.kill();
                            }
                            handle.exit(0);
                        }
                        "open" => {
                            if let Some(win) = handle.get_webview_window("main") {
                                win.show().unwrap();
                                win.set_focus().unwrap();
                            }
                        }
                        "open_dashboard" => {
                            let api_port = handle.state::<ApiPort>().0;
                            open_path_or_url(&format!("http://127.0.0.1:{}", api_port));
                        }
                        "open_logs" => {
                            let app_dir = handle.path().app_data_dir().unwrap();
                            open_path_or_url(&app_dir.to_string_lossy());
                        }
                        _ => {}
                    }
                })
                .build(app)?;

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|app_handle, event| {
        if let tauri::RunEvent::ExitRequested { .. } = event {
            if let Some(child) = app_handle.state::<SidecarChild>().0.lock().unwrap().take() {
                let _ = child.kill();
            }
        }
    });
}
