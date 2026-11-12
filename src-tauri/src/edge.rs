//! dx150-edge-v1 加密通道：ECDH(P-256) → HKDF-SHA256 → AES-256-GCM。
//!
//! 站点 2026-11-12 起把 `/api/edge/request` 明文信封换成四条加密通道：
//! `/api/{public,dynamic,playback,user}/request`。握手用 hello 交换临时公钥，
//! 之后每次调用带自增序号与时间戳，AAD 绑定 (info, 方向, seq, ts)。

use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Nonce};
use base64::engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD};
use base64::Engine;
use hkdf::Hkdf;
use once_cell::sync::Lazy;
use p256::ecdh::EphemeralSecret;
use p256::elliptic_curve::sec1::ToEncodedPoint;
use p256::PublicKey;
use rand_core::OsRng;
use serde_json::{json, Value};
use sha2::Sha256;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use crate::edge_routes::ROUTES;
use crate::net::{base, pick_base_ex, CLIENT, UA};

const PROTOCOL: &str = "dx150-edge-v1";
const MAX_SEQ: u32 = 16384;

fn now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn b64u(bytes: &[u8]) -> String {
    URL_SAFE_NO_PAD.encode(bytes)
}

fn unb64u(s: &str) -> Result<Vec<u8>, String> {
    URL_SAFE_NO_PAD
        .decode(s.trim_end_matches('='))
        .map_err(|e| format!("base64: {e}"))
}

fn nonce_of(seq: u32) -> [u8; 12] {
    let mut iv = [0u8; 12];
    iv[8..12].copy_from_slice(&seq.to_be_bytes());
    iv
}

fn derive(ikm: &[u8], salt: &[u8], info: &str) -> Result<[u8; 32], String> {
    let hk = Hkdf::<Sha256>::new(Some(salt), ikm);
    let mut okm = [0u8; 32];
    hk.expand(info.as_bytes(), &mut okm)
        .map_err(|_| "hkdf expand 失败".to_string())?;
    Ok(okm)
}

struct Session {
    kid: String,
    sid: String,
    info: String,
    req_key: [u8; 32],
    res_key: [u8; 32],
    expires_at: i64,
    offset: i64,
    seq: u32,
}

type Shared = Arc<Mutex<Session>>;

static SESSIONS: Lazy<Mutex<HashMap<String, Shared>>> = Lazy::new(|| Mutex::new(HashMap::new()));

fn cache_key(host: &str, scope: &str) -> String {
    format!("{host}|{scope}")
}

fn drop_session(host: &str, scope: &str) {
    if let Ok(mut m) = SESSIONS.lock() {
        m.remove(&cache_key(host, scope));
    }
}

/// 路径 → 加密通道作用域（表来自站点 __cloudfrontCompat.encryptedAPIRoutes）
pub fn scope_for(method: &str, path: &str) -> &'static str {
    let p = path.split('?').next().unwrap_or(path);
    for (m, pat, scope) in ROUTES {
        if *m == method && path_matches(pat, p) {
            return scope;
        }
    }
    "dynamic"
}

fn path_matches(pattern: &str, path: &str) -> bool {
    let a: Vec<&str> = pattern.split('/').collect();
    let b: Vec<&str> = path.split('/').collect();
    a.len() == b.len()
        && a.iter()
            .zip(b.iter())
            .all(|(x, y)| x.starts_with(':') || x == y)
}

async fn post(host: &str, scope: &str, body: &Value) -> Result<Value, String> {
    let url = format!("{host}/api/{scope}/request");
    let resp = CLIENT
        .post(&url)
        .header("Accept", "application/json")
        .header("Referer", format!("{host}/"))
        .timeout(Duration::from_secs(12))
        .json(body)
        .send()
        .await
        .map_err(|e| format!("error sending request: {e}"))?;
    let status = resp.status();
    let text = resp.text().await.map_err(|e| e.to_string())?;
    if status.as_u16() == 401 || status.as_u16() == 403 {
        return Err("登录已过期，请重新登录".to_string());
    }
    if !status.is_success() {
        return Err(format!("HTTP {status}: {}", &text[..text.len().min(160)]));
    }
    serde_json::from_str::<Value>(&text)
        .map_err(|e| format!("{e}: {}", &text[..text.len().min(160)]))
}

/// 握手：交换 P-256 公钥，派生请求/响应两个方向密钥。
async fn handshake(host: &str, scope: &'static str) -> Result<Shared, String> {
    let secret = EphemeralSecret::random(&mut OsRng);
    let client_pub = secret.public_key().to_encoded_point(false);
    let hello = post(
        host,
        scope,
        &json!({ "v": 1, "type": "hello", "client_pub": b64u(client_pub.as_bytes()) }),
    )
    .await?;

    if hello.get("type").and_then(|v| v.as_str()) != Some("hello") {
        return Err(format!("握手响应异常: {hello}"));
    }
    let kid = hello
        .get("kid")
        .and_then(|v| v.as_str())
        .ok_or("握手缺少 kid")?
        .to_string();
    let sid = hello
        .get("sid")
        .and_then(|v| v.as_str())
        .ok_or("握手缺少 sid")?
        .to_string();
    let site = hello
        .get("site")
        .and_then(|v| v.as_str())
        .ok_or("握手缺少 site")?
        .to_string();
    let server_time = hello
        .get("server_time")
        .and_then(|v| v.as_i64())
        .ok_or("握手缺少 server_time")?;
    let expires_at = hello
        .get("expires_at")
        .and_then(|v| v.as_i64())
        .ok_or("握手缺少 expires_at")?;

    let server_pub = PublicKey::from_sec1_bytes(&unb64u(
        hello.get("server_pub").and_then(|v| v.as_str()).ok_or("握手缺少 server_pub")?,
    )?)
    .map_err(|e| format!("服务端公钥无效: {e}"))?;
    let shared = secret.diffie_hellman(&server_pub);
    let salt = unb64u(
        hello.get("salt").and_then(|v| v.as_str()).ok_or("握手缺少 salt")?,
    )?;
    if salt.len() != 32 {
        return Err("握手 salt 长度异常".to_string());
    }

    let info = format!("{PROTOCOL}\n{scope}\n{site}\n{kid}\n{sid}");
    let req_key = derive(shared.raw_secret_bytes(), &salt, &format!("{info}\nreq"))?;
    let res_key = derive(shared.raw_secret_bytes(), &salt, &format!("{info}\nres"))?;

    let local = now();
    let session = Session {
        kid,
        sid,
        info,
        req_key,
        res_key,
        expires_at: local + (expires_at - server_time).clamp(0, 600),
        offset: server_time - local,
        seq: 0,
    };
    let shared_session = Arc::new(Mutex::new(session));
    if let Ok(mut m) = SESSIONS.lock() {
        m.insert(cache_key(host, scope), shared_session.clone());
    }
    Ok(shared_session)
}

async fn get_session(host: &str, scope: &'static str) -> Result<Shared, String> {
    let key = cache_key(host, scope);
    if let Ok(m) = SESSIONS.lock() {
        if let Some(s) = m.get(&key) {
            if let Ok(g) = s.lock() {
                if g.expires_at > now() + 5 && g.seq < MAX_SEQ {
                    return Ok(s.clone());
                }
            }
        }
    }
    handshake(host, scope).await
}

fn encrypt(key: &[u8; 32], seq: u32, aad: &str, plain: &[u8]) -> Result<Vec<u8>, String> {
    let cipher = Aes256Gcm::new_from_slice(key).map_err(|e| e.to_string())?;
    let iv = nonce_of(seq);
    cipher
        .encrypt(
            Nonce::from_slice(&iv),
            Payload { msg: plain, aad: aad.as_bytes() },
        )
        .map_err(|_| "加密失败".to_string())
}

fn decrypt(key: &[u8; 32], seq: u32, aad: &str, cipher_text: &[u8]) -> Result<Vec<u8>, String> {
    let cipher = Aes256Gcm::new_from_slice(key).map_err(|e| e.to_string())?;
    let iv = nonce_of(seq);
    cipher
        .decrypt(
            Nonce::from_slice(&iv),
            Payload { msg: cipher_text, aad: aad.as_bytes() },
        )
        .map_err(|_| "解密失败".to_string())
}

/// 单次加密调用。`retry` 为真时，遇到会话过期自愈一次。
pub async fn call(
    host: &str,
    scope: &'static str,
    request: Value,
    token: Option<&str>,
    retry: bool,
) -> Result<Value, String> {
    let session = get_session(host, scope).await?;

    /* 锁只在同步段内持有：MutexGuard 跨 await 会让 future 不是 Send */
    let mut exhausted = false;
    let prepared = {
        let mut s = session.lock().map_err(|_| "会话锁异常".to_string())?;
        if s.seq + 1 > MAX_SEQ {
            exhausted = true;
            None
        } else {
            s.seq += 1;
            let seq = s.seq;
            let ts = now() + s.offset;
            let mut packet = json!({ "request": request.clone() });
            if scope != "public" {
                if let Some(t) = token {
                    packet["authorization"] = json!(format!("Bearer {t}"));
                }
            }
            let aad = format!("{}\nreq\n{}\n{}", s.info, seq, ts);
            let plain = serde_json::to_vec(&packet).map_err(|e| e.to_string())?;
            let ct = encrypt(&s.req_key, seq, &aad, &plain)?;
            Some((s.kid.clone(), s.sid.clone(), seq, ts, ct, s.res_key, s.info.clone()))
        }
    };

    let (kid, sid, seq, ts, cipher_text, res_key, info) = match prepared {
        Some(v) => v,
        None => {
            debug_assert!(exhausted);
            drop_session(host, scope);
            return Box::pin(call(host, scope, request, token, false)).await;
        }
    };

    let payload = json!({
        "v": 1, "type": "call", "kid": kid, "sid": sid,
        "seq": seq, "ts": ts, "ciphertext": b64u(&cipher_text),
    });

    let result = match post(host, scope, &payload).await {
        Ok(v) => v,
        Err(e) => {
            /* 会话过期 / 线路抖动：重建会话再试一次 */
            if retry && (e.contains("session_expired") || e.contains("error sending request")) {
                drop_session(host, scope);
                return Box::pin(call(host, scope, request, token, false)).await;
            }
            return Err(e);
        }
    };

    if result.get("sid").and_then(|v| v.as_str()) != Some(sid.as_str())
        || result.get("seq").and_then(|v| v.as_u64()) != Some(seq as u64)
    {
        return Err("加密响应不匹配".to_string());
    }

    let aad = format!("{info}\nres\n{seq}\n{ts}");
    let ct = unb64u(
        result
            .get("ciphertext")
            .and_then(|v| v.as_str())
            .ok_or("响应缺少密文")?,
    )?;
    let plain = decrypt(&res_key, seq, &aad, &ct)?;
    let inner: Value = serde_json::from_slice(&plain).map_err(|e| format!("解密后非 JSON: {e}"))?;

    let http_status = inner.get("status").and_then(|v| v.as_i64()).unwrap_or(0);
    let body = inner.get("body").and_then(|v| v.as_str()).unwrap_or("");
    let decoded = if body.is_empty() {
        Vec::new()
    } else {
        STANDARD.decode(body).map_err(|e| format!("响应体 base64: {e}"))?
    };
    if decoded.is_empty() {
        return Ok(Value::Null);
    }
    if !(200..300).contains(&http_status) {
        return Err(format!(
            "HTTP {http_status}: {}",
            String::from_utf8_lossy(&decoded[..decoded.len().min(160)])
        ));
    }
    serde_json::from_slice::<Value>(&decoded).map_err(|e| format!("响应非 JSON: {e}"))
}

/// 选路线路探活：握手成功即视为可用
pub async fn probe(host: &str) -> bool {
    match tokio::time::timeout(Duration::from_secs(6), handshake(host, "public")).await {
        Ok(Ok(_)) => true,
        _ => false,
    }
}

/// 业务请求：连不上就换线路再打一次
pub async fn request(method: &str, path: &str, body: Option<Value>, token: Option<&str>) -> Result<Value, String> {
    let (encoded, ctype) = match &body {
        Some(v) => (
            STANDARD.encode(serde_json::to_vec(v).map_err(|e| e.to_string())?),
            "application/json",
        ),
        None => (String::new(), ""),
    };
    let packet = json!({
        "method": method,
        "path": path,
        "body": encoded,
        "content_type": ctype,
    });
    let scope = scope_for(method, path);

    let host = base();
    let out = call(&host, scope, packet.clone(), token, true).await;
    let out = match out {
        Ok(v) => Ok(v),
        Err(e) if crate::net::is_conn_err(&e) => {
            let next = pick_base_ex(true).await;
            if next != host {
                call(&next, scope, packet, token, true).await
            } else {
                Err(e)
            }
        }
        Err(e) => Err(e),
    }?;

    if out.is_null() {
        return Ok(Value::Null);
    }
    if out.get("status").and_then(|v| v.as_i64()) == Some(1) {
        Ok(out.get("data").cloned().unwrap_or(Value::Null))
    } else {
        Err(out
            .get("msg")
            .and_then(|v| v.as_str())
            .unwrap_or("接口返回失败")
            .to_string())
    }
}

#[allow(dead_code)]
fn _ua() -> &'static str {
    UA
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 真连上游验证握手 + 取址：需要 HGHUB_LIVE=1（可配合 HGHUB_PROXY 走代理）
    #[tokio::test]
    async fn live_playback() {
        if std::env::var("HGHUB_LIVE").is_err() {
            return;
        }
        let v = request("POST", "/api/videos/117/episodes/1/playback", None, None)
            .await
            .expect("playback");
        let main = v
            .get("streams")
            .and_then(|s| s.get("main"))
            .and_then(|m| m.as_str())
            .unwrap_or("");
        println!("playback main = {main}");
        assert!(main.contains(".m3u8"), "没有拿到 m3u8 地址: {v}");
    }

    #[tokio::test]
    async fn live_list() {
        if std::env::var("HGHUB_LIVE").is_err() {
            return;
        }
        let v = request("GET", "/api/videos?page=1&size=2", None, None)
            .await
            .expect("list");
        let n = v.get("items").and_then(|i| i.as_array()).map(|a| a.len()).unwrap_or(0);
        println!("list items = {n}");
        assert!(n > 0, "列表为空: {v}");
    }
}
