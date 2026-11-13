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

/// 代理与客户端放在同一把锁里：换代理时两者必须同时生效，
/// 否则会出现「current_proxy 显示走代理、实际请求直连」。（历史上踩过）
struct Net {
    proxy: Option<String>,
    client: reqwest::Client,
}

fn detect_proxy() -> Option<String> {
    if let Ok(p) = std::env::var("HGHUB_PROXY") {
        let p = p.trim().to_string();
        if !p.is_empty() {
            note_proxy("proxy from env HGHUB_PROXY");
            return Some(p);
        }
    }
    /* 外部可写文件优先于私有目录：非 root 手机只能改前者 */
    for f in [ANDROID_PROXY_FILE_EXT, ANDROID_PROXY_FILE] {
        if let Ok(p) = std::fs::read_to_string(f) {
            let p = p.trim().to_string();
            if !p.is_empty() {
                note_proxy(&format!("proxy from {f}"));
                return Some(p);
            }
        }
    }
    note_proxy("proxy=none");
    None
}

fn build_client(proxy: Option<&reqwest::Proxy>) -> Option<reqwest::Client> {
    let mut b = reqwest::Client::builder()
        .user_agent(UA)
        .timeout(Duration::from_secs(20))
        .connect_timeout(Duration::from_secs(10))
        .gzip(true)
        .brotli(true)
        .pool_idle_timeout(Duration::from_secs(60));
    if let Some(px) = proxy {
        b = b.proxy(px.clone());
    }
    b.build().ok()
}

/// 建不出带代理的客户端就退回直连（并如实记下 proxy=None），
/// 连直连都建不出来说明本机 TLS/解析器不可用，属于环境级故障，只能 panic 且信息要明确。
fn client_for(proxy: &Option<String>) -> (Option<String>, reqwest::Client) {
    if let Some(p) = proxy.as_deref() {
        if let Ok(px) = reqwest::Proxy::all(p) {
            if let Some(c) = build_client(Some(&px)) {
                return (proxy.clone(), c);
            }
            note_proxy(&format!("proxy build failed, fallback direct: {p}"));
        } else {
            note_proxy(&format!("proxy invalid, fallback direct: {p}"));
            return (None, client_for(&None).1);
        }
    }
    match build_client(None) {
        Some(c) => (None, c),
        None => {
            note_proxy("client build failed: no usable http stack");
            panic!("初始化 HTTP 客户端失败：TLS 后端或系统解析器不可用")
        }
    }
}

/// 客户端可重建：应用内改代理后立刻生效，不用重启。
/// 首次读取时的来源优先级：env HGHUB_PROXY → 外部可写文件（非 root）→ 应用私有文件（root）。
static NET: Lazy<std::sync::RwLock<Net>> = Lazy::new(|| {
    let (proxy, client) = client_for(&detect_proxy());
    std::sync::RwLock::new(Net { proxy, client })
});

/// 取当前客户端（内部是 Arc，克隆很便宜）
pub fn http() -> reqwest::Client {
    match NET.read() {
        Ok(g) => g.client.clone(),
        Err(e) => e.into_inner().client.clone(),
    }
}

/// 运行时设置代理：空串 = 直连。立即重建客户端；非法地址直接拒绝，不写入状态。
pub fn set_proxy(p: &str) {
    let v = p.trim();
    let opt = if v.is_empty() { None } else { Some(v.to_string()) };
    if let Some(s) = opt.as_deref() {
        if reqwest::Proxy::all(s).is_err() {
            note_proxy(&format!("proxy rejected (invalid): {s}"));
            return;
        }
    }
    /* 锁外建好客户端，持锁只做一次赋值 */
    let (proxy, client) = client_for(&opt);
    let mut w = NET.write().unwrap_or_else(|e| e.into_inner());
    w.proxy = proxy.clone();
    w.client = client;
    note_proxy(&format!("proxy set {}", proxy.as_deref().unwrap_or("none")));
}

#[allow(dead_code)] /* 预留给后续代理设置 UI / 诊断用 */
pub fn current_proxy() -> Option<String> {
    match NET.read() {
        Ok(g) => g.proxy.clone(),
        Err(e) => e.into_inner().proxy.clone(),
    }
}

/// 应用私有路径（需 root 才能写）
const ANDROID_PROXY_FILE: &str = "/data/data/com.hghub.huangguo/files/proxy.txt";
/// 外部可写路径：文件管理器/电脑传进去即可，非 root 可用
const ANDROID_PROXY_FILE_EXT: &str =
    "/sdcard/Android/data/com.hghub.huangguo/files/proxy.txt";

/// 调试留痕：CLIENT 初始化时用的代理（写不进就算了）
fn note_proxy(msg: &str) {
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open("/data/data/com.hghub.huangguo/files/proxy.log")
    {
        use std::io::Write;
        let _ = writeln!(f, "{msg}");
    }
}

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
        let resp = http()
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
