/**
 * 把豆瓣的「豆瓣读书」库（见 src/platforms.mjs 的 DATABASES.douban.books）同步成 public/data/douban/videos.json，
 * 「豆瓣影视」库（DATABASES.douban.movies）同步成 public/data/douban/movies.json；两个库一起读，下面说的都是书，影视的不同处见 KINDS。
 * 与另外几个同步脚本同一个工作流里依次运行，读什么由环境变量决定，做法同 sync-wechat.mjs：
 * - SYNC_PLATFORMS 里有 douban（或 SYNC_MODE=full 而没写平台）时全表重读，每次都重写文件；
 * - SYNC_PAGES 里属于这个库的行（网页上标星、标记取消或恢复的书）按页面 ID 合并进现有文件，只在确实变了时才写，
 *   不读别的行，Notion 里还没手动同步的改动不会被顺带带进网页。
 * 文件名沿用 videos.json，理由同 sync-wechat.mjs：Worker 只认 creators、videos、summary 几种文件，Workers Builds 的监视路径也已排除它。
 * 短键名：id 页面 ID，n 书名，v 豆瓣条目编号（豆瓣链接里 /subject/ 后面那串数字），u 豆瓣链接，
 * a 作者（数组），r 译者，p 出版社，y 出版年（四位数字），s 短评，g 分类（数组；每本 1 到 3 个题材类，非中文的书可另加一个语种类），z 专题（数组，按内容归纳的细主题，不是每本都有），
 * st 星标（1），x 已取消（1），d 取消时刻（「取消日期」，网页上标记取消时写的本地时间带时区），f 有封面（1）。
 * 作者、译者、出版社、出版年都从「出版信息」一列拆出来（形如「[某国] 作者名 / 译者名 / 某某出版社 / 2020-8 / 68.00元」，段数不固定），定价不留。
 * 取消只看「取消日期」有没有填，库里没有单独的勾选框，同内容页的收藏、喜欢库；取消了的书留在文件里，网页上只在「近期取消」里出现。
 * 封面是仓库里的 public/covers/douban/<条目编号>.jpg，随网页部署；这里只看文件在不在，在就标 f，网页据此显示真封面，没有的显示按书名生成的书封。
 * 顶层 cats 是两列多选的选项顺序：g「分类」，z「专题」，全表重读时更新。
 * 条目按 Notion 行的创建时间从新到旧排，网页上的「近期新增」就取这个先后。按豆瓣的想读、在读、读过分批导入时，后导入的批次整体排在前面。
 * 创建时间只精确到分钟，同一分钟里保持接口返回的先后，不再按别的排。按页面同步时改了的行留在原位。
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { DATABASES, fullPlatforms } from "../src/platforms.mjs";
import { writeSummary } from "./summary.mjs";
import { loadPages } from "./pages.mjs";

const ROOT = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
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

// ===== 拆「出版信息」：作者 / 译者 / 出版社 / 出版年 / 定价，哪一段都可能缺 =====
// 出版年、定价、版次按样子认出来，剩下的是人名和出版社：第一段是作者，最后一段是出版社，中间的是译者
const DATE_RE = /^(1[5-9]|20)\d{2}(\s*[-.\/年]\s*\d{1,2}(\s*[-.\/月]\s*\d{1,2})?)?\s*[年月日]?$/;
// 定价：可选币种前缀、数字开头，后面允许「元」「円＋税」「（台幣）」「【兩冊】」之类的尾巴
const PRICE_RE = /^(?:[A-Za-z]{1,4}\s?\$?|\$|£|€|¥|￥)?\s*\d+(?:[.,]\d+)?(?:\s*\S.*)?$/;
const EDITION_RE = /^第.{1,4}版/;
// 只剩一段时靠它分辨是出版社还是作者
const PUB_RE = /出版|书店|書店|书局|書局|印书馆|書館|书社|書社|书房|公司|集团|文库|文化|中心|研究所|大学|大學|学院|画报|社$|press|pub|verlag|books|seuil|gallimard|penguin|routledge|wiley|springer|norton|harper|random|vintage|oxford|cambridge|editions|éditions|knopf|library|house|touchstone|arrow|liveright|foundation|^oup/i;
const LATIN_RE = /^[\x00-\x7FÀ-ɏ‘’'·.\s-]+$/;
// 同一家出版社的几种写法并成一个，侧栏按出版社分组时不拆成两组
const PUB_ALIAS = { "中信出版集团": "中信出版社", "生活书店出版": "生活书店", "OUP": "Oxford University Press", "OUP USA": "Oxford University Press" };
const cleanPub = (s) => {
  const p = (s.split(/\s*[\/丨|]\s*/).filter(Boolean).pop() ?? s).replace(/(股份)?有限(责任)?公司$/, "").trim();
  return PUB_ALIAS[p] ?? p;
};
// 作者段：去国籍标记、括注的原名、「著」「编」等，按顿号或国籍标记拆成多人；英文「姓, 名」写法不拆逗号
const NATION_RE = /\s*[\[［【(（][^\]］】)）]{1,6}[\]］】)）]\s*/g;
function splitAuthors(seg) {
  const s = seg.replace(/\|.*$/, "").replace(/[（(][^）)]*[A-Za-zÀ-ÿА-яЁё][^）)]*[)）]/g, " ");
  const parts = LATIN_RE.test(s) ? s.split(/\s*(?:[、;；]|\/\/?)\s*/) : s.split(/\s*(?:[、，,;；]|\/\/?)\s*/);
  const out = [];
  for (const p of parts) for (const q of p.split(NATION_RE)) {
    let n = q.replace(/\s*(编著|主编|编译|编|著|绘|译|等)\s*$/, "").replace(/[•?]/g, "·").replace(/\s+/g, " ").trim();
    const m = n.match(/^([A-Z][\w'-]+),\s*([A-Z][\w.' -]*)$/); // Bowen, Murray → Murray Bowen
    if (m) n = `${m[2]} ${m[1]}`;
    if (n && !out.includes(n)) out.push(n);
  }
  return out;
}
function parsePub(raw) {
  // 只按至少一边带空格的斜杠分段，「AC/DC」这类名字里紧挨着的斜杠不拆
  const seg = String(raw || "").split(/\s+\/\s*|\s*\/\s+/).map((s) => s.trim()).filter(Boolean);
  let year = "";
  const names = [];
  for (const s of seg) {
    if (DATE_RE.test(s)) { if (!year) year = s.slice(0, 4); }
    else if (!PRICE_RE.test(s) && !EDITION_RE.test(s)) names.push(s);
  }
  let author = "", trans = "", pub = "";
  if (names.length === 1) PUB_RE.test(names[0]) ? (pub = names[0]) : (author = names[0]);
  else if (names.length >= 2) { author = names[0]; pub = names.at(-1); trans = names.slice(1, -1).join(" / "); }
  let authors = author ? splitAuthors(author) : [];
  // 同一人写了外文名和中文名两遍时只留中文名
  if (authors.length === 2 && LATIN_RE.test(authors[0]) !== LATIN_RE.test(authors[1])) authors = authors.filter((a) => !LATIN_RE.test(a));
  return { a: authors, r: trans, p: pub ? cleanPub(pub) : "", y: year };
}

const SUBJECT = /\/subject\/(\d+)/;
const names = (prop) => (prop?.multi_select ?? []).map((o) => o.name);

// ===== 拆影视的「出品信息」：导演 / 主演 / 年份 / 地区，导演与主演各自用顿号分隔多人，哪一段都可能缺 =====
// 年份按样子认出来，它前面的两段依次是导演、主演，后面的是地区
const YEAR_RE = /^(18|19|20)\d{2}$/;
const people = (seg) => (seg ?? "").split(/\s*[、,，]\s*/).map((s) => s.trim()).filter(Boolean);
function parseMovie(raw) {
  const seg = String(raw || "").split(/\s+\/\s*|\s*\/\s+/).map((s) => s.trim()).filter(Boolean);
  const at = seg.findIndex((s) => YEAR_RE.test(s));
  const before = at < 0 ? seg : seg.slice(0, at);
  return { dr: people(before[0]), ac: people(before[1]), y: at < 0 ? "" : seg[at], rg: at < 0 ? "" : seg.slice(at + 1).join(" / ") };
}

// 两个库共有的列：豆瓣链接、短评、分类、专题、星标、取消日期；封面看仓库里对应目录有没有这个编号的图
function common(page, covers) {
  const props = page.properties;
  const u = props["豆瓣链接"]?.url ?? "";
  const v = u.match(SUBJECT)?.[1];
  return {
    id: page.id,
    v,
    u,
    s: text(props["短评"]?.rich_text).trim(),
    g: names(props["分类"]),
    z: names(props["专题"]),
    st: props["星标"]?.checkbox ? 1 : undefined,
    x: props["取消日期"]?.date ? 1 : undefined,
    d: props["取消日期"]?.date?.start,
    f: v && existsSync(join(covers, `${v}.jpg`)) ? 1 : undefined,
  };
}
const prune = (item) => {
  for (const [k, val] of Object.entries(item)) if (val === null || val === undefined || val === "" || (Array.isArray(val) && !val.length)) delete item[k];
  return item;
};

// 每个库：Notion 里的名字、写到哪个文件、封面在哪、怎么转成条目、量词；影视库可以是空的（刚建档还没有影片），读空照常写空文件
const KINDS = [
  {
    key: "books", label: "豆瓣读书", file: "public/data/douban/videos.json", unit: "本", allowEmpty: false,
    toItem: (page) => {
      const props = page.properties, base = common(page, join(ROOT, "public/covers/douban"));
      const { id, v, u, ...rest } = base;
      return prune({ id, n: text(props["书名"]?.title).trim(), v, u, ...parsePub(text(props["出版信息"]?.rich_text)), ...rest });
    },
  },
  {
    // 影视的短键名：n 片名，dr 导演（数组），ac 主演（数组），y 年份，rg 地区，其余同书；海报在 public/covers/douban-movie/<条目编号>.jpg
    key: "movies", label: "豆瓣影视", file: "public/data/douban/movies.json", unit: "部", allowEmpty: true,
    toItem: (page) => {
      const props = page.properties, base = common(page, join(ROOT, "public/covers/douban-movie"));
      const { id, v, u, ...rest } = base;
      return prune({ id, n: text(props["片名"]?.title).trim(), v, u, ...parseMovie(text(props["出品信息"]?.rich_text)), ...rest });
    },
  },
];

const shownOf = (items) => items.filter((it) => it.n && it.u);

// 按页面：改了的行里属于这个库的，读得到就换成新的、留在原位，删掉或移进回收站的从文件里去掉；
// 文件里还没有的行是上次全表重读之后才建的，比文件里的都新，放在最前
async function syncPages(kind, source, readAt) {
  // 去重：文件里还没有的行放进 added 数组，同一个 ID 写了两次（手动运行工作流时可能）会被加进文件两次
  const ids = [...new Set((process.env.SYNC_PAGES ?? "").split(",").map((s) => s.trim()).filter((s) => PAGE_ID.test(s)))];
  const out = join(ROOT, kind.file);
  if (!ids.length || !existsSync(out)) return false;
  const existing = JSON.parse(readFileSync(out, "utf8"));
  const known = new Set(existing.items.map((it) => it.id));
  const pages = await loadPages(ids, notion);
  const next = new Map(), added = [];
  let mine = 0;
  for (const id of ids) {
    const page = pages.get(id);
    if (page ? page.parent?.data_source_id !== source : !known.has(id)) continue;
    mine++;
    const item = !page || page.in_trash || page.archived ? null : kind.toItem(page);
    if (known.has(id)) next.set(id, item);
    else if (item) added.push(item);
  }
  if (!mine) return false;
  const items = shownOf([...added, ...existing.items.map((it) => next.has(it.id) ? next.get(it.id) : it).filter(Boolean)]);
  if (JSON.stringify(items) === JSON.stringify(existing.items)) {
    console.log(`按页面：「${kind.label}」读了 ${mine} 行，没有变化，不写文件`);
    return false;
  }
  writeFileSync(out, JSON.stringify({ updated: readAt, cats: existing.cats ?? {}, items }));
  console.log(`按页面：「${kind.label}」读了 ${mine} 行，${kind.file} 共 ${items.length} ${kind.unit}`);
  return true;
}

async function syncFull(kind, source, readAt) {
  const schema = await notion(`data_sources/${source}`);
  if (!schema) throw new Error(`读不到「${kind.label}」数据库，只读的 Notion 连接是否还能访问它`);
  const options = (name) => (schema.properties[name]?.multi_select?.options ?? []).map((o) => o.name);
  const items = [];
  let cursor;
  do {
    const batch = await notion(`data_sources/${source}/query`, {
      method: "POST",
      body: JSON.stringify({ page_size: 100, sorts: [{ timestamp: "created_time", direction: "descending" }], ...(cursor && { start_cursor: cursor }) }),
    });
    if (!batch) throw new Error(`读不到「${kind.label}」数据库，只读的 Notion 连接是否还能访问它`);
    items.push(...batch.results.map(kind.toItem));
    cursor = batch.has_more ? batch.next_cursor : undefined;
  } while (cursor);
  const shown = shownOf(items);
  // 读书库读空时不覆盖，防止权限或连接出问题时把现有数据清掉；按失败退出，网页上会显示同步失败
  if (!shown.length && !kind.allowEmpty) throw new Error(`「${kind.label}」没有读到任何条目，保留现有文件`);
  const out = join(ROOT, kind.file);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify({ updated: readAt, cats: { g: options("分类"), z: options("专题") }, items: shown }));
  console.log(`全量：${kind.file} 共 ${shown.length} ${kind.unit}，${shown.filter((it) => it.f).length} ${kind.unit}有封面，${shown.filter((it) => it.x).length} ${kind.unit}已取消`);
}

async function main() {
  const readAt = new Date().toISOString();
  const full = fullPlatforms(process.env).has("douban");
  let booksChanged = false;
  for (const kind of KINDS) {
    const source = DATABASES.douban?.[kind.key];
    if (!source) continue;
    if (full) await syncFull(kind, source, readAt);
    else if (await syncPages(kind, source, readAt) && kind.key === "books") booksChanged = true;
  }
  // 首页摘要只算书的本数
  if (full || booksChanged) writeSummary("douban");
}
await main();
