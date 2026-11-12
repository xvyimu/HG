/**
 * 播放地址解析回归测试（纯函数，不联网）
 *
 *   node --test tests/
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { pickPlayUrl, playFieldReport, playUrlExpiry } from "../src/play.ts";

const M3U8 = "https://yd-hls.hzjvlo.cn/a/b/index.m3u8?auth_key=1793700503-0-0-abcdef";

test("取 video_url", () => {
  assert.equal(pickPlayUrl({ video_url: M3U8 }), M3U8);
});

test("上游改名成 hls_url 也能取到", () => {
  assert.equal(pickPlayUrl({ hls_url: M3U8 }), M3U8);
});

test("完全陌生的字段名：扫描 .m3u8 字符串", () => {
  assert.equal(pickPlayUrl({ some_new_field: M3U8, title: "第1集" }), M3U8);
});

test("video_url 空串时退到 hevc 源", () => {
  assert.equal(pickPlayUrl({ video_url: "", video_url_hevc: M3U8 }), M3U8);
});

test("没有任何地址时返回空串（不抛异常）", () => {
  assert.equal(pickPlayUrl({ title: "x", play: 1 }), "");
  assert.equal(pickPlayUrl(null), "");
  assert.equal(pickPlayUrl(undefined), "");
});

test("auth_key 里的时间戳作为过期时间", () => {
  const now = 1_700_000_000;
  assert.equal(playUrlExpiry(M3U8, now), 1793700503);
});

test("没有时效参数时按 45 分钟估", () => {
  const now = 1_700_000_000;
  assert.equal(playUrlExpiry("https://cdn.x/y/index.m3u8", now), now + 45 * 60);
});

test("过期时间戳在很久以前 → 不采信，按 45 分钟估", () => {
  const now = 1_793_700_000;
  const url = "https://cdn.x/y/index.m3u8?auth_key=1700000000-0-0-z";
  assert.equal(playUrlExpiry(url, now), now + 45 * 60);
});

test("诊断报告列出非空字符串字段", () => {
  const r = playFieldReport({ video_url: "", title: "第1集", page_title: "x" });
  assert.ok(r.includes("title=第1集"));
  assert.ok(!r.includes("video_url="));
});
