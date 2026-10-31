/**
 * 把各平台的收藏、喜欢两个数据库同步成网页内容页读取的 public/data/<平台>/videos.json（对应见 src/platforms.mjs）。
 * 与 sync-follows.mjs 同一个工作流里依次运行，读什么也一样由环境变量决定：
 * - SYNC_PLATFORMS 里的平台两个库全表重读，每次都重写文件；SYNC_MODE=full 而没写平台时全部平台；
 * - SYNC_PAGES 里属于收藏、喜欢两个库的行按页面 ID 合并进所属平台的文件，只在确实变了时才写。
 *
 * 收藏、喜欢两个库各自独立：同一视频在两边各有一条记录，分类、取消各管各的。取消只看「取消日期」有没有填。
 * 抖音不再有收藏夹库，星标和 X、小红书一样，是两个库里的「星标」勾选列。
 * 文件按视频合并成一条，两边的记录分别放在 L（喜欢）、K（收藏）下。短键名：
 *   v 视频 ID（X 是帖子 ID，小红书是笔记 ID），u 视频链接（X 是帖子链接，小红书是笔记链接），t 文案（X 是正文，小红书是标题接正文；都只留前 300 字），a 作者，au 作者主页，n 图文（1），du 时长秒，pt 发布时间，lk 点赞数，g 话题
 *   L、K 里：id 页面 ID，c 分类，x 已取消（1），d 取消时刻，j 收藏或喜欢的时刻（「添加时间」，X 与小红书），q 添加顺序（「添加顺序」，三个平台都有，如「2026-10-03 · 0001」：批次日期加编号，越晚加入编号越大），s 标了星（1）
 * 顶层 cats 是两个库各自的分类选项顺序。
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { DATABASES, NAMES, fullPlatforms } from "../src/platforms.mjs";
import { writeSummary } from "./summary.mjs";
import { loadPages } from "./pages.mjs";

const ROOT = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const fileOf = (slug) => join(ROOT, `public/data/${slug}/videos.json`);
// 两个库在 src/platforms.mjs 里的键名，和页面上的叫法
const LIBS = { K: { key: "collect", label: "收藏" }, L: { key: "like", label: "喜欢" } };
// X 的收藏叫书签，库名是「X 书签」「X 喜欢」；小红书的喜欢叫点赞。只用在日志和报错里
const libTitle = (slug, lib) => slug === "x" ? `X ${lib === "K" ? "书签" : "喜欢"}` : slug === "rednote" ? `小红书${lib === "K" ? "收藏" : "点赞"}` : `${NAMES[slug]}${LIBS[lib].label}`;
const TIME = "添加时间";
const STARRED = "星标";
const NOTION_VERSION = "2025-09-03";
const PAGE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TOKEN = process.env.NOTION_TOKEN;
if (!TOKEN) throw new Error("缺少环境变量 NOTION_TOKEN");

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

async function queryAll(dataSourceId, name) {
  const pages = [];
  let cursor;
  do {
    const batch = await notion(`data_sources/${dataSourceId}/query`, {
      method: "POST",
      body: JSON.stringify({ page_size: 100, ...(cursor && { start_cursor: cursor }) }),
    });
    if (!batch) throw new Error(`读不到「${name}」数据库，只读的 Notion 连接是否还能访问它`);
    pages.push(...batch.results);
    cursor = batch.has_more ? batch.next_cursor : undefined;
  } while (cursor);
  return pages;
}

const text = (richText) => (richText ?? []).map((t) => t.plain_text).join("");
const compact = (obj) => Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== null && v !== undefined && v !== "" && v !== 0 && !(Array.isArray(v) && !v.length)));
// 抖音 /video/、/note/，X /status/ 后面的数字；小红书 /explore/ 后面 24 位的笔记编号
const videoId = (url) => url?.match(/\/(?:video|note|status)\/(\d+)/)?.[1] ?? url?.match(/\/explore\/([0-9a-f]{24})/)?.[1] ?? null;
// X 的帖子库用「帖子链接」「正文」两列，小红书用「笔记链接」「正文」，其余列名与抖音相同
const linkOf = (p) => p["视频链接"]?.url ?? p["帖子链接"]?.url ?? p["笔记链接"]?.url;
// 小红书的名称是笔记标题，正文里不含标题，两段接起来；X 的名称是正文第一行，不重复接
const textOf = (p) => text(p["文案"]?.rich_text) || (p["笔记链接"] ? [text(p["名称"]?.title), text(p["正文"]?.rich_text)].filter(Boolean).join("\n") : text(p["正文"]?.rich_text)) || text(p["名称"]?.title);

// 两个库共有的视频资料
function shared(p) {
  return compact({
    u: linkOf(p),
    t: textOf(p).slice(0, 300),
    a: text(p["作者"]?.rich_text),
    au: p["作者主页链接"]?.url,
    n: p["类型"]?.select?.name === "图文" ? 1 : 0,
    du: p["时长（秒）"]?.number,
    pt: p["发布时间"]?.date?.start,
    lk: p["点赞数"]?.number,
    g: text(p["话题"]?.rich_text),
  });
}
function record(page) {
  const p = page.properties;
  return compact({
    id: page.id,
    c: p["分类"]?.select?.name,
    x: p["取消日期"]?.date ? 1 : 0,
    d: p["取消日期"]?.date?.start,
    j: p[TIME]?.date?.start,
    q: text(p["添加顺序"]?.rich_text),
    s: p[STARRED]?.checkbox ? 1 : 0,
  });
}

// 字段按固定顺序排，按页面同步时才能和现有文件逐字比对出「没有变化」
const KEYS = ["v", "u", "t", "a", "au", "n", "du", "pt", "lk", "g", "L", "K"];
const ordered = (it) => Object.fromEntries(KEYS.filter((k) => k in it).map((k) => [k, it[k]]));

// 开始读 Notion 的时刻，网页拿它判断本机记录是否已被快照覆盖
const readAt = new Date().toISOString();
const FULL = fullPlatforms(process.env);
const ids = (process.env.SYNC_PAGES ?? "").split(",").map((s) => s.trim()).filter((s) => PAGE_ID.test(s));

async function syncPlatform(slug, db, pages) {
  const libs = Object.keys(LIBS).filter((lib) => db[LIBS[lib].key]);
  if (!libs.length) return;
  const out = fileOf(slug), title = (lib) => libTitle(slug, lib);
  const existing = existsSync(out) ? JSON.parse(readFileSync(out, "utf8")) : null;
  const full = FULL.has(slug);
  const libOf = (page) => libs.find((lib) => page?.parent?.data_source_id === db[LIBS[lib].key]);
  let cats = existing?.cats ?? {};
  const byVideo = new Map(full ? [] : (existing?.items ?? []).map((it) => [it.v, it]));

  function put(page, lib) {
    const v = videoId(linkOf(page.properties));
    if (!v) return;
    const { L, K } = byVideo.get(v) ?? {};
    byVideo.set(v, ordered({ v, L, K, ...shared(page.properties), [lib]: record(page) }));
  }
  // 把某个库里这一页的记录拿掉；视频两边都没有记录了就整条去掉
  // 改的是复制出来的一份：byVideo 里的条目和 existing.items 是同一批对象，直接删会连带改掉 existing，
  // 后面比对时两边一样，就误判成「没有变化」不写文件（移进回收站的行在网页上一直不消失）
  function drop(pageId) {
    for (const [v, it] of byVideo) {
      if (!libs.some((lib) => it[lib]?.id === pageId)) continue;
      const next = { ...it };
      for (const lib of libs) if (next[lib]?.id === pageId) delete next[lib];
      if (!libs.some((lib) => next[lib])) byVideo.delete(v);
      else byVideo.set(v, ordered(next));
    }
  }
  if (full) {
    cats = {};
    for (const lib of libs) {
      const id = db[LIBS[lib].key], schema = await notion(`data_sources/${id}`);
      if (!schema) throw new Error(`读不到「${title(lib)}」数据库`);
      cats[lib] = (schema.properties["分类"]?.select?.options ?? []).map((o) => o.name);
      const rows = await queryAll(id, title(lib));
      for (const page of rows) put(page, lib);
      console.log(`全量：「${title(lib)}」读了 ${rows.length} 行`);
    }
  } else {
    // 改的行里属于这个平台的：读得到的看它在哪个库；读不到的（已删除）看它原来在不在这个文件里
    const known = new Set([...byVideo.values()].flatMap((it) => libs.map((lib) => it[lib]?.id)).filter(Boolean));
    let mine = 0;
    for (const id of ids) {
      const page = pages.get(id);
      if (page ? !libOf(page) : !known.has(id)) continue;
      mine++;
      // 删掉的、移进垃圾箱的行从文件里去掉
      if (!page || page.in_trash || page.archived) drop(id);
      else put(page, libOf(page));
    }
    if (!mine) return;
    if (!existing) return console.log(`「${NAMES[slug]}」的内容还没有数据文件，等手动同步一次`);
    console.log(`按页面：${NAMES[slug]}的收藏、喜欢读了 ${mine} 行`);
  }

  const items = [...byVideo.values()].sort((a, b) => (b.pt ?? "").localeCompare(a.pt ?? "") || a.v.localeCompare(b.v));
  if (full && !items.length) throw new Error(`「${NAMES[slug]}」的收藏、喜欢都没有读到任何条目，保留现有文件`);
  if (!full && JSON.stringify(items) === JSON.stringify(existing.items)) {
    return console.log(`按页面：${NAMES[slug]}的内容没有变化，不写文件`);
  }
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify({ updated: readAt, cats, items }));
  console.log(`${full ? "全量" : "按页面"}：public/data/${slug}/videos.json 共 ${items.length} 条`);
  writeSummary(slug);
}

// 不用 process.exit：Windows 上请求刚结束就退出会触发 Node 的断言
async function main() {
  const pages = await loadPages(ids, notion);
  for (const [slug, db] of Object.entries(DATABASES)) await syncPlatform(slug, db, pages);
}
await main();
