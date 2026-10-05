/**
 * 把各平台的博主数据库同步成网页读取的 public/data/<平台>/creators.json（平台和数据库的对应见 src/platforms.mjs）。
 *
 * 由环境变量决定读什么：
 * - SYNC_PLATFORMS：逗号分隔的平台英文名，这些平台重读全表，一万条约百次请求。网页上点「从 Notion 同步」时只写当前平台；
 *   SYNC_MODE=full 而没写平台时（手动运行工作流）全部平台都重读。Notion 里的一切改动（包括删行、改分类选项）都在这时进网页，
 *   脚本批量改完也不自动触发。
 * - SYNC_PAGES：网页上改了的几行，按页面 ID 合并进所属平台的文件；SYNC_ORDER=1 时另读一次各平台的分类选项。
 *   只把网页自己的改动落进文件，不读别的行，Notion 里还没手动同步的改动不会被顺带带进网页。
 *
 * 全表重读的平台每次都重写文件（updated 换成这次读 Notion 的时间），不和现有文件比对；网页据 updated 变了确认同步成功。
 * 按页面合并的只在那几行确实变了时才写，网页上连点几下不至于每次都提交。
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { DATABASES, NAMES, fullPlatforms } from "../src/platforms.mjs";
import { writeSummary } from "./summary.mjs";

const ROOT = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const fileOf = (slug) => join(ROOT, `public/data/${slug}/creators.json`);
const NOTION_VERSION = "2025-09-03";
const PAGE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TOKEN = process.env.NOTION_TOKEN;
if (!TOKEN) throw new Error("缺少环境变量 NOTION_TOKEN");

// 404 时返回 null（行已删除，或连接看不到它），其余错误抛出
async function notion(path, init = {}) {
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(`https://api.notion.com/v1/${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        "Notion-Version": NOTION_VERSION,
        "Content-Type": "application/json",
      },
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

async function categoriesOf(dataSourceId, name) {
  const schema = await notion(`data_sources/${dataSourceId}`);
  if (!schema) throw new Error(`读不到「${name}」数据库`);
  return (schema.properties["分类"]?.select?.options ?? []).map((o) => o.name);
}

const text = (richText) => (richText ?? []).map((t) => t.plain_text).join("");

// 短键名压体积：id 页面 ID，n 名称 c 分类 u 主页 b 简介 a 头像 f 粉丝数，
// x 已取关（1），d 取关日期（带时区的时刻，如 2026-10-03T14:05:00.000-05:00，也可以只有日期），s 特别关注（1），j 关注日期（格式同取关日期），
// o 关注顺序（抖音「最近关注」列表排出来的名次，1 是最早关注的，越大越新；已取关、不在名单里的没有）
function toItem(page) {
  const p = page.properties;
  const item = { id: page.id, n: text(p["名称"]?.title) };
  const fields = {
    c: p["分类"]?.select?.name,
    u: p["主页链接"]?.url,
    b: text(p["简介"]?.rich_text),
    a: p["头像"]?.url,
    f: p["粉丝数"]?.number,
    x: p["已取关"]?.checkbox ? 1 : undefined,
    d: p["取关日期"]?.date?.start,
    s: p["特别关注"]?.checkbox ? 1 : undefined,
    j: p["关注日期"]?.date?.start,
    o: p["关注顺序"]?.number,
  };
  for (const [k, v] of Object.entries(fields)) if (v !== null && v !== undefined && v !== "") item[k] = v;
  return item;
}

// 开始读 Notion 的时刻：之后网页拿到这份快照时，在这之前做的网页改动都以快照为准
const readAt = new Date().toISOString();
const FULL = fullPlatforms(process.env);
const ORDER = process.env.SYNC_ORDER === "1";
const ids = (process.env.SYNC_PAGES ?? "").split(",").map((s) => s.trim()).filter((s) => PAGE_ID.test(s));

async function syncPlatform(slug, db, pages) {
  if (!db.creators) return;
  const name = `${NAMES[slug]}博主`, out = fileOf(slug);
  const existing = existsSync(out) ? JSON.parse(readFileSync(out, "utf8")) : null;
  const full = FULL.has(slug);
  let categories = existing?.categories, byId;
  if (full) {
    categories = await categoriesOf(db.creators, name);
    byId = new Map((await queryAll(db.creators, name)).map((pg) => [pg.id, toItem(pg)]));
  } else {
    // 改的行里属于这个平台的：读得到的看它在哪个库；读不到的（已删除）看它原来在不在这个文件里
    const known = new Set((existing?.items ?? []).map((it) => it.id));
    const mine = ids.filter((id) => (pages.get(id) ? pages.get(id).parent?.data_source_id === db.creators : known.has(id)));
    if (!mine.length && !ORDER) return;
    if (!existing) return console.log(`「${name}」还没有数据文件，等手动同步一次`);
    byId = new Map(existing.items.map((it) => [it.id, it]));
    for (const id of mine) {
      const page = pages.get(id);
      // 删掉的、移进垃圾箱的、已经不属于这个数据库的，从文件里去掉
      if (!page || page.in_trash || page.archived || page.parent?.data_source_id !== db.creators) byId.delete(id);
      else byId.set(id, toItem(page));
    }
    if (ORDER) categories = await categoriesOf(db.creators, name);
    console.log(`按页面：「${name}」读了 ${mine.length} 行${ORDER ? "，另读了分类顺序" : ""}`);
  }

  const items = [...byId.values()]
    .filter((it) => it.n)
    .sort((x, y) => (y.f ?? 0) - (x.f ?? 0) || x.n.localeCompare(y.n) || x.id.localeCompare(y.id));
  // 数据库读空时不覆盖，防止权限或连接出问题时把现有数据清掉；按失败退出，网页上会显示同步失败
  if (!items.length) throw new Error(`「${name}」没有读到任何条目，保留现有文件`);
  if (!full && JSON.stringify({ categories, items }) === JSON.stringify({ categories: existing.categories, items: existing.items })) {
    return console.log(`按页面：「${name}」没有变化，不写文件`);
  }
  // updated 是这份数据开始读 Notion 的时间：网页上「从 Notion 同步」旁边显示它，也用它判断本机记录是否已被快照覆盖
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify({ updated: readAt, categories, items }));
  console.log(`${full ? "全量" : "按页面"}：public/data/${slug}/creators.json 共 ${items.length} 条`);
  writeSummary(slug);
}

// 不用 process.exit：Windows 上请求刚结束就退出会触发 Node 的断言
async function main() {
  const pages = new Map();
  for (const id of ids) pages.set(id, await notion(`pages/${id}`));
  for (const [slug, db] of Object.entries(DATABASES)) await syncPlatform(slug, db, pages);
}
await main();
