/**
 * 播放地址解析：纯函数，不依赖 Tauri / React，便于单测。
 *
 * 上游 `/api/videos/{id}/play` 返回结构会变（字段改名、加壳、空串），
 * 这里做宽松取值，避免上游一改字段客户端就提示「暂无播放地址」。
 */

/** 优先尝试的字段名（按历史与常见命名排序） */
const PLAY_KEYS = ["video_url", "video_url_hevc", "hls_url", "play_url", "playUrl", "m3u8", "url", "src"];

/** 从 `/play` 响应里取一个可用地址；顺序：常见字段 → 扫描任意 .m3u8 字符串 */
export function pickPlayUrl(data: unknown): string {
  if (typeof data === "string") return /^https?:\/\//i.test(data) ? data : "";
  if (!data || typeof data !== "object") return "";
  const obj = data as Record<string, unknown>;
  for (const k of PLAY_KEYS) {
    const v = obj[k];
    if (typeof v === "string" && /^https?:\/\//i.test(v)) return v;
  }
  for (const v of Object.values(obj)) {
    if (typeof v === "string" && /^https?:\/\/\S+\.m3u8/i.test(v)) return v;
  }
  return "";
}

/** 上游返回体里所有非空字符串字段，写进诊断日志/报错文案 */
export function playFieldReport(data: unknown): string {
  if (!data || typeof data !== "object") return String(data).slice(0, 80);
  return Object.entries(data as Record<string, unknown>)
    .filter(([, v]) => typeof v === "string" && v.length > 0)
    .map(([k, v]) => `${k}=${String(v).slice(0, 48)}`)
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
