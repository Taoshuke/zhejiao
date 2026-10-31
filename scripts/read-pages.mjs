/**
 * 把 SYNC_PAGES 里网页改过的行各读一次，写进 SYNC_PAGES_FILE（页面 ID → 页面，读不到的是 null），
 * 之后的 sync-follows.mjs、sync-videos.mjs、sync-wechat.mjs、sync-douban.mjs 从这个文件取，见 scripts/pages.mjs。
 * 同时算出这次要不要运行那几个脚本，写进 GITHUB_OUTPUT（creators、videos、wechat、douban，1 是要运行），工作流跳过不用运行的：
 * - 全表重读的平台有哪个库，就运行对应的脚本；SYNC_ORDER=1（博主的分类顺序变了）运行博主脚本；
 * - 读到的行按所在的库分给对应的脚本；读不到的行（已删除，看不出原来在哪个库）博主、内容、微信、豆瓣四个脚本都运行，由各自按现有数据文件判断。
 * 本机运行时没有 GITHUB_OUTPUT，只写页面文件。
 */
import { writeFileSync, appendFileSync } from "node:fs";
import { DATABASES, fullPlatforms } from "../src/platforms.mjs";

const NOTION_VERSION = "2025-09-03";
const PAGE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TOKEN = process.env.NOTION_TOKEN;
const FILE = process.env.SYNC_PAGES_FILE;
if (!TOKEN) throw new Error("缺少环境变量 NOTION_TOKEN");
if (!FILE) throw new Error("缺少环境变量 SYNC_PAGES_FILE");

// 404 时返回 null（行已删除，或连接看不到它），其余错误抛出
async function notion(path, init = {}) {
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(`https://api.notion.com/v1/${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${TOKEN}`, "Notion-Version": NOTION_VERSION, "Content-Type": "application/json" },
    });
    // 429 是 Notion 的限速，按它给的 Retry-After 等待后重试
    if (res.status === 429 && attempt <= 5) {
      await new Promise((r) => setTimeout(r, Number(res.headers.get("retry-after") ?? 1) * 1000));
      continue;
    }
    const body = await res.json();
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`Notion ${res.status} ${body.code ?? ""}: ${body.message ?? ""}`);
    return body;
  }
}

const ids = [...new Set((process.env.SYNC_PAGES ?? "").split(",").map((s) => s.trim()).filter((s) => PAGE_ID.test(s)))];
const pages = {};
for (const id of ids) pages[id] = await notion(`pages/${id}`);
writeFileSync(FILE, JSON.stringify(pages));

// 数据源 ID → 负责它的脚本
const owner = new Map();
for (const db of Object.values(DATABASES)) {
  if (db.creators) owner.set(db.creators, "creators");
  for (const key of ["collect", "like"]) if (db[key]) owner.set(db[key], "videos");
  if (db.articles) owner.set(db.articles, "wechat");
  if (db.books) owner.set(db.books, "douban");
  if (db.movies) owner.set(db.movies, "douban");
}
const run = new Set();
for (const slug of fullPlatforms(process.env)) {
  const db = DATABASES[slug];
  if (db.creators) run.add("creators");
  if (db.collect || db.like) run.add("videos");
  if (db.articles) run.add("wechat");
  if (db.books) run.add("douban");
}
if (process.env.SYNC_ORDER === "1") run.add("creators");
for (const page of Object.values(pages)) {
  if (!page) ["creators", "videos", "wechat", "douban"].forEach((s) => run.add(s));
  else if (owner.has(page.parent?.data_source_id)) run.add(owner.get(page.parent.data_source_id));
}
const flags = ["creators", "videos", "wechat", "douban"].map((s) => `${s}=${run.has(s) ? 1 : 0}`);
if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, flags.map((f) => `${f}\n`).join(""));
console.log(`读了 ${ids.length} 行网页改过的行；要运行的脚本：${[...run].join("、") || "无"}`);
