import { useEffect, useState } from "react";
import { api, platform } from "../api";
import type { Detail } from "../types";
import { useStore } from "../store";
import { Avatar, Empty, Img, Modal, Toggle } from "../components/ui";
import { IBroom, IChevR, IClock, IInfo, ILink, IMoon, IStar, ISun, IUser } from "../icons";

/** 断点秒数 → mm:ss；超过 1 小时用 h:mm:ss */
function fmtPos(t: number) {
  const total = Math.max(0, Math.floor(t || 0));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

export default function Profile({ wide }: { wide: boolean }) {
  const { theme, setTheme, history, favs, clearHistory, clearLocal, push, toast, pos } = useStore();
  const [tab, setTab] = useState<"fav" | "history">("fav");
  const [cards, setCards] = useState<Detail[]>([]);
  const [about, setAbout] = useState(false);
  const [clearOpen, setClearOpen] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [loading, setLoading] = useState(false);

  const ids = tab === "fav" ? favs : history;

  useEffect(() => {
    let alive = true;
    if (!ids.length) { setCards([]); setLoading(false); return; }
    setLoading(true);
    Promise.allSettled(ids.slice(0, 12).map((id) => api.video(id)))
      .then((rs) => {
        if (!alive) return;
        setCards(rs.filter((r) => r.status === "fulfilled").map((r) => (r as PromiseFulfilledResult<Detail>).value));
      })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [ids.join(",")]);

  return (
    <div className="absolute inset-0 bg-bg flex flex-col">
      <div className="shrink-0 px-4 pb-2" style={{ paddingTop: "calc(var(--sat, 0px) + 14px)" }}>
        <div className="text-[24px] font-bold text-on leading-none">我的</div>
      </div>

      <div className="flex-1 scroll-y px-4 pt-2 pb-24">
        {/* 本地资料卡 */}
        <div className="rounded-(--r-lg) bg-s1 p-4 elev-1 flex items-center gap-3.5 a-rise">
          <Avatar size={56} icon={<IUser size={24} />} hue={280} />
          <div className="flex-1 min-w-0">
            <div className="text-[16px] font-bold text-on">本机</div>
            <div className="text-[11px] text-mut mt-0.5">收藏和进度只存在这台设备上</div>
            <div className="flex items-center gap-2 mt-2 text-[10.5px] text-mut">
              <span>收藏 <b className="text-on tabular-nums">{favs.length}</b></span>
              <span className="text-dim">·</span>
              <span>观看 <b className="text-on tabular-nums">{history.length}</b></span>
            </div>
          </div>
          <span className="shrink-0 h-6 px-2 inline-flex items-center rounded-full bg-s3 text-[10px] text-mut">无需登录</span>
        </div>

        {/* 我的内容 */}
        <div className="flex bg-s3 rounded-(--r-ctl) p-1 mt-4">
          {([["fav", "收藏"], ["history", "观看记录"]] as const).map(([k, l]) => (
            <button key={k} onClick={() => setTab(k)}
              className={`flex-1 h-8 rounded-(--r-ctl) text-[12px] font-semibold pressable ${tab === k ? "tonal text-on-sec" : "text-mut"}`}
              style={tab === k ? { background: "var(--p-sec)", color: "var(--p-primary)" } : undefined}>{l}</button>
          ))}
        </div>

        <div className="mt-3">
          {loading ? (
            <div className="flex justify-center py-8"><div className="w-7 h-7 spinner" /></div>
          ) : cards.length ? (
            <div className={`grid gap-2 ${wide ? "grid-cols-4 xl:grid-cols-5" : "grid-cols-3"}`}>
              {cards.map((c) => {
                const p = tab === "history" ? pos[String(c.id)] : undefined;
                const at = p && (p.done || p.t >= 10 || p.ep > 1) ? p : undefined;
                return (
                  <button key={c.id} onClick={() => push({ kind: "feed", videoIds: cards.map((x) => x.id), index: cards.findIndex((x) => x.id === c.id), title: tab === "fav" ? "我的收藏" : "观看历史" })}
                    className="relative rounded-(--r-sm) overflow-hidden bg-s1 elev-1 pressable" style={{ paddingTop: "133%" }}>
                    <Img src={c.cover} />
                    {at && (
                      <span className="absolute top-1.5 right-1.5 max-w-[calc(100%-12px)] px-1.5 py-0.5 rounded-md bg-black/55 backdrop-blur-sm text-[9px] font-semibold text-white/90 tabular-nums whitespace-nowrap truncate">
                        {at.done ? `第 ${at.ep} 集 · 已看完` : `第 ${at.ep} 集 · ${fmtPos(at.t)}`}
                      </span>
                    )}
                    <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/85 to-transparent p-1.5">
                      <div className="text-[10.5px] text-white clamp-2 leading-tight">{c.title}</div>
                    </div>
                  </button>
                );
              })}
            </div>
          ) : tab === "fav" ? (
            <Empty icon={<IStar size={24} />} title="还没有收藏" sub="在播放页点收藏"
              action="去逛逛" onAction={() => push({ kind: "ranks" })} />
          ) : (
            <Empty icon={<IClock size={24} />} title="还没有观看记录" />
          )}
          {cards.length > 0 && tab === "history" && (
            <div className="mt-3 text-center text-[10.5px] text-dim">
              {ids.length > 12 ? `共 ${ids.length} 条 · 只显示最近 12 条` : `共 ${ids.length} 条`}
            </div>
          )}
          {cards.length > 0 && tab === "history" && (
            <button onClick={clearHistory} className="mt-2 w-full h-9 rounded-(--r-ctl) bg-s3 text-[12px] text-mut pressable">清空观看记录</button>
          )}
        </div>

        {/* 设置 */}
        <div className="mt-5 rounded-(--r-md) bg-s2 divide-y divide-white/5">
          <div className="flex items-center gap-3 px-3.5 py-3">
            <span className="w-8 h-8 rounded-full bg-s3 flex items-center justify-center text-primary">{theme === "dark" ? <IMoon size={16} /> : <ISun size={16} />}</span>
            <div className="flex-1">
              <div className="text-[12.5px] text-on">深色外观</div>
              <div className="text-[10.5px] text-mut">跟随设计稿的 Fluent 深色</div>
            </div>
            <Toggle on={theme === "dark"} onChange={(on) => setTheme(on ? "dark" : "light")} label="深色外观" />
          </div>
        </div>

        {/* 关于 / 缓存 */}
        <div className="mt-3 rounded-(--r-md) bg-s2 divide-y divide-white/5">
          <button onClick={() => setAbout(true)} className="w-full flex items-center gap-3 px-3.5 py-3 text-left pressable">
            <span className="w-8 h-8 rounded-full bg-s3 flex items-center justify-center text-primary"><IInfo size={16} /></span>
            <div className="flex-1">
              <div className="text-[12.5px] text-on">关于 HGhub</div>
              <div className="text-[10.5px] text-mut">版本 1.0.0 · 开源项目</div>
            </div>
            <IChevR size={15} className="text-mut" />
          </button>
          <button onClick={() => setClearOpen(true)} className="w-full flex items-center gap-3 px-3.5 py-3 text-left pressable">
            <span className="w-8 h-8 rounded-full bg-s3 flex items-center justify-center text-primary"><IBroom size={16} /></span>
            <div className="flex-1">
              <div className="text-[12.5px] text-on">清理缓存</div>
              <div className="text-[10.5px] text-mut">封面 / 播放缓存与本地记录</div>
            </div>
            <IChevR size={15} className="text-mut" />
          </button>
        </div>

        <div className="text-center text-[10px] text-dim mt-5">HGhub 1.0.0 · {platform === "android" ? "Android" : "Windows"} 客户端</div>

        <Modal open={about} onClose={() => setAbout(false)} width={392}>
          <div className="p-5">
            <div className="flex items-center gap-3">
              <span className="w-11 h-11 rounded-(--r-sm) brand-grad glow-neon flex items-center justify-center text-on-primary text-[17px] font-black">H</span>
              <div>
                <div className="text-[16px] font-bold text-on leading-tight">HGhub</div>
                <div className="text-[11px] text-mut mt-0.5">黄果短剧 · 第三方客户端 v1.0.0</div>
              </div>
            </div>

            <p className="text-[12px] text-on/70 leading-relaxed mt-4">
              基于 Rust + Tauri 2 构建的跨平台客户端，支持 Windows 与 Android。
              界面遵循 Fluent 设计语言，播放器采用沉浸式竖屏信息流。
            </p>

            <div className="mt-4 rounded-(--r-sm) bg-s3/60 p-3 text-[11px] text-mut leading-relaxed">
              本项目仅供学习与交流，所有内容均来自上游站点，客户端不存储、不分发任何视频内容。
              请于 24 小时内删除相关资源，并支持正版。
            </div>

            <div className="mt-4 divide-y divide-white/5">
              <button onClick={() => { navigator.clipboard?.writeText("https://github.com/Minireel/HGhub").then(() => toast("仓库地址已复制", "ok")).catch(() => {}); }}
                className="w-full flex items-center gap-2 py-2.5 text-left pressable">
                <ILink size={15} className="text-mut" />
                <span className="text-[12px] text-on/85">github.com/Minireel/HGhub</span>
                <span className="ml-auto text-[10.5px] text-primary">复制</span>
              </button>
              <button onClick={() => { navigator.clipboard?.writeText("https://huangguoai.com").then(() => toast("站点地址已复制", "ok")).catch(() => {}); }}
                className="w-full flex items-center gap-2 py-2.5 text-left pressable">
                <ILink size={15} className="text-mut" />
                <span className="text-[12px] text-on/85">huangguoai.com</span>
                <span className="ml-auto text-[10.5px] text-primary">复制</span>
              </button>
            </div>

            <button onClick={() => setAbout(false)} className="mt-4 w-full h-9 rounded-(--r-ctl) bg-s3 text-[12.5px] text-on pressable">知道了</button>
          </div>
        </Modal>

        <Modal open={clearOpen} onClose={() => setClearOpen(false)} width={330}>
          <div className="p-5">
            <div className="text-[14.5px] font-bold text-on">清理缓存</div>
            <p className="text-[12px] text-mut leading-relaxed mt-2">
              将清除封面与播放列表缓存、收藏与观看记录、播放断点和搜索历史。此操作不可撤销。
            </p>
            <div className="flex gap-2 mt-5">
              <button onClick={() => setClearOpen(false)} className="flex-1 h-9 rounded-(--r-ctl) bg-s3 text-[12.5px] text-on/80 pressable">取消</button>
              <button disabled={clearing} onClick={async () => {
                setClearing(true);
                try { await api.clearCache(); } catch { /* 忽略 */ }
                clearLocal();
                setClearing(false);
                setClearOpen(false);
                toast("缓存已清理", "ok");
              }} className="flex-1 h-9 rounded-(--r-ctl) bg-primary text-[12.5px] font-semibold text-on-primary pressable disabled:opacity-60">
                {clearing ? "清理中…" : "确定清理"}
              </button>
            </div>
          </div>
        </Modal>
      </div>
    </div>
  );
}
