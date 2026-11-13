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

/// 只处理「本机 / 内网」代理：这是唯一能确定「代理程序没开」的场景。
/// 远端代理慢、或只在特定线路可用都属正常波动，动它风险大于收益。
fn is_local_proxy(p: &str) -> bool {
    let host = p
        .split("://")
        .nth(1)
        .unwrap_or(p)
        .split(['/', ':'])
        .next()
        .unwrap_or("")
        .to_ascii_lowercase();
    if host.is_empty() {
        return false;
    }
    host == "localhost"
        || host == "::1"
        || host == "[::1]"
        || host.starts_with("127.")
        || host.starts_with("10.")
        || host.starts_with("192.168.")
        || (host.starts_with("172.")
            && host
                .split('.')
                .nth(1)
                .and_then(|s| s.parse::<u8>().ok())
                .map(|n| (16..=31).contains(&n))
                .unwrap_or(false))
}

/// 不经当前代理、直接连一次 base（只判连接是否成立，不解析业务）
async fn direct_reachable() -> bool {
    let Some(c) = build_client(None) else { return false };
    match c
        .get(format!("{}/", base()))
        .timeout(Duration::from_secs(8))
        .send()
        .await
    {
        Ok(r) => r.status().as_u16() < 500,
        Err(_) => false,
    }
}

/// 启动自检：残留的本机代理指向已关闭的端口时，回退直连。
/// 判据刻意保守——连续两次探活失败、直连确认可达、且期间配置没被别人改过，三条同时成立才提交。
pub async fn heal_proxy() -> bool {
    let Some(old) = current_proxy() else { return false };
    if !is_local_proxy(&old) {
        return false;
    }
    let mut alive = false;
    for i in 0..2 {
        if probe_host(&base()).await {
            alive = true;
            break;
        }
        if i == 0 {
            tokio::time::sleep(Duration::from_millis(600)).await;
        }
    }
    if alive {
        return false;
    }
    if !direct_reachable().await {
        note_proxy("proxy unreachable but direct also unreachable; keep as is");
        return false;
    }
    if current_proxy().as_deref() != Some(old.as_str()) {
        note_proxy("proxy changed during heal; skip rollback");
        return false;
    }
    set_proxy("");
    note_proxy(&format!(
        "local proxy {old} unreachable, rolled back to {}",
        current_proxy().unwrap_or_else(|| "direct".into())
    ));
    true
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
    let msg = format!("proxy set {}", proxy.as_deref().unwrap_or("none"));
    {
        let mut w = NET.write().unwrap_or_else(|e| e.into_inner());
        w.proxy = proxy;
        w.client = client;
    } /* 先放锁：http() 在每次请求/每张封面/每个分片都要拿读锁，别让写磁盘卡在锁里 */
    note_proxy(&msg);
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

/// 调试留痕：代理相关决策（写不进就算了）
fn note_proxy(msg: &str) {
    use std::io::Write;
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open("/data/data/com.hghub.huangguo/files/proxy.log")
    {
        let _ = writeln!(f, "{msg}");
    } else {
        /* 桌面端没有 Android 私有目录，降级到 stderr，别让诊断线索凭空消失 */
        eprintln!("[proxy] {msg}");
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
    let mut last = String::from("network error"); /* 只有全失败才用得上 */
    for attempt in 0..2 {
        let sent = http()
            .get(url)
            .header("Referer", format!("{}/", base()))
            .timeout(Duration::from_secs(20))
            .send()
            .await;
        let resp = match sent {
            Ok(r) => r,
            Err(e) => {
                /* 连接层失败也值得再试一次：代理刚起来 / 线路刚切换时会命中一次 */
                last = format!("error sending request: {e}");
                if attempt == 0 {
                    tokio::time::sleep(Duration::from_millis(250)).await;
                }
                continue;
            }
        };
        if !resp.status().is_success() {
            let code = resp.status();
            last = format!("HTTP {code}");
            /* 4xx 是永久性失败（签名过期/权限），重试只会让播放器多等一轮 */
            if code.as_u16() < 500 {
                return Err(last);
            }
            if attempt == 0 {
                tokio::time::sleep(Duration::from_millis(250)).await;
            }
            continue;
        }
        let ctype = resp
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .map(|s| s.to_string());
        match resp.bytes().await {
            Ok(b) => return Ok((ctype, b.to_vec())),
            Err(e) => {
                last = e.to_string();
                if attempt == 0 {
                    tokio::time::sleep(Duration::from_millis(250)).await;
                }
            }
        }
    }
    Err(last)
}

/// 媒体代理里偶尔需要把 base64 参数还原
#[allow(dead_code)]
pub fn decode_b64(s: &str) -> Option<Vec<u8>> {
    STANDARD.decode(s).ok().or_else(|| URL_SAFE_NO_PAD.decode(s).ok())
}
