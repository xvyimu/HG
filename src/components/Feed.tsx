import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, cover, fmt, fmtTime, mediaUrl, pickPlayUrl, playFieldReport, playlist, playUrlExpiry, platform } from "../api";
import type { Detail, Episode, Post, VideoCard } from "../types";
import { useStore } from "../store";
import { Avatar, Img, Sheet } from "./ui";
import VideoSurface, { type VideoHandle } from "./VideoSurface";
import PlayerControls from "./PlayerControls";
import { ArticlePanel, CommentsPanel, EpisodesPanel } from "./Panels";
import { sanitizeHtml } from "../html";
import { setBackHandler } from "../back";
import {
  IBack, IBoltF, IChevronDown, IChevronUp, IClose, ICommentF, ICompress, IExpand, IFileText, IHeart, IHeartF,
  ILink, IList, ILockF, IPauseF, IPlayF, IPlus, IStar, IStarF, IVol, IVolMute,
} from "../icons";

type Props = {
  videoIds: number[];
  startIndex?: number;
  title?: string;
  mode: "home" | "context";
  kind?: "video" | "post";
  active: boolean;
  bottomInset: number;
  onBack?: () => void;
  onNearEnd?: () => void;
};

const RATES = [1, 1.25, 1.5, 2];

const stripHtml = (s: string) => s.replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();

export default function Feed({ videoIds, startIndex = 0, title = "", mode, kind = "video", active, bottomInset, onBack, onNearEnd }: Props) {
  const store = useStore();
  const { isLiked, isFav, toggleLikeLocal, toggleFavLocal, toggleFollowLocal, muted, setMuted, volume, setVolume, toast, addHistory, user } = store;
  const isDesktop = platform === "windows";

  const boxRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<VideoHandle>(null);
  const [index, setIndex] = useState(startIndex);
  const [epMap, setEpMap] = useState<Record<number, number>>({});
  const [details, setDetails] = useState<Record<number, Detail>>({});
  const [playUrls, setPlayUrls] = useState<Record<string, string>>({});
  const [cards, setCards] = useState<Record<number, VideoCard>>({});
  const [posts, setPosts] = useState<Record<number, Post>>({});

  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [vsize, setVsize] = useState({ w: 0, h: 0 });
  const [buffered, setBuffered] = useState(0);
  const [paused, setPaused] = useState(false);
  const pausedRef = useRef(false);
  pausedRef.current = paused;
  /** 倍速持久化在 store 里 */
  const rate = store.rate;
  const setRate = store.setRate;
  const [waiting, setWaiting] = useState(false);
  const [err, setErr] = useState("");
  const [panel, setPanel] = useState<"episodes" | "comments" | "article" | null>(null);
  const [descOpen, setDescOpen] = useState(false);
  const theater = store.theater;
  const setTheater = store.setTheater;
  const fs = store.fs;
  const setFs = store.setFs;

  /* 桌面：鼠标闲置 2.8s 自动隐藏播放器 UI（沉浸） */
  const [idle, setIdle] = useState(false);
  const idleTimer = useRef<number | undefined>(undefined);
  const wake = useCallback(() => {
    setIdle(false);
    window.clearTimeout(idleTimer.current);
    idleTimer.current = window.setTimeout(() => setIdle(true), 2800);
  }, []);
  useEffect(() => {
    if (!isDesktop) return undefined;
    wake();
    return () => window.clearTimeout(idleTimer.current);
  }, [isDesktop, wake]);
  useEffect(() => {
    if (paused) { setIdle(false); window.clearTimeout(idleTimer.current); }
  }, [paused]);
  const [fullscreen, setFullscreen] = useState(false);
  const [heartBurst, setHeartBurst] = useState(0);
  /* —— 移动端手势 —— */
  const [holdSpeed, setHoldSpeed] = useState(false);
  const [speedLock, setSpeedLock] = useState(false);
  const [lockArmed, setLockArmed] = useState(false);
  const holdRef = useRef(false);
  const lockArmedRef = useRef(false);
  const [scrub, setScrub] = useState<{ pct: number; target: number } | null>(null);
  const scrubTarget = useRef<number | null>(null);
  /* 进度条拖动 */
  const barRef = useRef<HTMLDivElement>(null);
  const barScrub = useRef(false);
  const [barPct, setBarPct] = useState<number | null>(null);
  const gesture = useRef<{
    x: number; y: number; startY: number; t: number; timer: number | null;
    mode: "idle" | "hold" | "scrub"; base: number; width: number; wasPaused: boolean;
  } | null>(null);

  const curId = videoIds[index];
  const detail = details[curId];
  const episodes = detail?.episodes || [];
  const savedEp = curId ? store.pos[String(curId)] : undefined;
  /** 从「我的·观看记录」或首页进来时，直接回到上次看到的那一集（看过 10s 以上或非第一集，且该集仍在列表里） */
  const savedEpOk = savedEp && (savedEp.t >= 10 || savedEp.ep > 1) && (!episodes.length || episodes.some((e) => e.ep_num === savedEp.ep));
  const curEp = epMap[curId] || (savedEpOk ? savedEp.ep : 0) || 1;
  const playKey = `${curId}:${curEp}`;
  /** 播放地址缓存：带 auth_key 时效，过期前 5 分钟自动重取 */
  const playCache = useRef<Record<string, { url: string; exp: number }>>({});
  /** 同步读缓存：切到已预取/已看过的集时首帧就有地址，VideoSurface 不会被卸载重建 */
  const playUrl = playUrls[playKey] || playCache.current[playKey]?.url || "";
  const post = posts[curId];

  /** 统一视图模型：短剧与吃瓜帖子共用同一套播放界面 */
  const meta = kind === "post"
    ? {
        title: post?.title || "",
        cover: post?.cover || "",
        desc: post?.content || post?.desc || "",
        author: "黄果吃瓜",
        authorId: -1,
        tags: post?.tags || [],
        score: 0,
        like: 0,
        comment: 0,
        collect: 0,
        episodes: [] as Episode[],
      }
    : {
        title: detail?.title || cards[curId]?.title || "",
        cover: detail?.cover || cards[curId]?.cover || "",
        desc: detail?.description || "",
        author: detail?.author?.name || "黄果短剧",
        authorId: detail?.author?.id || -1,
        tags: detail?.tags || [],
        score: detail?.score || 0,
        like: detail?.counts?.like ?? cards[curId]?.like_count ?? 0,
        comment: detail?.counts?.comment ?? cards[curId]?.comment_count ?? 0,
        collect: detail?.counts?.collect ?? cards[curId]?.collect_count ?? 0,
        episodes: detail?.episodes || [],
      };

  const posterUrl = cover(meta.cover, 900);
  const hasVideo = kind === "video" || !!post?.video_url;
  const articleHtml = kind === "post" && !hasVideo ? sanitizeHtml(post?.content || "") : "";

  /* 倍速：长按 / 锁定 → 2.0x，否则用基准倍速 */
  const effRate = holdSpeed || speedLock ? 2 : rate;
  /* 进度条显示百分比（拖动时用拖动值） */
  const barProgress = barPct ?? (duration ? time / duration : 0);
  /* 沉浸全屏 + 横屏视频 → 舞台旋转 90°，看起来就是横屏 */
  const rotated = !isDesktop && fs && vsize.w > vsize.h && vsize.h > 0;

  /* 滚动定位 */
  const onScroll = useCallback(() => {
    const el = boxRef.current;
    if (!el) return;
    const h = el.clientHeight || 1;
    const i = Math.max(0, Math.min(videoIds.length - 1, Math.round(el.scrollTop / h)));
    setIndex((prev) => (prev === i ? prev : i));
    if (onNearEnd && i >= videoIds.length - 3) onNearEnd();
  }, [videoIds.length, onNearEnd]);

  const go = useCallback((delta: number) => {
    const el = boxRef.current;
    if (!el) return;
    const next = Math.max(0, Math.min(videoIds.length - 1, index + delta));
    el.scrollTo({ top: next * el.clientHeight, behavior: "smooth" });
  }, [index, videoIds.length]);

  /* 初始定位 */
  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const raf = requestAnimationFrame(() => {
      el.scrollTop = startIndex * (el.clientHeight || 1);
    });
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* 拉详情（当前 + 邻接预取） */
  useEffect(() => {
    let alive = true;
    const need = [videoIds[index], videoIds[index + 1], videoIds[index - 1]].filter(Boolean);
    need.forEach((id) => {
      if (details[id]) return;
      api.video(id).then((d) => { if (alive) setDetails((m) => ({ ...m, [id]: d })); }).catch(() => {});
    });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index, videoIds]);

  /* 吃瓜帖子：直接拿帖子详情（含 video_url） */
  useEffect(() => {
    if (kind !== "post") return;
    let alive = true;
    [videoIds[index], videoIds[index + 1], videoIds[index - 1]].filter(Boolean).forEach((id) => {
      if (posts[id]) return;
      api.post(id).then((p) => { if (alive) setPosts((m) => ({ ...m, [id]: p })); }).catch(() => {});
    });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, index, videoIds]);

  const fetchPlay = useCallback(async (id: number, ep: number, force = false): Promise<string> => {
    const key = `${id}:${ep}`;
    const hit = playCache.current[key];
    if (!force && hit && hit.exp - Date.now() / 1000 > 300) return hit.url;

    /* 只对「空地址」重试一次（CDN 抖动）；连接/业务错误直接抛，不叠加延迟 */
    for (let attempt = 0; attempt < 2; attempt++) {
      let info: unknown;
      try {
        info = await api.play(id, ep);
      } catch (e) {
        void api.debugLog(`play-fail id=${id} ep=${ep} :: ${(e as Error).message}`);
        throw e;
      }
      const url = pickPlayUrl(info);
      if (url) {
        playCache.current[key] = { url, exp: playUrlExpiry(url) };
        return url;
      }
      const keys = info && typeof info === "object" ? Object.keys(info as object).slice(0, 10).join("/") : typeof info;
      void api.debugLog(`play-empty id=${id} ep=${ep} attempt=${attempt} :: ${playFieldReport(info)}`);
      if (attempt === 0) { await new Promise((r) => setTimeout(r, 400)); continue; }
      throw new Error(`站点未返回播放地址（${keys || "空响应"}）`);
    }
    throw new Error("取播放地址失败");
  }, []);

  /* 拉播放地址 */
  const t0Ref = useRef<Record<string, number>>({});
  useEffect(() => {
    if (!curId) return undefined;
    const key = playKey;
    const hit = playCache.current[key];
    if (hit && hit.exp - Date.now() / 1000 > 300) {
      t0Ref.current[key] = performance.now();
      setPlayUrls((m) => (m[key] === hit.url ? m : { ...m, [key]: hit.url }));
      addHistory(curId);
      return undefined;
    }
    /* 吃瓜帖子：详情里就是成品地址，不走 /play（那是剧集接口） */
    if (kind === "post") {
      const direct = post?.video_url ? mediaUrl(post.video_url) : "";
      if (direct) {
        t0Ref.current[key] = performance.now();
        setPlayUrls((m) => ({ ...m, [key]: direct }));
        addHistory(curId);
        return undefined;
      }
    }
    let alive = true;
    const fallback = curEp === 1 ? (detail?.video_url || detail?.video_url_hevc || "") : "";
    fetchPlay(curId, curEp)
      .then((url) => {
        if (!alive) return;
        t0Ref.current[key] = performance.now();
        setPlayUrls((m) => ({ ...m, [key]: url }));
        setErr("");
        addHistory(curId);
      })
      .catch((e) => {
        if (!alive) return;
        delete t0Ref.current[key];
        /* 兜底：详情里 SSR 预置的第 1 集地址 */
        if (fallback) {
          t0Ref.current[key] = performance.now();
          setPlayUrls((m) => ({ ...m, [key]: fallback }));
          setErr("");
          addHistory(curId);
          return;
        }
        setErr((e as Error).message || "取播放地址失败");
      });
    return () => { alive = false; };
  }, [curId, curEp, playKey, kind, post?.video_url, fetchPlay, addHistory, detail?.video_url, detail?.video_url_hevc]);

  /* 预取下一集地址（只调接口，不预载视频）；顺带把下一集的 m3u8 拉进 Rust 缓存，
     切集时清单和 DNS/TLS 都是热的，起播快一截 */
  useEffect(() => {
    if (!playUrl || !curId) return undefined;
    const nx = episodes.find((e) => e.ep_num === curEp + 1);
    if (!nx) return undefined;
    const timer = window.setTimeout(() => {
      void fetchPlay(curId, nx.ep_num)
        .then((u) => { if (u && /\.m3u8(\?|$)/i.test(u)) void fetch(playlist(u)).catch(() => {}); })
        .catch(() => {});
    }, 1500);
    return () => window.clearTimeout(timer);
  }, [playUrl, curId, curEp, episodes, fetchPlay]);

  /* 断点续播：同一部剧、同一集，上次看到 ≥10s 且未看完 → 自动接上 */
  const resumedRef = useRef("");
  const posRef = useRef(store.pos);
  posRef.current = store.pos;
  const onDuration = useCallback((d: number) => {
    setDuration(d);
    if (!curId) return;
    const saved = posRef.current[String(curId)];
    if (!saved || saved.ep !== curEp || resumedRef.current === playKey) return;
    if (saved.t < 10 || saved.t > d - 15) return;
    resumedRef.current = playKey;
    videoRef.current?.seek(saved.t);
    setTime(saved.t);
    toast(`已从上次 ${fmtTime(saved.t)} 继续`, "info");
  }, [curId, curEp, playKey, toast]);

  /* 进度落盘：时间每 5s 变一次，交给 store 去抖 */
  const savePosRef = useRef(store.savePos);
  savePosRef.current = store.savePos;
  /** 切集瞬间旧视频的 timeupdate 会晚一拍到达，400ms 内不落盘，避免把上一集的秒数写到新集 */
  const epAtRef = useRef(0);
  const saveProgress = useCallback((t: number) => {
    setTime(t);
    if (curId && duration > 20 && performance.now() - epAtRef.current > 400) savePosRef.current(curId, curEp, t);
  }, [curId, curEp, duration]);

  /* 切换条目/集数时重置播放状态 */
  useEffect(() => {
    setTime(0); setDuration(0); setBuffered(0); setErr(""); setWaiting(true); setPaused(false); setDescOpen(false);
    setVsize({ w: 0, h: 0 });
    epAtRef.current = performance.now();
  }, [playKey]);

  /* 音量/静音同步 */
  useEffect(() => { videoRef.current?.mute(muted); }, [muted]);
  useEffect(() => { videoRef.current?.volume(volume); }, [volume]);
  /* 倍速同步（长按 2x / 锁定 2x / 基准倍速） */
  useEffect(() => { videoRef.current?.rate(effRate); }, [effRate, playKey]);

  /* 非激活时暂停 */
  useEffect(() => { if (!active) videoRef.current?.pause(); }, [active]);

  /* 键盘 */
  useEffect(() => {
    if (!active) return;
    const fn = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA")) return;
      if (panel) { if (e.key === "Escape") setPanel(null); return; }
      switch (e.key) {
        case "ArrowDown": e.preventDefault(); go(1); break;
        case "ArrowUp": e.preventDefault(); go(-1); break;
        case " ": e.preventDefault(); videoRef.current?.toggle(); break;
        case "ArrowLeft": e.preventDefault(); videoRef.current?.seek(Math.max(0, time - 5)); break;
        case "ArrowRight": e.preventDefault(); videoRef.current?.seek(time + 5); break;
        case "f": case "F": toggleFull(); break;
        case "t": case "T": setTheater((v) => !v); break;
        case "m": case "M": setMuted((v) => !v); break;
        case "l": case "L": onLike(); break;
        case "s": case "S": onFav(); break;
        case "c": case "C": setPanel("comments"); break;
        case "e": case "E": setPanel("episodes"); break;
        default: break;
      }
    };
    window.addEventListener("keydown", fn);
    return () => window.removeEventListener("keydown", fn);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, panel, time, index]);

  /* 安卓返回键：面板打开时先关面板 */
  useEffect(() => {
    if (!panel) { setBackHandler(null); return undefined; }
    setBackHandler(() => { setPanel(null); return true; });
    return () => setBackHandler(null);
  }, [panel]);

  useEffect(() => {
    const onFs = () => setFullscreen(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", onFs);
    return () => document.removeEventListener("fullscreenchange", onFs);
  }, []);

  const toggleFull = () => {
    const el = boxRef.current?.parentElement;
    if (!el) return;
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else el.requestFullscreen().catch(() => {});
  };

  /* —— 长按 2x（上滑锁定） / 横拖定位 / 单击暂停 —— */
  const onDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (isDesktop) return;
    const el = e.currentTarget;
    const width = el.clientWidth || 1;
    try { el.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    const g = {
      x: e.clientX, y: e.clientY, startY: e.clientY, t: Date.now(), base: time, width,
      mode: "idle" as "idle" | "hold" | "scrub",
      wasPaused: pausedRef.current,
      timer: window.setTimeout(() => {
        const cur = gesture.current;
        if (!cur || cur.mode !== "idle") return;
        cur.mode = "hold";
        holdRef.current = true;
        setHoldSpeed(true);
        setLockArmed(false);
        lockArmedRef.current = false;
        try { navigator.vibrate?.(25); } catch { /* ignore */ }
      }, 380) as unknown as number,
    };
    gesture.current = g;
  };

  const onMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const g = gesture.current;
    if (!g || isDesktop) return;
    const dx = e.clientX - g.x;
    const dy = e.clientY - g.y;

    /* 长按中：上滑 64px 进入「松开即锁定」 */
    if (g.mode === "hold") {
      const armed = g.startY - e.clientY > 64;
      if (armed !== lockArmedRef.current) {
        lockArmedRef.current = armed;
        setLockArmed(armed);
      }
      return;
    }

    if (g.mode === "idle") {
      if (Math.abs(dx) > 14 && Math.abs(dx) > Math.abs(dy)) {
        if (g.timer) window.clearTimeout(g.timer);
        g.mode = "scrub";
        videoRef.current?.pause();
      } else if (Math.abs(dy) > 14) {
        if (g.timer) window.clearTimeout(g.timer);
      }
      return;
    }

    if (g.mode === "scrub") {
      const total = duration || 0;
      if (!total) return;
      const target = Math.max(0, Math.min(total, g.base + (dx / g.width) * total));
      scrubTarget.current = target;
      setScrub({ pct: (target / total) * 100, target });
    }
  };

  const onUp = () => {
    const g = gesture.current;
    gesture.current = null;
    if (!g) return;
    if (g.timer) window.clearTimeout(g.timer);

    if (g.mode === "hold") {
      holdRef.current = false;
      setHoldSpeed(false);
      if (lockArmedRef.current) {
        setSpeedLock(true);
        toast("已锁定 2.0x 倍速 · 点顶部标签解除", "info");
      }
      lockArmedRef.current = false;
      setLockArmed(false);
      return;
    }
    if (g.mode === "scrub") {
      const target = scrubTarget.current;
      if (target != null) videoRef.current?.seek(target);
      setScrub(null);
      scrubTarget.current = null;
      /* 拖动前在播就继续播（用按下时的状态，避免被 scrub 期间的 pause 带偏） */
      if (!g.wasPaused) videoRef.current?.play();
      return;
    }
    if (Date.now() - g.t < 260) videoRef.current?.toggle();
  };

  /* 长按倍速期间禁止原生滚动，否则上滑会被列表吃掉、锁不住倍速 */
  useEffect(() => {
    if (isDesktop) return undefined;
    const el = boxRef.current;
    if (!el) return undefined;
    const fn = (e: TouchEvent) => { if (holdRef.current) e.preventDefault(); };
    el.addEventListener("touchmove", fn, { passive: false });
    return () => el.removeEventListener("touchmove", fn);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isDesktop, videoIds.length]);

  /* —— 进度条拖动（旋转舞台下按 Y 轴换算） —— */
  const barPctAt = (clientX: number, clientY: number) => {
    const r = barRef.current?.getBoundingClientRect();
    if (!r) return null;
    const span = rotated ? r.height : r.width;
    if (!span) return null;
    const raw = rotated ? (clientY - r.top) / span : (clientX - r.left) / span;
    return Math.max(0, Math.min(1, raw));
  };
  const barSeekTo = (clientX: number, clientY: number) => {
    const pct = barPctAt(clientX, clientY);
    if (pct == null) return null;
    setBarPct(pct);
    return pct;
  };
  const onBarDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.stopPropagation();
    barScrub.current = true;
    try { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); } catch { /* ignore */ }
    barSeekTo(e.clientX, e.clientY);
  };
  const onBarMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!barScrub.current) return;
    e.stopPropagation();
    barSeekTo(e.clientX, e.clientY);
  };
  const onBarUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!barScrub.current) return;
    barScrub.current = false;
    e.stopPropagation();
    const pct = barPctAt(e.clientX, e.clientY);
    if (pct != null && duration) {
      const target = pct * duration;
      videoRef.current?.seek(target);
      setTime(target);
    }
    setBarPct(null);
  };

  const togglePip = async () => {
    try {
      const v = videoRef.current?.el();
      if (document.pictureInPictureElement) await document.exitPictureInPicture();
      else if (v && document.pictureInPictureEnabled) await v.requestPictureInPicture();
      else toast("当前环境不支持画中画", "info");
    } catch { toast("画中画开启失败", "info"); }
  };

  /* 喜欢 / 收藏 / 关注 都是本地状态，登录了才顺手同步到服务器；不再弹登录框 */
  const onLike = () => {
    if (!curId) return;
    const on = toggleLikeLocal(curId);
    setHeartBurst((n) => n + 1);
    toast(on ? "已加入喜欢" : "已取消喜欢", on ? "heart" : "info");
    if (user) { if (kind === "post") api.postLike(curId, on).catch(() => {}); else api.like(curId, curEp, on).catch(() => {}); }
  };

  const onFav = () => {
    if (!curId) return;
    const on = toggleFavLocal(curId);
    toast(on ? "已收藏" : "已取消收藏", on ? "star" : "info");
    if (user) { if (kind === "post") api.postCollect(curId, on).catch(() => {}); else api.collect(curId, on).catch(() => {}); }
  };

  const onFollow = () => {
    const uid = meta.authorId > 0 ? meta.authorId : undefined;
    if (!uid) return;
    const on = toggleFollowLocal(uid);
    toast(on ? `已关注 ${detail?.author?.name}` : "已取消关注", on ? "ok" : "info");
    if (user) api.follow(uid, on).catch(() => {});
  };

  const pickEp = (ep: number) => {
    setEpMap((m) => ({ ...m, [curId]: ep }));
    /* 选集/自动连播都记下「看到第几集」，短时间看新集也不会丢 */
    if (curId) store.saveEp(curId, ep);
    setPanel(null);
  };

  /** 错误自愈：地址失效（auth_key 过期 / 分片全挂）时，换一条新地址重试一次 */
  const healRef = useRef<Record<string, number>>({});
  const [reload, setReload] = useState(0);
  const keyRef = useRef(playKey);
  keyRef.current = playKey;

  const onPlayError = useCallback((m: string, fatal?: boolean) => {
    if (!curId) { setErr(m); return; }
    if (!fatal || (healRef.current[playKey] || 0) >= 1) { setErr(m); return; }
    healRef.current[playKey] = 1;
    const myKey = playKey;
    void api.debugLog(`play-heal ${myKey} :: ${m}`);
    delete playCache.current[myKey];
    fetchPlay(curId, curEp, true)
      .then((url) => {
        if (keyRef.current !== myKey) return;
        setErr("");
        setPlayUrls((mm) => ({ ...mm, [myKey]: url }));
        setReload((n) => n + 1);
      })
      .catch((e) => {
        if (keyRef.current !== myKey) return;
        setErr((e as Error).message || m);
        setReload((n) => n + 1);
      });
  }, [curId, curEp, playKey, fetchPlay]);

  /** 「重试」按钮：强制重取地址，而不是继续用缓存里的死链 */
  const retryPlay = () => {
    if (!curId) return;
    const myKey = playKey;
    delete playCache.current[myKey];
    healRef.current[myKey] = 0;
    setErr("");
    fetchPlay(curId, curEp, true)
      .then((url) => {
        if (keyRef.current !== myKey) return;
        setPlayUrls((m) => ({ ...m, [myKey]: url }));
        /* 地址可能没变（服务端还没恢复），靠 reload 强制播放器重建 */
        setReload((n) => n + 1);
      })
      .catch((e) => {
        if (keyRef.current !== myKey) return;
        setErr((e as Error).message || "取播放地址失败");
      });
  };

  const likeCount = useMemo(() => {
    const base = meta.like;
    return base + (isLiked(curId) ? 1 : 0);
  }, [meta.like, curId, isLiked]);

  if (!videoIds.length) {
    return <div className="absolute inset-0 bg-black flex items-center justify-center"><div className="w-9 h-9 spinner" /></div>;
  }

  return (
    <div
      className={`absolute inset-0 overflow-hidden bg-black player-root ${isDesktop ? "player-surface" : ""} ${theater ? "is-theater" : ""} ${rotated ? "fs-landscape" : ""} ${isDesktop && idle ? "is-idle" : ""}`}
      onPointerMove={() => { if (isDesktop) wake(); }}>
      {/* 氛围背景 */}
      <div className="absolute inset-0 scale-110 blur-3xl opacity-25 pointer-events-none">
        {posterUrl && <img src={posterUrl} alt="" className="w-full h-full object-cover" />}
      </div>

      <div ref={boxRef} onScroll={onScroll}
        className="absolute inset-y-0 left-0 overflow-y-scroll no-bar snap-y snap-mandatory"
        style={{ right: isDesktop && panel ? 372 : 0, transition: "right .3s cubic-bezier(.2,0,0,1)" }}>
        {videoIds.map((vid, i) => {
          const isActive = i === index;
          return (
            <section key={vid} className="relative w-full h-full snap-start overflow-hidden">
              {isActive && playUrl ? (
                <div className="absolute inset-0" style={{ touchAction: "pan-y" }}
                  onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}>
                <VideoSurface ref={videoRef} src={playUrl} poster={posterUrl} autoPlay muted={muted}
                  reload={reload}
                  volume={volume} rate={effRate}
                  fit={isDesktop || (vsize.w > 0 && vsize.w > vsize.h) ? "contain" : "cover"}
                  onClick={() => { if (isDesktop) videoRef.current?.toggle(); }}
                  onTime={saveProgress}
                  onDuration={onDuration}
                  onSize={(w, h) => setVsize({ w, h })}
                  onPlaying={() => {
            setPaused(false); setWaiting(false);
            const t0 = t0Ref.current[playKey];
            if (t0) { delete t0Ref.current[playKey]; void api.debugLog(`play-first-frame ${playKey} ${Math.round(performance.now() - t0)}ms`); }
          }}
                  onPause={() => setPaused(true)}
                  onWaiting={() => setWaiting(true)}
                  onEnded={() => {
            if (curId) store.markDone(curId, curEp);
            const next = episodes.find((e) => e.ep_num === curEp + 1);
            if (next) pickEp(next.ep_num);
          }}
                  onError={onPlayError} />
                </div>
              ) : (
                <div className="absolute inset-0">
                  <Img src={detail?.cover || cards[vid]?.cover || posts[vid]?.cover || ""} eager={Math.abs(i - index) <= 1} />
                  <div className="absolute inset-0 bg-black/25" />
                </div>
              )}

              {/* 图文帖：没有视频就给个正文入口 */}
              {isActive && kind === "post" && !!post && !post.video_url && (
                <div className="absolute inset-0 z-10 flex items-center justify-center">
                  <button type="button" onClick={() => setPanel("article")}
                    className="flex items-center gap-2 h-11 px-5 rounded-full bg-white/92 text-[#0b0e15] text-[13.5px] font-semibold pressable elev-3">
                    <IFileText size={17} />查看图文详情
                  </button>
                </div>
              )}

              {/* 渐变压暗，保证文字可读 */}
              <div className="absolute inset-0 pointer-events-none"
                style={{ background: "linear-gradient(0deg, rgba(8,11,15,.86) 0, rgba(11,14,20,.18) 26%, transparent 48%)" }} />

              {/* 顶部 */}
              {!fs && mode === "context" ? (
                isDesktop ? (
                  <div className="desktop-context-header">
                    <button onClick={onBack} aria-label="返回"><IBack size={17} /></button>
                    <span>{title}</span>
                    <small>{index + 1} / {videoIds.length}</small>
                  </div>
                ) : (
                  <div className="absolute inset-x-0 z-20 flex items-center gap-2 px-2.5" style={{ top: "calc(var(--sat, 0px) + 8px)" }}>
                    <button onClick={onBack} className="w-9 h-9 rounded-full bg-black/45 flex items-center justify-center text-white pressable elev-1"><IBack size={20} /></button>
                    <span className="text-[14.5px] font-semibold text-white tsh truncate">{title}</span>
                    <span className="ml-auto px-2 py-0.5 rounded-full bg-black/45 text-[11px] font-semibold text-white/80">{index + 1} / {videoIds.length}</span>
                    <button onClick={() => setMuted((m) => !m)} className="w-9 h-9 rounded-full bg-black/45 flex items-center justify-center text-white pressable elev-1">
                      {muted ? <IVolMute size={17} /> : <IVol size={17} />}
                    </button>
                  </div>
                )
              ) : null}

              {/* 右侧操作栏 */}
              {!fs && (
              <div className={`absolute z-20 flex flex-col items-center ${isDesktop ? "desktop-social" : "right-3"}`}
                style={isDesktop ? undefined : { bottom: `calc(var(--sab, 0px) + ${bottomInset + 104}px)` }}>
                {isDesktop && (
                  <div className="desktop-browse-inline">
                    <button onClick={() => go(-1)} disabled={index === 0} aria-label="上一个" title="上一个 ↑">
                      <IChevronUp size={19} strokeWidth={1.8} />
                    </button>
                    <button onClick={() => go(1)} disabled={index >= videoIds.length - 1} aria-label="下一个" title="下一个 ↓">
                      <IChevronDown size={19} strokeWidth={1.8} />
                    </button>
                    <small>{String(index + 1).padStart(2, "0")} / {String(videoIds.length).padStart(2, "0")}</small>
                  </div>
                )}
                {!isDesktop && (
                  <button onClick={onFollow} className="flex flex-col items-center gap-1 pressable">
                    <span className="relative">
                      <Avatar size={44} name={meta.author} hue={220} />
                      <span className={`absolute -bottom-0.5 -right-0.5 w-[18px] h-[18px] rounded-full flex items-center justify-center text-[10px] ${store.follows.includes(meta.authorId) ? "bg-s4 text-mut" : "bg-primary text-on-primary"}`}>
                        {store.follows.includes(meta.authorId) ? "✓" : <IPlus size={10} />}
                      </span>
                    </span>
                    <span className="text-[10px] text-white/80 mt-1 max-w-[52px] truncate">{meta.author}</span>
                  </button>
                )}

                {kind === "video" && (
                  <>
                    <button onClick={onLike} className="flex flex-col items-center gap-1 pressable" aria-pressed={isLiked(curId)}>
                      <span key={heartBurst} className={heartBurst ? "a-pop" : ""}>
                        {isLiked(curId) ? <IHeartF size={30} className="text-neon" /> : <IHeart size={30} className="text-white tsh" />}
                      </span>
                      <span className="text-[10.5px] text-white/90 tabular-nums">{fmt(likeCount)}</span>
                    </button>

                    <button onClick={() => setPanel("comments")} className="flex flex-col items-center gap-1 pressable">
                      <ICommentF size={27} className="text-white tsh" />
                      <span className="text-[10.5px] text-white/90 tabular-nums">{fmt(meta.comment)}</span>
                    </button>

                    <button onClick={onFav} className="flex flex-col items-center gap-1 pressable" aria-pressed={isFav(curId)}>
                      {isFav(curId) ? <IStarF size={27} className="text-amber" /> : <IStar size={27} className="text-white tsh" />}
                      <span className="text-[10.5px] text-white/90 tabular-nums">{fmt(meta.collect)}</span>
                    </button>

                    <button onClick={() => setPanel("episodes")} className="flex flex-col items-center gap-1 pressable">
                      <IList size={26} className="text-white tsh" />
                      <span className="text-[10.5px] text-white/90">选集</span>
                    </button>
                  </>
                )}

                <button onClick={() => {
                  const u = kind === "post" ? (posts[curId]?.video_url || meta.title) : `https://huangguoai.com/video/${curId}/`;
                  navigator.clipboard?.writeText(u).then(() => toast("链接已复制", "ok")).catch(() => {});
                }} className="flex flex-col items-center gap-1 pressable">
                  <ILink size={25} className="text-white tsh" />
                  <span className="text-[10.5px] text-white/90">分享</span>
                </button>
              </div>
              )}

              {/* 左下信息：整体下移紧贴进度条，去掉标签/评分行避免挤占画面 */}
              {!fs && (
              <div className={isDesktop ? "desktop-video-meta" : "absolute left-3.5 right-[76px] z-20"}
                style={isDesktop ? undefined : { bottom: `calc(var(--sab, 0px) + ${bottomInset + 28}px)` }}>
                <div className="flex items-center gap-2">
                  <span className="text-[15px] font-bold text-white tsh truncate">@{meta.author}</span>
                  {episodes.length > 0 && (
                    <span className="shrink-0 px-1.5 py-px rounded-md bg-white/15 text-[10px] font-bold text-white">
                      第 {curEp}/{episodes.length} 集
                    </span>
                  )}
                  {!!meta.score && (
                    <span className="shrink-0 text-[11px] font-bold text-amber tsh">{meta.score.toFixed(1)} 分</span>
                  )}
                </div>

                <p className="mt-1 text-[13.5px] leading-snug text-white/95 tsh clamp-2">{meta.title}</p>

                {/* 描述（单行，点开展开） */}
                <button onClick={() => setDescOpen((v) => !v)} className="mt-1 text-left w-full pressable group">
                  <p className={`text-[11.5px] leading-relaxed text-white/62 ${descOpen ? "" : "clamp-1"}`}>
                    {meta.desc || "暂无简介"}
                  </p>
                  <span className="text-[10.5px] text-primary/90 font-semibold">{descOpen ? "收起" : "展开简介"}</span>
                </button>
              </div>
              )}


              {/* 横拖定位浮层 */}
              {!isDesktop && scrub && (
                <div className="absolute inset-0 z-30 flex flex-col items-center justify-center pointer-events-none bg-black/25">
                  <span className="text-[26px] font-bold text-white tabular-nums tsh">{fmtTime(scrub.target)}</span>
                  <span className="text-[11px] text-white/60 mt-1 tabular-nums">/ {fmtTime(duration)}</span>
                  <div className="mt-4 w-[62%] h-[3px] rounded-full bg-white/25 overflow-hidden">
                    <div className="h-full bg-white" style={{ width: `${scrub.pct}%` }} />
                  </div>
                </div>
              )}

              {/* 暂停 / 缓冲 */}
              {isActive && paused && !err && (
                <div className="absolute inset-0 z-10 flex items-center justify-center pointer-events-none">
                  <span className="w-[66px] h-[66px] rounded-full bg-black/40 backdrop-blur-md flex items-center justify-center">
                    <IPlayF size={28} className="text-white/90 ml-0.5" />
                  </span>
                </div>
              )}
              {isActive && waiting && !err && !paused && (
                <div className="absolute inset-0 z-10 flex items-center justify-center pointer-events-none"><div className="w-9 h-9 spinner" /></div>
              )}
              {isActive && err && (
                <div className="absolute inset-0 z-20 flex items-center justify-center">
                  <div className="bg-black/70 rounded-xl p-5 flex flex-col items-center gap-3 text-[13px] text-white/90">
                    <span>视频暂时无法加载</span>
                    <span className="text-[10.5px] text-white/45 max-w-[240px] text-center break-all">{err}</span>
                    <button className="text-primary text-[12.5px]" onClick={retryPlay}>重试</button>
                  </div>
                </div>
              )}
            </section>
          );
        })}
      </div>

      {/* 桌面控制条 */}
      {isDesktop && (
        <PlayerControls
          paused={paused} time={time} duration={duration} buffered={buffered} rate={rate}
          muted={muted} volume={volume} theater={theater} fullscreen={fullscreen}
          visible={active && !idle}
          nextDisabled={!episodes.some((e) => e.ep_num === curEp + 1) && index >= videoIds.length - 1}
          nextTitle={episodes.some((e) => e.ep_num === curEp + 1) ? "下一集 E" : "下一部 ↓"}
          onToggle={() => videoRef.current?.toggle()}
          onSeek={(t) => { videoRef.current?.seek(t); setTime(t); }}
          onRate={(r) => { setRate(r); videoRef.current?.rate(r); }}
          onMute={() => setMuted((m) => !m)}
          onVolume={(v) => setVolume(v)}
          onPip={togglePip}
          onTheater={() => setTheater((v) => !v)}
          onFullscreen={toggleFull}
          onNext={() => {
            const nx = episodes.find((e) => e.ep_num === curEp + 1);
            if (nx) pickEp(nx.ep_num);
            else go(1);
          }}
        />
      )}

      {/* 移动端：倍速状态 / 锁定提示 */}
      {!isDesktop && (holdSpeed || speedLock || rate !== 1) && (
        <button
          onClick={() => {
            if (speedLock) { setSpeedLock(false); toast("已解除倍速锁定", "info"); }
            else if (rate !== 1 && !holdSpeed) setRate(1);
          }}
          className={`absolute left-1/2 -translate-x-1/2 z-30 flex items-center gap-1.5 px-3.5 h-8 rounded-full backdrop-blur-md text-[12px] font-bold elev-2 pressable ${speedLock ? "bg-primary text-on-primary" : "bg-black/45 text-amber"}`}
          style={{ top: "calc(var(--sat, 0px) + 54px)" }}>
          <IBoltF size={13} />
          {effRate}x {speedLock ? "已锁定 · 点按解除" : holdSpeed ? "倍速中 · 松开恢复" : "倍速"}
        </button>
      )}
      {!isDesktop && holdSpeed && (
        <div
          className={`absolute left-1/2 -translate-x-1/2 z-30 flex items-center gap-2 px-4 h-10 rounded-xl backdrop-blur-md elev-2 transition-all duration-200 ${lockArmed ? "bg-primary text-on-primary scale-110" : "bg-black/50 text-white/85"}`}
          style={{ top: "38%" }}>
          <ILockF size={16} />
          <span className="text-[12.5px] font-bold">{lockArmed ? "松开锁定 2.0x" : "上滑到此锁定倍速"}</span>
        </div>
      )}

      {/* 移动端进度条：28px 热区（视觉仍是细条，只向上长出透明抓取区），可拖动 */}
      {!isDesktop && (
        <div ref={barRef} className="absolute inset-x-0 z-30"
          style={{ bottom: fs ? "calc(var(--sab, 0px) + 52px)" : bottomInset - 2, height: 28, touchAction: "none" }}
          onPointerDown={onBarDown} onPointerMove={onBarMove} onPointerUp={onBarUp} onPointerCancel={onBarUp}>
          <div className={`absolute inset-x-0 bottom-[6px] transition-all duration-150 ${barPct !== null || fs ? "h-[5px]" : "h-[2.5px]"} bg-white/20`}>
            <div className="h-full relative"
              style={{ width: `${barProgress * 100}%`, background: barPct !== null ? "var(--p-primary)" : "rgba(255,255,255,.92)", transition: barPct !== null ? "none" : "width .25s linear" }}>
              <span className="absolute right-[-6px] top-1/2 -translate-y-1/2 w-3 h-3 rounded-full bg-white elev-1"
                style={{ boxShadow: "0 0 10px var(--p-glow), 0 1px 3px rgba(0,0,0,.45)" }} />
            </div>
          </div>
          {barPct !== null && (
            <div className="absolute left-1/2 -translate-x-1/2 bottom-7 px-3.5 py-1.5 rounded-lg bg-black/70 backdrop-blur-md text-[15px] font-bold text-white tabular-nums">
              {fmtTime(barPct * (duration || 0))} <span className="text-white/45 text-[12px] font-medium">/ {fmtTime(duration)}</span>
            </div>
          )}
        </div>
      )}

      {/* 移动端：全屏入口 */}
      {!isDesktop && !fs && (
        <button onClick={() => setFs(true)} aria-label="全屏"
          className="absolute right-4 z-20 w-9 h-9 rounded-full bg-black/45 flex items-center justify-center text-white/90 pressable elev-1"
          style={{ bottom: bottomInset + 56 }}>
          <IExpand size={17} />
        </button>
      )}

      {/* 移动端：沉浸全屏（安卓 WebView 不支持 Fullscreen API，改用应用内沉浸层） */}
      {!isDesktop && fs && (
        <>
          <button onClick={() => setFs(false)} aria-label="退出全屏"
            className="absolute right-3 z-40 w-9 h-9 rounded-full bg-black/50 backdrop-blur-md flex items-center justify-center text-white pressable elev-1"
            style={{ top: "calc(var(--sat, 0px) + 6px)" }}>
            <ICompress size={18} />
          </button>
          <div className="absolute inset-x-0 z-40 flex items-center gap-3 px-4"
            style={{ bottom: "calc(var(--sab, 0px) + 10px)" }}>
            <button onClick={() => videoRef.current?.toggle()}
              className="shrink-0 w-9 h-9 rounded-full bg-black/45 flex items-center justify-center text-white pressable">
              {paused ? <IPlayF size={18} /> : <IPauseF size={17} />}
            </button>
            <span className="shrink-0 text-[11.5px] font-semibold text-white/85 tabular-nums">{fmtTime(time)}</span>
            <button
              onClick={() => {
                if (speedLock) { setSpeedLock(false); return; }
                const seq = [1, 1.25, 1.5, 2];
                const i = seq.indexOf(rate);
                setRate(seq[(i + 1) % seq.length]);
              }}
              className={`ml-auto shrink-0 flex items-center gap-1 px-2.5 h-8 rounded-full text-[12px] font-bold pressable ${effRate !== 1 ? "bg-primary text-on-primary" : "bg-black/45 text-white/85"}`}>
              <IBoltF size={12} />{effRate}x
            </button>
            <span className="shrink-0 text-[11.5px] text-white/50 tabular-nums">{fmtTime(duration)}</span>
          </div>
        </>
      )}

      {/* 选集 / 评论：桌面停靠在右侧（画面让位），移动端底部弹层 */}
      {isDesktop ? (
        <div className={`desktop-dock-panel ${panel ? "is-open" : ""}`}>
          <div className="desktop-dock-inner">
            {panel === "episodes" ? (
              <EpisodesPanel videoId={curId} episodes={episodes} current={curEp} onPick={pickEp} onClose={() => setPanel(null)} />
            ) : panel === "comments" ? (
              <CommentsPanel videoId={curId} ep={curEp} total={meta.comment} kind={kind} onClose={() => setPanel(null)} />
            ) : null}
          </div>
        </div>
      ) : (
        <Sheet open={panel !== null} onClose={() => setPanel(null)}>
          <div className="flex flex-col h-full" style={{ height: "72vh" }}>
            {panel === "episodes" ? (
              <EpisodesPanel videoId={curId} episodes={episodes} current={curEp} onPick={pickEp} onClose={() => setPanel(null)} />
            ) : (
              <CommentsPanel videoId={curId} ep={curEp} total={meta.comment} kind={kind} onClose={() => setPanel(null)} />
            )}
          </div>
        </Sheet>
      )}
    </div>
  );
}
