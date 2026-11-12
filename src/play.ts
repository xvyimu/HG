/**
 * 播放地址解析：纯函数，不依赖 Tauri / React，便于单测。
 *
 * 上游 `/api/videos/{id}/play` 返回结构会变（字段改名、加壳、空串），
 * 这里做宽松取值，避免上游一改字段客户端就提示「暂无播放地址」。
 */

/** 明确是播放地址的字段，按历史与常见命名排序 */
const PLAY_KEYS = ["video_url", "video_url_hevc", "hls_url", "play_url", "playUrl", "m3u8"];

/** 语义模糊的字段，只在前面的都没命中、且看着像媒体时才用 */
const LAZY_KEYS = ["url", "src", "video", "videoUrl"];

const isHttp = (v: unknown): v is string => typeof v === "string" && /^https?:\/\//i.test(v);
const isM3u8 = (v: unknown): v is string => typeof v === "string" && /^https?:\/\/\S+\.m3u8/i.test(v);
/** 模糊字段必须带媒体特征，否则会把分享页/详情页地址喂给播放器 */
const looksMedia = (v: unknown): v is string =>
  typeof v === "string" &&
  /^https?:\/\//i.test(v) &&
  (/\.(m3u8|mp4|m4v|ts|flv|webm)(\?|$)/i.test(v) || /[?&](?:format|type)=m3u8/i.test(v) || /\/hls\//i.test(v));

/**
 * 从 `/play` 响应里取一个可用地址。
 * 顺序：明确的地址字段 → 任意 `.m3u8` 值 → `url`/`src` 这类模糊字段（排除网页地址）。
 */
export function pickPlayUrl(data: unknown): string {
  if (typeof data === "string") return isHttp(data) ? data : "";
  if (!data || typeof data !== "object") return "";
  const obj = data as Record<string, unknown>;

  for (const k of PLAY_KEYS) {
    const v = obj[k];
    if (isHttp(v)) return v;
  }

  for (const v of Object.values(obj)) {
    if (isM3u8(v)) return v;
  }

  for (const k of LAZY_KEYS) {
    const v = obj[k];
    if (looksMedia(v)) return v;
  }
  return "";
}

/** 把地址里的签名参数打码，避免 auth_key 落进 debug.log */
const scrub = (s: string) => s.replace(/(auth_key|token|sign|signature|key)=[^&\s]+/gi, "$1=***");

/** 上游返回体里所有非空字符串字段，写进诊断日志/报错文案 */
export function playFieldReport(data: unknown): string {
  if (!data || typeof data !== "object") return scrub(String(data)).slice(0, 80);
  return Object.entries(data as Record<string, unknown>)
    .filter(([, v]) => typeof v === "string" && v.length > 0)
    .map(([k, v]) => `${k}=${scrub(String(v)).slice(0, 64)}`)
    .join(" ");
}

/** auth_key / expire 里的时间戳 → 过期秒；取不到按 45 分钟估 */
export function playUrlExpiry(url: string, now = Date.now() / 1000): number {
  const m = /[?&][a-z_]*auth_key=(\d{9,11})/i.exec(url)
    || /[?&](?:expire|expires|exp|e|deadline)=(\d{9,11})/i.exec(url);
  if (m) {
    const t = Number(m[1]);
    if (t > now - 86_400) return t;
  }
  return now + 45 * 60;
}
