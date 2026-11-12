import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { api, platform as envPlatform } from "./api";
import type { User } from "./types";

export type Platform = "android" | "windows";
export type Theme = "dark" | "light";
export type Tab = "home" | "search" | "category" | "profile";

/** 播放页上下文：ids 是来源列表，index 是当前条目。 */
export type FeedContext = {
  kind: "feed";
  key: string;
  videoIds: number[];
  index: number;
  title: string;
  source: string;
  feedKind?: "video" | "post";
};

export type Page =
  | FeedContext
  | { kind: "channel"; key: string; cate: string; name: string }
  | { kind: "ranks"; key: string }
  | { kind: "posts"; key: string }
  | { kind: "post"; key: string; id: number };

export type PageInput =
  | { kind: "feed"; videoIds: number[]; index: number; title: string; source?: string; feedKind?: "video" | "post" }
  | { kind: "channel"; cate: string; name: string }
  | { kind: "ranks" }
  | { kind: "posts" }
  | { kind: "post"; id: number };

export type Toast = { id: number; msg: string; icon?: "ok" | "heart" | "star" | "info" };

type Persist = {
  likes: number[];
  favs: number[];
  history: number[];
  follows: number[];
  muted: boolean;
  volume: number;
  searchHist: string[];
  /** 上次选择的倍速，跨会话保留 */
  rate: number;
  /** 断点续播：`id` → 上次看到的集与秒数（`at` 用于淘汰最久未看的） */
  pos: Record<string, { ep: number; t: number; at: number }>;
};

const LS = "hghub_app_v1";
const DEFAULTS: Persist = {
  likes: [], favs: [], history: [], follows: [],
  muted: true, volume: 0.7, searchHist: [],
  rate: 1, pos: {},
};

function loadPersist(): Persist {
  try {
    const raw = localStorage.getItem(LS);
    if (!raw) return DEFAULTS;
    return { ...DEFAULTS, ...(JSON.parse(raw) as Partial<Persist>) };
  } catch {
    return DEFAULTS;
  }
}

function readTheme(): Theme {
  try {
    return localStorage.getItem("hghub_theme") === "light" ? "light" : "dark";
  } catch {
    return "dark";
  }
}

function applyTheme(theme: Theme) {
  document.documentElement.classList.toggle("theme-light", theme === "light");
  document.documentElement.style.colorScheme = theme;
}

type Store = {
  platform: Platform;
  theme: Theme; setTheme: (t: Theme) => void;
  tab: Tab; setTab: (t: Tab) => void;
  stack: Page[]; push: (p: PageInput) => void; pop: () => void;
  user: User | null; setUser: (u: User | null) => void;
  loginOpen: boolean; setLoginOpen: (b: boolean) => void;
  logout: () => Promise<void>;
  likes: number[]; favs: number[]; history: number[]; follows: number[];
  isLiked: (id: number) => boolean; isFav: (id: number) => boolean;
  toggleLikeLocal: (id: number) => boolean;
  toggleFavLocal: (id: number) => boolean;
  addHistory: (id: number) => void;
  clearHistory: () => void;
  clearLocal: () => void;
  toggleFollowLocal: (uid: number) => boolean;
  theater: boolean; setTheater: (v: boolean | ((p: boolean) => boolean)) => void;
  fs: boolean; setFs: (v: boolean | ((p: boolean) => boolean)) => void;
  muted: boolean; setMuted: (v: boolean | ((p: boolean) => boolean)) => void;
  volume: number; setVolume: (v: number) => void;
  /** 播放倍速（持久化） */
  rate: number; setRate: (r: number) => void;
  /** 断点续播位置 */
  pos: Record<string, { ep: number; t: number; at: number }>;
  savePos: (id: number, ep: number, t: number) => void;
  /** 只记「看到第几集」（选集切换时用），不看秒数 */
  saveEp: (id: number, ep: number) => void;
  searchHist: string[]; addSearch: (q: string) => void; clearSearchHist: () => void;
  toasts: Toast[]; toast: (msg: string, icon?: Toast["icon"]) => void;
};

const Ctx = createContext<Store>(null as unknown as Store);
export const useStore = () => useContext(Ctx);
let seq = 0;

export function AppProvider({ children }: { children: React.ReactNode }) {
  const [p, setP] = useState<Persist>(loadPersist);
  const [theme, setThemeState] = useState<Theme>(readTheme);
  const [tab, setTabRaw] = useState<Tab>("home");
  const [stack, setStack] = useState<Page[]>([]);
  const [user, setUser] = useState<User | null>(null);
  const [loginOpen, setLoginOpen] = useState(false);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [theater, setTheaterState] = useState(false);
  const [fs, setFsState] = useState(false);
  const toastSeq = useRef(0);

  useEffect(() => {
    applyTheme(theme);
    try { localStorage.setItem("hghub_theme", theme); } catch { /* ignore */ }
  }, [theme]);

  useEffect(() => {
    /* 去抖：播放进度每几秒变一次，直接同步写 localStorage 会卡主线程 */
    const timer = window.setTimeout(() => {
      try { localStorage.setItem(LS, JSON.stringify(p)); } catch { /* ignore */ }
    }, 800);
    return () => window.clearTimeout(timer);
  }, [p]);

  useEffect(() => {
    api.boot()
      .then((r) => { if (r.user && (r.user as User).id) setUser(r.user as User); })
      .catch(() => { /* 离线也能用 */ });
  }, []);

  const toast = useCallback((msg: string, icon?: Toast["icon"]) => {
    const id = ++toastSeq.current;
    setToasts((t) => [...t.slice(-2), { id, msg, icon }]);
    window.setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 2200);
  }, []);

  const setTab = useCallback((t: Tab) => { setTabRaw(t); setStack([]); }, []);
  const push = useCallback((pg: PageInput) => {
    setStack((s) => [...s, { ...pg, key: `p${++seq}` } as Page]);
  }, []);
  const pop = useCallback(() => setStack((s) => s.slice(0, -1)), []);

  const toggleLikeLocal = useCallback((id: number) => {
    let on = false;
    setP((s) => {
      on = !s.likes.includes(id);
      return { ...s, likes: on ? [id, ...s.likes] : s.likes.filter((x) => x !== id) };
    });
    return on;
  }, []);
  const toggleFavLocal = useCallback((id: number) => {
    let on = false;
    setP((s) => {
      on = !s.favs.includes(id);
      return { ...s, favs: on ? [id, ...s.favs] : s.favs.filter((x) => x !== id) };
    });
    return on;
  }, []);
  const toggleFollowLocal = useCallback((uid: number) => {
    let on = false;
    setP((s) => {
      on = !s.follows.includes(uid);
      return { ...s, follows: on ? [uid, ...s.follows] : s.follows.filter((x) => x !== uid) };
    });
    return on;
  }, []);
  const addHistory = useCallback((id: number) => {
    setP((s) => ({ ...s, history: [id, ...s.history.filter((x) => x !== id)].slice(0, 80) }));
  }, []);
  const clearHistory = useCallback(() => setP((s) => ({ ...s, history: [], pos: {} })), []);
  const clearLocal = useCallback(() => setP((s) => ({ ...s, likes: [], favs: [], history: [], searchHist: [], pos: {} })), []);
  const addSearch = useCallback((q: string) => {
    const t = q.trim();
    if (!t) return;
    setP((s) => ({ ...s, searchHist: [t, ...s.searchHist.filter((x) => x !== t)].slice(0, 12) }));
  }, []);
  const clearSearchHist = useCallback(() => setP((s) => ({ ...s, searchHist: [] })), []);

  const logout = useCallback(async () => {
    try { await api.logout(); } catch { /* ignore */ }
    setUser(null);
    toast("已退出登录", "info");
  }, [toast]);

  const setTheater = useCallback((v: boolean | ((prev: boolean) => boolean)) => {
    setTheaterState((prev) => (typeof v === "function" ? (v as (p: boolean) => boolean)(prev) : v));
  }, []);

  const setFs = useCallback((v: boolean | ((prev: boolean) => boolean)) => {
    setFsState((prev) => (typeof v === "function" ? (v as (p: boolean) => boolean)(prev) : v));
  }, []);

  const setMuted = useCallback((v: boolean | ((prev: boolean) => boolean)) => {
    setP((s) => ({ ...s, muted: typeof v === "function" ? v(s.muted) : v }));
  }, []);
  const setVolume = useCallback((v: number) => {
    const volume = Math.max(0, Math.min(1, v));
    setP((s) => ({ ...s, volume, muted: volume === 0 }));
  }, []);
  const setRate = useCallback((r: number) => {
    setP((s) => ({ ...s, rate: r }));
  }, []);
  /** 每 5 秒写一次，避免 timeupdate 把 localStorage 打爆 */
  const savePos = useCallback((id: number, ep: number, t: number) => {
    if (!id || !Number.isFinite(t) || t < 3) return;
    setP((s) => {
      const prev = s.pos[String(id)];
      if (prev && prev.ep === ep && Math.abs(prev.t - t) < 4) return s;
      const pos: Persist["pos"] = { ...s.pos, [String(id)]: { ep, t, at: Date.now() } };
      const keys = Object.keys(pos);
      /* 只留最近 120 部：按 at 淘汰最久未看的（按 id 排序会永远删最小 id） */
      if (keys.length > 120) {
        const drop = keys.sort((a, b) => pos[a].at - pos[b].at).slice(0, keys.length - 120);
        for (const k of drop) delete pos[k];
      }
      return { ...s, pos };
    });
  }, []);

  const saveEp = useCallback((id: number, ep: number) => {
    if (!id || !ep) return;
    setP((s) => {
      const prev = s.pos[String(id)];
      if (prev && prev.ep === ep) return s;
      return { ...s, pos: { ...s.pos, [String(id)]: { ep, t: 0, at: Date.now() } } };
    });
  }, []);

  const value = useMemo<Store>(() => ({
    platform: envPlatform,
    theme, setTheme: setThemeState,
    tab, setTab, stack, push, pop,
    user, setUser, loginOpen, setLoginOpen, logout,
    likes: p.likes, favs: p.favs, history: p.history, follows: p.follows,
    isLiked: (id) => p.likes.includes(id),
    isFav: (id) => p.favs.includes(id),
    toggleLikeLocal, toggleFavLocal, toggleFollowLocal, addHistory, clearHistory, clearLocal,
    muted: p.muted, setMuted, volume: p.volume, setVolume, theater, setTheater, fs, setFs,
    rate: p.rate, setRate, pos: p.pos, savePos, saveEp,
    searchHist: p.searchHist, addSearch, clearSearchHist,
    toasts, toast,
  }), [theme, tab, setTab, stack, push, pop, user, loginOpen, logout,
    p, toggleLikeLocal, toggleFavLocal, toggleFollowLocal, addHistory, clearHistory, clearLocal,
    setMuted, setVolume, setRate, savePos, addSearch, clearSearchHist, toasts, toast, theater, setTheater, fs, setFs]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
