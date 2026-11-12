import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useStore, type Tab } from "../store";
import { Avatar } from "./ui";
import {
  IClose, IGrid, IGridF, IHome, IHomeF, IMinus, IMoon, IRestore, ISearch, ISidebar,
  ISquare, ISun, ITrophy, IUser, IUserF, Logo,
} from "../icons";

const appWindow = () => getCurrentWindow();

export function WindowsTitleBar({ collapsed, onToggle }: { collapsed: boolean; onToggle: () => void }) {
  const { theme, setTheme, setTab } = useStore();
  const [maxed, setMaxed] = useState(false);

  useEffect(() => {
    let un: (() => void) | undefined;
    appWindow().isMaximized().then(setMaxed).catch(() => {});
    appWindow().onResized(() => { appWindow().isMaximized().then(setMaxed).catch(() => {}); })
      .then((f: () => void) => { un = f; }).catch(() => {});
    return () => { un?.(); };
  }, []);

  return (
    <header className="win-titlebar" data-tauri-drag-region
      onDoubleClick={(e) => { if (!(e.target as HTMLElement).closest("button")) appWindow().toggleMaximize().catch(() => {}); }}>
      <div className="win-wordmark" data-tauri-drag-region>
        <Logo size={24} />
        <span>HG<span className="win-wordmark-light">hub</span></span>
      </div>
      <button className="win-caption-tool" aria-label={collapsed ? "展开侧栏" : "收起侧栏"} onClick={onToggle}>
        <ISidebar size={17} strokeWidth={1.7} />
      </button>
      <div className="win-drag-region" data-tauri-drag-region />
      <button className="win-caption-tool" aria-label="切换外观" onClick={() => setTheme(theme === "dark" ? "light" : "dark")}>
        {theme === "dark" ? <ISun size={17} strokeWidth={1.7} /> : <IMoon size={17} strokeWidth={1.7} />}
      </button>
      <button className="win-caption-tool" aria-label="搜索" onClick={() => setTab("search")}>
        <ISearch size={17} strokeWidth={1.7} />
      </button>
      <div className="win-caption-buttons">
        <button aria-label="最小化" onClick={() => appWindow().minimize().catch(() => {})}><IMinus size={15} strokeWidth={1.5} /></button>
        <button aria-label={maxed ? "还原" : "最大化"} onClick={() => appWindow().toggleMaximize().catch(() => {})}>
          {maxed ? <IRestore size={14} strokeWidth={1.5} /> : <ISquare size={14} strokeWidth={1.5} />}
        </button>
        <button className="win-close" aria-label="关闭" onClick={() => appWindow().close().catch(() => {})}><IClose size={16} strokeWidth={1.5} /></button>
      </div>
    </header>
  );
}

export function WindowsRail({ collapsed }: { collapsed: boolean }) {
  const { tab, setTab, user, openRanks, stack } = useStore();
  /** 排行榜是压在 tab 之上的一层页面：栈里存在就高亮它，且不让底层 tab 同时高亮 */
  const ranksOpen = stack.some((pg) => pg.kind === "ranks");
  const items: { key: Tab; label: string; Icon: typeof IHome; Filled: typeof IHomeF }[] = [
    { key: "home", label: "首页", Icon: IHome, Filled: IHomeF },
    { key: "category", label: "分类", Icon: IGrid, Filled: IGridF },
    { key: "profile", label: "我的", Icon: IUser, Filled: IUserF },
  ];
  return (
    <nav className={`win-sidebar ${collapsed ? "is-compact" : ""}`} aria-label="主导航">
      <div className="win-sidebar-inner">
        <button className={`win-search-launch ${!ranksOpen && tab === "search" ? "is-selected" : ""}`}
          onClick={() => setTab("search")} aria-label="搜索">
          <ISearch size={19} strokeWidth={1.7} />
          <span className="win-nav-copy">搜索你感兴趣的</span>
          <kbd className="win-nav-key">/</kbd>
        </button>
        <div className="win-nav-items">
          {items.map(({ key, label, Icon, Filled }) => {
            const sel = !ranksOpen && tab === key;
            return (
            <button key={key} aria-current={sel ? "page" : undefined}
              className={`win-nav-item ${sel ? "is-selected" : ""}`}
              onClick={() => setTab(key)}>
              <span className="win-nav-symbol">{sel ? <Filled size={21} /> : <Icon size={21} strokeWidth={1.7} />}</span>
              <span className="win-nav-copy">{label}</span>
            </button>
            );
          })}
          <button className={`win-nav-item ${ranksOpen ? "is-selected" : ""}`} aria-current={ranksOpen ? "page" : undefined}
            onClick={openRanks}>
            <span className="win-nav-symbol">{ranksOpen ? <ITrophy size={21} strokeWidth={2.1} /> : <ITrophy size={21} strokeWidth={1.7} />}</span>
            <span className="win-nav-copy">排行榜</span>
          </button>
        </div>
        <div className="win-sidebar-bottom">
          <button className="win-account" onClick={() => setTab("profile")}>
            <Avatar size={34} hue={220} name={user?.nickname} icon={user ? undefined : <IUser size={17} />} />
            <span className="win-account-copy">
              <strong>{user?.nickname || "我的"}</strong>
              <small>收藏与进度存在本机</small>
            </span>
          </button>
          <span className="win-sidebar-version">HGhub for Windows 1.0.0</span>
        </div>
      </div>
    </nav>
  );
}