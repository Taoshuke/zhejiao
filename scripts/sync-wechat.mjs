/**
 * 把微信的「公众号」库（收藏里带链接的公众号文章，见 src/platforms.mjs 的 DATABASES.wechat.articles）同步成 public/data/wechat/videos.json。
 * 与 sync-follows.mjs、sync-videos.mjs 同一个工作流里依次运行，读什么由环境变量决定：
 * - SYNC_PLATFORMS 里有 wechat（或 SYNC_MODE=full 而没写平台）时全表重读，每次都重写文件；
 * - SYNC_PAGES 里属于这个库的行（网页上改了公众号的文章）按页面 ID 合并进现有文件，只在确实变了时才写，
 *   不读别的行，Notion 里还没手动同步的改动不会被顺带带进网页。
 * 文件名沿用 videos.json：Workers Builds 的监视路径已排除它，Worker 也只认 creators、videos 两种文件，同步提交不触发部署。
 * 短键名：id 页面 ID，n 标题（「标题」列，空的时候用「名称」），a 公众号，u 原文链接，j 收藏日期，o 顺序（收藏列表里的先后，1 是最早的），q 公众号待核（1）。
 * c 分类（按内容分的分类，网页上的「内容」视图用）；顶层 cats 是「分类」单选的选项顺序，全表重读时更新。
 * 条目按收藏日期从新到旧、同一天按顺序从新到旧排，和微信收藏列表一致。
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { DATABASES, fullPlatforms } from "../src/platforms.mjs";
import { writeSummary } from "./summary.mjs";

const ROOT = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const OUT = join(ROOT, "public/data/wechat/videos.json");
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

const text = (richText) => (richText ?? []).map((t) => t.plain_text).join("");

function toItem(page) {
  const p = page.properties;
  const item = {
    id: page.id,
    n: text(p["标题"]?.rich_text) || text(p["名称"]?.title),
    a: text(p["公众号"]?.rich_text),
    u: p["链接"]?.url,
    j: p["收藏时间"]?.date?.start,
    o: p["顺序"]?.number,
    q: p["公众号待核"]?.checkbox ? 1 : undefined,
    c: p["分类"]?.select?.name,
  };
  for (const [k, v] of Object.entries(item)) if (v === null || v === undefined || v === "") delete item[k];
  return item;
}

const order = (list) => list.sort((x, y) => (y.j ?? "").localeCompare(x.j ?? "") || (y.o ?? 0) - (x.o ?? 0));

// 按页面：改了的行里属于这个库的，读得到就换成新的，删掉或移进回收站的从文件里去掉
async function syncPages(source, readAt) {
  const ids = (process.env.SYNC_PAGES ?? "").split(",").map((s) => s.trim()).filter((s) => PAGE_ID.test(s));
  if (!ids.length || !existsSync(OUT)) return;
  const existing = JSON.parse(readFileSync(OUT, "utf8"));
  const byId = new Map(existing.items.map((it) => [it.id, it]));
  let mine = 0;
  for (const id of ids) {
    const page = await notion(`pages/${id}`);
    if (page ? page.parent?.data_source_id !== source : !byId.has(id)) continue;
    mine++;
    if (!page || page.in_trash || page.archived) byId.delete(id);
    else byId.set(id, toItem(page));
  }
  if (!mine) return;
  const items = order([...byId.values()].filter((it) => it.u && it.n));
  if (JSON.stringify(items) === JSON.stringify(existing.items)) return console.log(`按页面：「公众号」读了 ${mine} 行，没有变化，不写文件`);
  writeFileSync(OUT, JSON.stringify({ updated: readAt, cats: existing.cats ?? [], items }));
  console.log(`按页面：「公众号」读了 ${mine} 行，public/data/wechat/videos.json 共 ${items.length} 条`);
  writeSummary("wechat");
}

async function main() {
  const source = DATABASES.wechat?.articles;
  if (!source) return;
  const readAt = new Date().toISOString();
  if (!fullPlatforms(process.env).has("wechat")) return syncPages(source, readAt);
  const schema = await notion(`data_sources/${source}`);
  if (!schema) throw new Error("读不到「公众号」数据库，只读的 Notion 连接是否还能访问它");
  const cats = (schema.properties["分类"]?.select?.options ?? []).map((o) => o.name);
  const items = [];
  let cursor;
  do {
    const batch = await notion(`data_sources/${source}/query`, {
      method: "POST",
      body: JSON.stringify({ page_size: 100, ...(cursor && { start_cursor: cursor }) }),
    });
    if (!batch) throw new Error("读不到「公众号」数据库，只读的 Notion 连接是否还能访问它");
    items.push(...batch.results.map(toItem));
    cursor = batch.has_more ? batch.next_cursor : undefined;
  } while (cursor);
  const shown = items.filter((it) => it.u && it.n);
  // 读空时不覆盖，防止权限或连接出问题时把现有数据清掉；按失败退出，网页上会显示同步失败
  if (!shown.length) throw new Error("「公众号」没有读到任何条目，保留现有文件");
  order(shown);
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify({ updated: readAt, cats, items: shown }));
  console.log(`全量：public/data/wechat/videos.json 共 ${shown.length} 条`);
  writeSummary("wechat");
}
await main();
