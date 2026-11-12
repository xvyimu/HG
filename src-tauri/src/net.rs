//! 网络层：与上游站点对话。
//!
//! 站点把全部 `/api/**` 调用收敛成 `POST /api/edge/request` 的信封，
//! 我们只实现这一个入口，其余接口都是「填 path」。

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use once_cell::sync::Lazy;
use serde_json::{json, Value};
use std::time::Duration;

pub const DEFAULT_BASE: &str = "https://huangguoai.com";

/// 备用线路：站点换域名时不必重新发版。
/// 只收同一注册域名下的主机 —— 探活成功就会带上 Bearer token 请求，
/// 收进第三方站点等于把登录凭据发出去。
pub const CANDIDATES: &[&str] = &["https://huangguoai.com", "https://api.huangguoai.com"];

static BASE_CUR: Lazy<std::sync::RwLock<String>> =
    Lazy::new(|| std::sync::RwLock::new(DEFAULT_BASE.to_string()));

/// 当前生效的上游地址（运行时可换）
pub fn base() -> String {
    BASE_CUR
        .read()
        .map(|s| s.clone())
        .unwrap_or_else(|_| DEFAULT_BASE.to_string())
}

fn set_base(v: &str) {
    if let Ok(mut w) = BASE_CUR.write() {
        if w.as_str() != v {
            *w = v.to_string();
        }
    }
}

/// 只认「请求根本没发出去」的错误。
/// 注意别用宽泛的 `connect`：`HTTP 500 {"msg":"database connection error"}`
/// 这类业务失败会被误判成线路故障，进而换线路重发（写操作会重复）。
fn is_conn_err(e: &str) -> bool {
    if e.starts_with("HTTP ") || e.starts_with("登录已过期") {
        return false;
    }
    let l = e.to_lowercase();
    [
        "error sending request",
        "connection refused",
        "connection reset",
        "connection closed",
        "failed to lookup",
        "dns error",
        "tcp connect error",
        "os error 10060",
        "os error 10054",
        "timed out",
    ]
    .iter()
    .any(|k| l.contains(k))
}

/// 单线路探活：最小的列表请求，返回 status=1 才算通
async fn probe_host(host: &str) -> bool {
    let url = format!("{host}/api/edge/request");
    let envelope = json!({
        "method": "GET",
        "path": "/api/videos?page=1&size=1",
        "body": "",
        "content_type": "",
    });
    let resp = match CLIENT
        .post(&url)
        .header("Accept", "application/json")
        .header("Referer", format!("{host}/"))
        .timeout(Duration::from_secs(2))
        .json(&envelope)
        .send()
        .await
    {
        Ok(r) => r,
        Err(_) => return false,
    };
    if !resp.status().is_success() {
        return false;
    }
    let text = match resp.text().await {
        Ok(t) => t,
        Err(_) => return false,
    };
    serde_json::from_str::<Value>(&text)
        .map(|v| v.get("status").and_then(|s| s.as_i64()) == Some(1))
        .unwrap_or(false)
}

/// 选路：当前线路通就直接用；不通则并发探候选。
/// `skip_cur` 用于「刚才就是这条线路连不上」的场景，省掉一次必然失败的探测。
pub async fn pick_base_ex(skip_cur: bool) -> String {
    let cur = base();
    if !skip_cur && probe_host(&cur).await {
        return cur;
    }
    let others: Vec<&str> = CANDIDATES.iter().copied().filter(|c| *c != cur.as_str()).collect();
    match others.as_slice() {
        [] => cur,
        [a] => {
            if probe_host(a).await {
                set_base(a);
                (*a).to_string()
            } else {
                cur
            }
        }
        [a, b, ..] => {
            /* 候选并发探活，最坏 2s 而不是 4s */
            let (oka, okb) = tokio::join!(probe_host(a), probe_host(b));
            if oka {
                set_base(a);
                (*a).to_string()
            } else if okb {
                set_base(b);
                (*b).to_string()
            } else {
                cur
            }
        }
    }
}

/// 启动时用：当前线路优先
pub async fn pick_base() -> String {
    pick_base_ex(false).await
}

pub const UA: &str =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

pub static CLIENT: Lazy<reqwest::Client> = Lazy::new(|| {
    reqwest::Client::builder()
        .user_agent(UA)
        .timeout(Duration::from_secs(20))
        .connect_timeout(Duration::from_secs(10))
        .gzip(true)
        .brotli(true)
        .pool_idle_timeout(Duration::from_secs(60))
        .build()
        .expect("build http client")
});

/// 站点偶发 TLS 抖动（实测），统一重试。
async fn with_retry<F, Fut, T>(mut f: F) -> Result<T, String>
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = Result<T, String>>,
{
    let mut last = String::from("network error");
    for attempt in 0..3 {
        match f().await {
            Ok(v) => return Ok(v),
            Err(e) => {
                last = e;
                if attempt < 2 {
                    tokio::time::sleep(Duration::from_millis(350 * (attempt as u64 + 1))).await;
                }
            }
        }
    }
    Err(last)
}

/// 单次往返（内部自带 3 次重试）。
async fn edge_once(host: &str, envelope: &Value, token: Option<&str>) -> Result<Value, String> {
    let url = format!("{host}/api/edge/request");
    let referer = format!("{host}/");
    let token = token.map(|s| s.to_string());

    with_retry(|| {
        let envelope = envelope.clone();
        let token = token.clone();
        let url = url.clone();
        let referer = referer.clone();
        async move {
            let mut req = CLIENT
                .post(&url)
                .header("Accept", "application/json")
                .header("Referer", referer)
                .json(&envelope);
            if let Some(t) = token.as_deref() {
                if !t.is_empty() {
                    req = req.header("Authorization", format!("Bearer {t}"));
                }
            }
            let resp = req.send().await.map_err(|e| e.to_string())?;
            let status = resp.status();
            let text = resp.text().await.map_err(|e| e.to_string())?;
            if status.as_u16() == 401 || status.as_u16() == 403 {
                return Err("登录已过期，请重新登录".to_string());
            }
            if !status.is_success() {
                return Err(format!("HTTP {status}: {}", &text[..text.len().min(160)]));
            }
            if text.trim().is_empty() {
                return Ok(Value::Null);
            }
            serde_json::from_str::<Value>(&text).map_err(|e| format!("{e}: {}", &text[..text.len().min(160)]))
        }
    })
    .await
}

/// 业务请求：走边缘信封。连接层失败时自动换线路再打一次。
pub async fn edge(
    method: &str,
    path: &str,
    body: Option<Value>,
    token: Option<&str>,
) -> Result<Value, String> {
    let (encoded, ctype) = match &body {
        Some(v) => (
            B64.encode(serde_json::to_vec(v).map_err(|e| e.to_string())?),
            "application/json",
        ),
        None => (String::new(), ""),
    };
    let envelope = json!({
        "method": method,
        "path": path,
        "body": encoded,
        "content_type": ctype,
    });

    let mut host = base();
    let mut out = edge_once(&host, &envelope, token).await;
    if out.as_ref().err().map(|e| is_conn_err(e)).unwrap_or(false) {
        let next = pick_base_ex(true).await;
        if next != host {
            host = next;
            out = edge_once(&host, &envelope, token).await;
        }
    }
    let value = out?;

    if value.is_null() {
        return Ok(Value::Null);
    }

    if value.get("status").and_then(|v| v.as_i64()) == Some(1) {
        Ok(value.get("data").cloned().unwrap_or(Value::Null))
    } else {
        Err(value
            .get("msg")
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())
            .unwrap_or("接口返回失败")
            .to_string())
    }
}

/// 拉原始字节（图片 / m3u8 / 分片）。
pub async fn fetch_bytes(url: &str) -> Result<(Option<String>, Vec<u8>), String> {
    let url = url.to_string();
    with_retry(|| {
        let url = url.clone();
        async move {
            let resp = CLIENT
                .get(&url)
                .header("Referer", format!("{}/", base()))
                .send()
                .await
                .map_err(|e| e.to_string())?;
            if !resp.status().is_success() {
                return Err(format!("HTTP {}", resp.status()));
            }
            let ctype = resp
                .headers()
                .get(reqwest::header::CONTENT_TYPE)
                .and_then(|v| v.to_str().ok())
                .map(|s| s.to_string());
            let bytes = resp.bytes().await.map_err(|e| e.to_string())?.to_vec();
            Ok((ctype, bytes))
        }
    })
    .await
}
