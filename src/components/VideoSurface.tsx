import { useEffect, useImperativeHandle, useRef, forwardRef, useState } from "react";
import Hls from "hls.js";
import { playlist } from "../api";

export type VideoHandle = {
  el: () => HTMLVideoElement | null;
  play: () => void;
  pause: () => void;
  toggle: () => void;
  seek: (t: number) => void;
  rate: (r: number) => void;
  mute: (m: boolean) => void;
  volume: (v: number) => void;
};

type Props = {
  src: string;
  poster?: string;
  autoPlay?: boolean;
  muted?: boolean;
  loop?: boolean;
  fit?: "contain" | "cover";
  /** 换源后重新套用，避免切集时音量/倍速被浏览器重置 */
  volume?: number;
  rate?: number;
  /** 同一条地址需要强制重建播放器时递增（上游恢复但 URL 未变） */
  reload?: number;
  onTime?: (t: number) => void;
  onDuration?: (d: number) => void;
  onSize?: (w: number, h: number) => void;
  onPlaying?: () => void;
  onPause?: () => void;
  onWaiting?: () => void;
  onEnded?: () => void;
  onError?: (msg: string, fatal?: boolean) => void;
  onClick?: () => void;
  className?: string;
};

/** 只负责「播」：hls.js + video 元素，控制条由外层渲染。 */
const VideoSurface = forwardRef<VideoHandle, Props>(function VideoSurface(
  { src, poster, autoPlay = true, muted = false, loop = false, fit = "contain", volume = 1, rate = 1, reload = 0,
    onTime, onDuration, onSize, onPlaying, onPause, onWaiting, onEnded, onError, onClick, className = "" },
  ref,
) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const hlsRef = useRef<Hls | null>(null);
  const [ready, setReady] = useState(false);

  useImperativeHandle(ref, () => ({
    el: () => videoRef.current,
    play: () => { videoRef.current?.play().catch(() => {}); },
    pause: () => videoRef.current?.pause(),
    toggle: () => {
      const v = videoRef.current;
      if (!v) return;
      if (v.paused) v.play().catch(() => {}); else v.pause();
    },
    seek: (t: number) => { const v = videoRef.current; if (v && Number.isFinite(t)) v.currentTime = t; },
    rate: (r: number) => { const v = videoRef.current; if (v) v.playbackRate = r; },
    mute: (m: boolean) => { const v = videoRef.current; if (v) v.muted = m; },
    volume: (vol: number) => { const v = videoRef.current; if (v) v.volume = vol; },
  }), []);

  /** 最新回调放 ref：hls 实例只建一次，闭包不能锁死旧的 onError */
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !src) return;
    setReady(false);

    const proxied = /^https?:\/\/hg\.localhost\//.test(src);
    const url = proxied ? src : playlist(src);
    const useHls = !url.includes("/seg?u=");

    /* 换源时先把音量/倍速套回去：hls 重新 attach 后浏览器会把它们重置成默认值 */
    const applySettings = () => {
      const v = videoRef.current;
      if (!v) return;
      v.volume = volume;
      v.muted = muted;
      v.playbackRate = rate;
    };
    applySettings();

    if (useHls && Hls.isSupported()) {
      /* 复用实例：切集只换 source，不重建 hls —— 否则每集都要重新握手、黑屏 1~2 秒、缓冲全丢 */
      let hls = hlsRef.current;
      if (!hls) {
        hls = new Hls({
          enableWorker: true,
          lowLatencyMode: false,
          startLevel: -1,
          abrEwmaDefaultEstimate: 800_000,
          /* 短剧单集 2~3 分钟：缓冲拉长一点，少卡顿；关掉起播带宽探测，首帧更快 */
          testBandwidth: false,
          maxBufferLength: 40,
          maxMaxBufferLength: 80,
          backBufferLength: 20,
          capLevelToPlayerSize: true,
          manifestLoadingTimeOut: 20000,
          manifestLoadingMaxRetry: 3,
          levelLoadingMaxRetry: 4,
          fragLoadingMaxRetry: 4,
          fragLoadingTimeOut: 20000,
        });
        hls.on(Hls.Events.MANIFEST_PARSED, () => {
          if (autoPlay) video.play().catch(() => {});
        });
        hls.on(Hls.Events.ERROR, (_e, data) => {
          if (!data.fatal) return;
          onErrorRef.current?.(`${data.type}/${data.details}`, true);
          if (data.type === Hls.ErrorTypes.NETWORK_ERROR) hls?.startLoad();
          else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) hls?.recoverMediaError();
          /* 其它致命错误不销毁实例：父组件会换地址或用 reload 触发重新 loadSource，
             销毁会让「地址没变」的重试永远重建不出来 */
          else hls?.stopLoad();
        });
        hls.attachMedia(video);
        hlsRef.current = hls;
      }
      hls.stopLoad();
      hls.loadSource(url);
      return;
    }

    if (hlsRef.current) { hlsRef.current.destroy(); hlsRef.current = null; }
    video.src = url;
    if (autoPlay) video.play().catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src, reload]);

  /* 组件卸载才销毁实例 */
  useEffect(() => () => {
    if (hlsRef.current) { hlsRef.current.destroy(); hlsRef.current = null; }
  }, []);

  useEffect(() => { if (videoRef.current) videoRef.current.muted = muted; }, [muted]);
  useEffect(() => { if (videoRef.current) videoRef.current.volume = volume; }, [volume]);
  useEffect(() => { if (videoRef.current) videoRef.current.playbackRate = rate; }, [rate]);

  const reapply = (v: HTMLVideoElement) => {
    v.volume = volume;
    v.muted = muted;
    v.playbackRate = rate;
  };

  return (
    <video
      ref={videoRef}
      poster={poster}
      playsInline
      preload="auto"
      loop={loop}
      onClick={onClick}
      className={`w-full h-full bg-black ${fit === "cover" ? "object-cover" : "object-contain"} ${className}`}
      style={{ opacity: ready ? 1 : 0, transition: "opacity .35s" }}
      onLoadedData={(e) => { setReady(true); reapply(e.target as HTMLVideoElement); }}
      onTimeUpdate={(e) => onTime?.((e.target as HTMLVideoElement).currentTime)}
      onLoadedMetadata={(e) => {
        const v = e.target as HTMLVideoElement;
        reapply(v);
        onDuration?.(v.duration || 0);
        onSize?.(v.videoWidth || 0, v.videoHeight || 0);
      }}
      onPlay={() => onPlaying?.()}
      onPause={() => onPause?.()}
      onWaiting={() => onWaiting?.()}
      onPlaying={() => onPlaying?.()}
      onEnded={() => onEnded?.()}
    />
  );
});

export default VideoSurface;