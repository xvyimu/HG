//! 上游线路与 HTTP 传输。
//!
//! 站点 2026-11-12 起要求走 dx150-edge-v1 加密通道（见 `edge.rs`），
//! 本模块只负责选路、原始字节下载与连接层错误判定。

use base64::engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD};
use base64::Engine;
use once_cell::sync::Lazy;
use serde_json::Value;
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
pub fn is_conn_err(e: &str) -> bool {
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
        "decompress",
    ]
    .iter()
    .any(|k| l.contains(k))
}

/// 单线路探活：完成一次加密握手即视为可用
async fn probe_host(host: &str) -> bool {
    crate::edge::probe(host).await
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
            /* 候选并发探活，最坏 6s 而不是 12s */
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

pub const UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

static PROXY: Lazy<std::sync::RwLock<Option<String>>> = Lazy::new(|| std::sync::RwLock::new(None));

/// 调试用：app_data/proxy.txt 里写代理地址（如 http://127.0.0.1:7890）
pub fn set_proxy(p: &str) {
    if p.is_empty() {
        return;
    }
    if let Ok(mut w) = PROXY.write() {
        *w = Some(p.to_string());
    }
}

pub static CLIENT: Lazy<reqwest::Client> = Lazy::new(|| {
    let mut b = reqwest::Client::builder()
        .user_agent(UA)
        .timeout(Duration::from_secs(20))
        .connect_timeout(Duration::from_secs(10))
        .gzip(true)
        .brotli(true)
        .pool_idle_timeout(Duration::from_secs(60));
    let from_file = PROXY.read().ok().and_then(|g| g.clone());
    if let Some(p) = from_file.or_else(|| std::env::var("HGHUB_PROXY").ok()) {
        if let Ok(px) = reqwest::Proxy::all(&p) {
            b = b.proxy(px);
        }
    }
    b.build().expect("build http client")
});

/// 业务请求：走加密通道
pub async fn edge(
    method: &str,
    path: &str,
    body: Option<Value>,
    token: Option<&str>,
) -> Result<Value, String> {
    crate::edge::request(method, path, body, token).await
}

/// 拉原始字节（图片 / m3u8 / 分片）。
pub async fn fetch_bytes(url: &str) -> Result<(Option<String>, Vec<u8>), String> {
    let mut last = String::from("network error");
    for _ in 0..2 {
        let resp = CLIENT
            .get(url)
            .header("Referer", format!("{}/", base()))
            .timeout(Duration::from_secs(20))
            .send()
            .await
            .map_err(|e| format!("error sending request: {e}"))?;
        if !resp.status().is_success() {
            last = format!("HTTP {}", resp.status());
            tokio::time::sleep(Duration::from_millis(250)).await;
            continue;
        }
        let ctype = resp
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .map(|s| s.to_string());
        let bytes = resp.bytes().await.map_err(|e| e.to_string())?.to_vec();
        return Ok((ctype, bytes));
    }
    Err(last)
}

/// 媒体代理里偶尔需要把 base64 参数还原
#[allow(dead_code)]
pub fn decode_b64(s: &str) -> Option<Vec<u8>> {
    STANDARD.decode(s).ok().or_else(|| URL_SAFE_NO_PAD.decode(s).ok())
}
