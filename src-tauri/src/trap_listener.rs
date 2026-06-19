use std::collections::HashMap;
use std::net::UdpSocket;
use std::time::Duration;
use tokio::time::sleep;

#[derive(serde::Serialize)]
struct ForwardedTrap {
    source_ip: String,
    snmp_version: String,
    community: Option<String>,
    trap_oid: String,
    var_binds: HashMap<String, String>,
}

pub async fn start_trap_listener(api_port: u16, secret_token: String) {
    // Bind to UDP port 162 (standard SNMP traps).
    // On macOS/Linux, binding to port 162 requires root permissions.
    // If it fails, fall back to port 1162.
    let socket = match UdpSocket::bind("0.0.0.0:162") {
        Ok(s) => {
            log::info!("Bound SNMP Trap Listener to UDP port 162");
            s
        }
        Err(e) => {
            log::warn!("Failed to bind to UDP port 162: {}. Trying fallback port 1162...", e);
            match UdpSocket::bind("0.0.0.0:1162") {
                Ok(s) => {
                    log::info!("Bound SNMP Trap Listener to UDP port 1162");
                    s
                }
                Err(err) => {
                    log::error!("Failed to bind to fallback UDP port 1162: {}. Trap listener stopped.", err);
                    return;
                }
            }
        }
    };

    socket.set_nonblocking(true).ok();
    let tokio_socket = match tokio::net::UdpSocket::from_std(socket) {
        Ok(s) => s,
        Err(e) => {
            log::error!("Failed to convert standard UdpSocket to Tokio UdpSocket: {}", e);
            return;
        }
    };

    let mut buf = [0u8; 4096];
    let client = reqwest::Client::new();
    let python_url = format!("http://127.0.0.1:{}/api/v1/internal/trap-received", api_port);

    log::info!("SNMP Trap Listener running and waiting for traps...");

    loop {
        match tokio_socket.recv_from(&mut buf).await {
            Ok((len, src_addr)) => {
                let packet_bytes = &buf[..len];
                let source_ip = src_addr.ip().to_string();

                if let Some(parsed) = parse_snmp_trap(packet_bytes) {
                    let payload = ForwardedTrap {
                        source_ip,
                        snmp_version: parsed.version,
                        community: Some(parsed.community),
                        trap_oid: parsed.trap_oid,
                        var_binds: parsed.var_binds,
                    };

                    // Forward to Python loopback API
                    let token = secret_token.clone();
                    let url = python_url.clone();
                    let client_clone = client.clone();

                    tokio::spawn(async move {
                        match client_clone.post(&url)
                            .header("X-Secret-Token", &token)
                            .json(&payload)
                            .timeout(Duration::from_secs(5))
                            .send()
                            .await {
                                Ok(resp) => {
                                    if !resp.status().is_success() {
                                        log::warn!("Python Trap API returned status: {}", resp.status());
                                    }
                                }
                                Err(e) => {
                                    log::error!("Failed to forward trap to Python API: {}", e);
                                }
                            }
                    });
                }
            }
            Err(e) => {
                log::error!("Error receiving UDP packet: {}", e);
                sleep(Duration::from_secs(1)).await;
            }
        }
    }
}

struct ParsedTrapDetails {
    version: String,
    community: String,
    trap_oid: String,
    var_binds: HashMap<String, String>,
}

fn parse_snmp_trap(bytes: &[u8]) -> Option<ParsedTrapDetails> {
    use snmp_parser::{parse_snmp_generic_message, SnmpGenericMessage, SnmpPdu, PduType};

    let (_, msg) = parse_snmp_generic_message(bytes).ok()?;
    match msg {
        SnmpGenericMessage::V1(msg1) => {
            if let SnmpPdu::TrapV1(trap) = &msg1.pdu {
                let generic = trap.generic_trap.0;
                let trap_oid = match generic {
                    0 => "1.3.6.1.6.3.1.1.5.1".to_string(), // coldStart
                    1 => "1.3.6.1.6.3.1.1.5.2".to_string(), // warmStart
                    2 => "1.3.6.1.6.3.1.1.5.3".to_string(), // linkDown
                    3 => "1.3.6.1.6.3.1.1.5.4".to_string(), // linkUp
                    4 => "1.3.6.1.6.3.1.1.5.5".to_string(), // authenticationFailure
                    5 => "1.3.6.1.6.3.1.1.5.6".to_string(), // egpNeighborLoss
                    _ => format!("{}.{}", trap.enterprise.to_string(), trap.specific_trap),
                };

                let mut var_binds = HashMap::new();
                for vb in &trap.var {
                    let oid_str = vb.oid.to_string();
                    let val_str = format_snmp_value(&vb.val);
                    var_binds.insert(oid_str, val_str);
                }

                return Some(ParsedTrapDetails {
                    version: "v1".to_string(),
                    community: msg1.community.clone(),
                    trap_oid,
                    var_binds,
                });
            }
        }
        SnmpGenericMessage::V2(msg2) => {
            if let SnmpPdu::Generic(pdu) = &msg2.pdu {
                if pdu.pdu_type == PduType::TrapV2 {
                    let mut trap_oid = "".to_string();
                    let mut var_binds = HashMap::new();

                    for (i, vb) in pdu.var.iter().enumerate() {
                        let oid_str = vb.oid.to_string();
                        let val_str = format_snmp_value(&vb.val);
                        
                        // snmpTrapOID.0 is at OID 1.3.6.1.6.3.1.1.4.1.0 (usually second varbind)
                        if (i == 1 || oid_str.contains("1.3.6.1.6.3.1.1.4.1.0")) && trap_oid.is_empty() {
                            if let snmp_parser::snmp::VarBindValue::Value(snmp_parser::snmp::ObjectSyntax::Object(o)) = &vb.val {
                                trap_oid = o.to_string();
                            } else {
                                trap_oid = val_str.clone();
                            }
                        }
                        var_binds.insert(oid_str, val_str);
                    }

                    if trap_oid.is_empty() {
                        trap_oid = "1.3.6.1.6.3.1.1.5.0".to_string();
                    }

                    return Some(ParsedTrapDetails {
                        version: "v2c".to_string(),
                        community: msg2.community.clone(),
                        trap_oid,
                        var_binds,
                    });
                }
            }
        }
        _ => {}
    }
    None
}

fn format_snmp_value(val: &snmp_parser::snmp::VarBindValue) -> String {
    use snmp_parser::snmp::{VarBindValue, ObjectSyntax};
    match val {
        VarBindValue::Value(syntax) => match syntax {
            ObjectSyntax::Number(i) => i.to_string(),
            ObjectSyntax::String(b) => {
                if let Ok(s) = std::str::from_utf8(b) {
                    s.to_string()
                } else {
                    format!("0x{}", hex::encode(b))
                }
            }
            ObjectSyntax::Object(o) => o.to_string(),
            ObjectSyntax::BitString(bs) => format!("{:?}", bs),
            ObjectSyntax::Empty => "".to_string(),
            ObjectSyntax::IpAddress(ip) => match ip {
                snmp_parser::snmp::NetworkAddress::IPv4(ipv4) => ipv4.to_string(),
            },
            ObjectSyntax::Counter32(c) => c.to_string(),
            ObjectSyntax::Gauge32(g) => g.to_string(),
            ObjectSyntax::TimeTicks(t) => t.to_string(),
            ObjectSyntax::Opaque(b) => format!("0x{}", hex::encode(b)),
            ObjectSyntax::NsapAddress(b) => format!("0x{}", hex::encode(b)),
            ObjectSyntax::Counter64(c) => c.to_string(),
            ObjectSyntax::UInteger32(u) => u.to_string(),
            _ => format!("{:?}", syntax),
        },
        VarBindValue::Unspecified => "Unspecified".to_string(),
        VarBindValue::NoSuchObject => "NoSuchObject".to_string(),
        VarBindValue::NoSuchInstance => "NoSuchInstance".to_string(),
        VarBindValue::EndOfMibView => "EndOfMibView".to_string(),
    }
}
