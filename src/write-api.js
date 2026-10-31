/**
 * 网页上的写入操作：星标、改分类、标记取关与恢复关注、分类排序，以及「从 Notion 同步」；
 * 视频页（抖音、X、小红书各自的收藏、喜欢库）的改分类、标记取消与恢复，星标，改文字，以及收藏和喜欢互加；
 * 微信页改文章的公众号（「公众号」库的「公众号」列，单篇改或整个号改名）、标题（「标题」列，名称跟着标题）与删除文章（移进 Notion 回收站），
 * 另有改分类（「分类」单选，内容视图用）；
 * 豆瓣书架的星标与标记取消、恢复（「豆瓣读书」库的「星标」「取消日期」两列）。
 *
 * 整个网站由 Cloudflare Access 挡在前面，这里再核验一次 Access 签发的登录凭证，
 * 这样即使 Access 某天配错放开了路径，没登录的请求也写不进去。配置为空时一律拒绝。
 *
 * 需要的配置：ACCESS_TEAM_DOMAIN（如 xxx.cloudflareaccess.com）、ACCESS_AUD（应用的 AUD 标签）、
 * ACCESS_EMAIL（允许写入的邮箱）、HOST（网站域名，只接受本站页面发来的写入）；密钥 NOTION_WRITE_TOKEN（有写入权限的 Notion 连接；改已有的行，
 * 收藏和喜欢互加时在目标库新建一行，微信删除文章时把那一行移进 Notion 回收站）。
 * 写进 Notion 后交给 SyncDebouncer：网页改的几行按页面同步进数据文件，Notion 里的其他改动等手动同步。
 */
import { DATABASES } from "./platforms.mjs";
import { subcategoriesOf } from "./subcategories.mjs";

// 网页上改分类、子分类时勾上「人工」：这一行是人工定的，本机批量脚本（tools/notion_write.py）一律跳过不改
const MANUAL = "人工";

// 各平台的数据库见 src/platforms.mjs。博主的行按页面 ID 认，属于任何一个平台的博主库都行；
// 内容页、分类排序的请求由网页带上平台（platform），只改那个平台的库
const CREATOR_SOURCES = new Set(Object.values(DATABASES).map((db) => db.creators).filter(Boolean));
// 视频库：K 收藏、L 喜欢；三个平台都用「添加顺序」记加入先后，X 与小红书另有「添加时间」（恢复取消时写），抖音没有这一列
const LIB_KEY = { K: "collect", L: "like" };
const TIME = "添加时间";
const videoSource = (platform, lib) => (LIB_KEY[lib] && DATABASES[platform]?.[LIB_KEY[lib]]) || null;
const STARRED = "星标";
const NOTION_VERSION = "2025-09-03";
const PAGE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const fail = (status, error) => Response.json({ error }, { status });

const b64url = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
const decodeJson = (s) => JSON.parse(new TextDecoder().decode(b64url(s)));

// Access 的公钥会轮换；同一个 Worker 实例里缓存一小时，遇到不认识的 kid 再重新拉
let jwks = { at: 0, keys: [] };
async function signingKey(team, kid) {
  if (Date.now() - jwks.at > 3600e3 || !jwks.keys.some((k) => k.kid === kid)) {
    const res = await fetch(`https://${team}/cdn-cgi/access/certs`);
    if (!res.ok) throw new Error(`certs ${res.status}`);
    jwks = { at: Date.now(), keys: (await res.json()).keys ?? [] };
  }
  const jwk = jwks.keys.find((k) => k.kid === kid);
  if (!jwk) throw new Error("unknown key id");
  return crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
}

// 返回登录邮箱；凭证缺失、签名不对、过期、受众或签发方不符时返回 null
export async function verifyAccess(request, env) {
  const team = env.ACCESS_TEAM_DOMAIN?.trim();
  const aud = env.ACCESS_AUD?.trim();
  if (!team || !aud) return null;
  const token = request.headers.get("cf-access-jwt-assertion");
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const header = decodeJson(parts[0]);
  if (header.alg !== "RS256") return null;
  const key = await signingKey(team, header.kid);
  const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64url(parts[2]), new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
  if (!ok) return null;
  const claims = decodeJson(parts[1]);
  const auds = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!auds.includes(aud)) return null;
  if (claims.iss !== `https://${team}`) return null;
  if (!(claims.exp > Date.now() / 1000)) return null;
  return claims.email ?? null;
}

// 登录凭证有效且是允许的邮箱时返回 true
export async function signedIn(request, env) {
  let email = null;
  try {
    email = await verifyAccess(request, env);
  } catch (err) {
    // 凭证格式坏了或公钥拉取失败，都按未登录处理，原因留在日志里
    console.warn(`access verify failed: ${err.message}`);
  }
  const allowed = env.ACCESS_EMAIL?.trim().toLowerCase();
  return Boolean(email && allowed && email.toLowerCase() === allowed);
}

async function notion(env, path, init = {}) {
  const res = await fetch(`https://api.notion.com/v1/${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${env.NOTION_WRITE_TOKEN?.trim()}`,
      "Notion-Version": NOTION_VERSION,
      "Content-Type": "application/json",
    },
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`Notion ${res.status} ${body.code ?? ""}`.trim());
  return body;
}

// 写入连接能碰到整个「折角」页面，先确认这一行确实属于某个平台的博主库
async function followsRow(env, id) {
  if (!PAGE_ID.test(id ?? "")) return null;
  const page = await notion(env, `pages/${id}`);
  return CREATOR_SOURCES.has(page.parent?.data_source_id) ? page : null;
}

// 网页上的改动写进 Notion 后，交给合并器只同步这几行进 数据文件；Notion 里别的改动等手动同步
const syncLater = (env, job) => env.SYNC.get(env.SYNC.idFromName("sync")).request(job);

async function updateRow(env, id, properties) {
  if (!(await followsRow(env, id))) return fail(404, "not a follows row");
  await notion(env, `pages/${id}`, { method: "PATCH", body: JSON.stringify({ properties }) });
  await syncLater(env, { pages: [id] });
  return Response.json({ ok: true });
}

async function star(env, { id, on }) {
  if (typeof on !== "boolean") return fail(400, "bad request");
  return updateRow(env, id, { "特别关注": { checkbox: on } });
}

// 只能改成已有的分类；网页上的分类名单比 Notion 旧时（Notion 里改名或删了分类）拒绝，提示先同步
async function category(env, { id, category: name }) {
  if (typeof name !== "string" || !name) return fail(400, "bad request");
  const row = await followsRow(env, id);
  if (!row) return fail(404, "not a follows row");
  const schema = await notion(env, `data_sources/${row.parent.data_source_id}`);
  const options = schema.properties["分类"]?.select?.options ?? [];
  if (!options.some((o) => o.name === name)) return fail(409, "categories changed, sync from Notion first");
  // 原来的子分类不属于新分类时一起清掉，免得子分类挂在别的分类下面
  const sub = row.properties["子分类"]?.select?.name;
  const properties = { "分类": { select: { name } }, [MANUAL]: { checkbox: true } };
  if (sub && !subcategoriesOf(platformOf(row), name).includes(sub)) properties["子分类"] = { select: null };
  return updateRow(env, id, properties);
}

// 博主行属于哪个平台，按它所在的数据库认
const platformOf = (row) => Object.keys(DATABASES).find((k) => DATABASES[k].creators === row.parent?.data_source_id);

// 改子分类：只能填这一行当前分类下的子分类（见 src/subcategories.mjs），空字符串是清掉
async function subcategory(env, { id, subcategory: name }) {
  if (typeof name !== "string") return fail(400, "bad request");
  const row = await followsRow(env, id);
  if (!row) return fail(404, "not a follows row");
  const cat = row.properties["分类"]?.select?.name;
  if (name && !subcategoriesOf(platformOf(row), cat).includes(name)) return fail(409, "subcategory not under this category, sync from Notion first");
  return updateRow(env, id, { "子分类": { select: name ? { name } : null }, [MANUAL]: { checkbox: true } });
}

// 标记取关：勾「已取关」，取关日期填此刻。恢复关注：取消「已取关」、清空取关日期，关注日期填此刻，
// 账号会出现在「近期关注」里。时刻由网页传本地时间带时区，近期取关、近期关注按它排序；
// 还开着的旧页面只传日期，也收下。只接受与服务器时间相差两天以内的，防止传错
const DATE = /^\d{4}-\d{2}-\d{2}$/, DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/;
async function unfollow(env, { id, on, date }) {
  if (typeof on !== "boolean") return fail(400, "bad request");
  if (!(DATE.test(date ?? "") || DATE_TIME.test(date ?? "")) || Math.abs(Date.parse(date) - Date.now()) > 2 * 864e5) return fail(400, "bad date");
  if (on) return updateRow(env, id, { "已取关": { checkbox: true }, "取关日期": { date: { start: date } } });
  return updateRow(env, id, { "已取关": { checkbox: false }, "取关日期": { date: null }, "关注日期": { date: { start: date } } });
}

async function order(env, { platform, order }) {
  const source = DATABASES[platform]?.creators;
  if (!source || !Array.isArray(order) || !order.every((x) => typeof x === "string")) return fail(400, "bad request");
  const schema = await notion(env, `data_sources/${source}`);
  const options = schema.properties["分类"]?.select?.options ?? [];
  // 只允许调整先后，不能借此增删或改名分类
  const byName = new Map(options.map((o) => [o.name, o]));
  if (order.length !== options.length || new Set(order).size !== order.length || !order.every((n) => byName.has(n))) {
    return fail(409, "categories changed, reload");
  }
  const reordered = order.map((n) => ({ id: byName.get(n).id, name: n, color: byName.get(n).color }));
  await notion(env, `data_sources/${source}`, { method: "PATCH", body: JSON.stringify({ properties: { "分类": { select: { options: reordered } } } }) });
  await syncLater(env, { order: true });
  return Response.json({ ok: true });
}

// 「从 Notion 同步」：不写 Notion，只启动一次同步，把当前平台的几个库全表重读、写进它的数据文件（一次只同步一个平台）。
// 返回点下的时间，网页拿它查这次同步的进度（GET /api/sync-status?since=）
async function syncAll(env, { platform }) {
  if (!DATABASES[platform]) return fail(400, "bad request");
  const at = new Date().toISOString();
  await syncLater(env, { full: [platform] });
  return Response.json({ ok: true, at });
}

// ===== 视频库：两个库各自独立，网页传平台、lib（K 或 L）和那一边的页面 ID =====
async function videoRow(env, platform, lib, id) {
  const source = videoSource(platform, lib);
  if (!source || !PAGE_ID.test(id ?? "")) return null;
  const page = await notion(env, `pages/${id}`);
  return page.parent?.data_source_id === source ? page : null;
}
async function updateVideo(env, platform, lib, id, properties) {
  if (!(await videoRow(env, platform, lib, id))) return fail(404, "not a video row");
  await notion(env, `pages/${id}`, { method: "PATCH", body: JSON.stringify({ properties }) });
  await syncLater(env, { pages: [id] });
  return Response.json({ ok: true });
}
// 只能改成这个库已有的分类，两个库的分类各自独立
async function videoCategory(env, { platform, lib, id, category: name }) {
  const source = videoSource(platform, lib);
  if (typeof name !== "string" || !name || !source) return fail(400, "bad request");
  const schema = await notion(env, `data_sources/${source}`);
  const options = schema.properties["分类"]?.select?.options ?? [];
  if (!options.some((o) => o.name === name)) return fail(409, "categories changed, sync from Notion first");
  return updateVideo(env, platform, lib, id, { "分类": { select: { name } }, [MANUAL]: { checkbox: true } });
}
// 标记取消：取消日期填此刻（填了就算取消，库里没有单独的勾选框）。恢复：清空取消日期；X 与小红书另把添加时间填此刻，出现在「近期新增」，
// 抖音的两个库没有添加时间、用「添加顺序」记加入先后，恢复时不动它
// 时刻由网页传本地时间带时区，只接受与服务器时间相差两天以内的
async function videoCancel(env, { platform, lib, id, on, date }) {
  if (typeof on !== "boolean" || !videoSource(platform, lib)) return fail(400, "bad request");
  if (!DATE_TIME.test(date ?? "") || Math.abs(Date.parse(date) - Date.now()) > 2 * 864e5) return fail(400, "bad date");
  if (on) return updateVideo(env, platform, lib, id, { "取消日期": { date: { start: date } } });
  return updateVideo(env, platform, lib, id, platform === "douyin" ? { "取消日期": { date: null } } : { "取消日期": { date: null }, [TIME]: { date: { start: date } } });
}

// ===== 改标题和正文（抖音、X、小红书都能改，标题写「名称」列，正文写哪一列见下面的 textColumn） =====
const TEXT_PLATFORMS = new Set(["douyin", "x", "rednote"]);
// 抖音视频库的文字列叫「文案」，X 与小红书叫「正文」
const textColumn = (platform) => platform === "douyin" ? "文案" : "正文";
const plain = (rich) => (rich ?? []).map((t) => t.plain_text).join("");
// Notion 每段文字最多 2000 字，最多 100 段
const richOf = (s) => { const out = []; for (let i = 0; i < s.length && out.length < 100; i += 2000) out.push({ type: "text", text: { content: s.slice(i, i + 2000) } }); return out; };
// 打开编辑框时读这一行现在的标题和正文；数据文件里的文字截到 300 字，不能拿来改
async function videoTextGet(env, { platform, lib, id }) {
  if (!TEXT_PLATFORMS.has(platform)) return fail(400, "bad request");
  const page = await videoRow(env, platform, lib, id);
  if (!page) return fail(404, "not a video row");
  return Response.json({ title: plain(page.properties["名称"]?.title), body: plain(page.properties[textColumn(platform)]?.rich_text) });
}
// 同一条在收藏（书签）和点赞（喜欢）两边各有一行时，两行一起改，否则同步时会被另一行的旧文字盖掉
async function videoText(env, { platform, rows, title, body }) {
  title = typeof title === "string" ? title.replace(/\s+/g, " ").trim() : "";
  body = typeof body === "string" ? body.replace(/\r\n/g, "\n").trim() : "";
  if (!TEXT_PLATFORMS.has(platform) || !Array.isArray(rows) || !rows.length || rows.length > 2 || !title || title.length > 300 || body.length > 20000) return fail(400, "bad request");
  for (const { lib, id } of rows) if (!(await videoRow(env, platform, lib, id))) return fail(404, "not a video row");
  const properties = { "名称": { title: richOf(title) }, [textColumn(platform)]: { rich_text: richOf(body) } };
  for (const { id } of rows) await notion(env, `pages/${id}`, { method: "PATCH", body: JSON.stringify({ properties }) });
  await syncLater(env, { pages: rows.map((r) => r.id) });
  return Response.json({ ok: true });
}

// ===== 收藏和喜欢互加（抖音、X、小红书）：网页传视频 ID（v）、复制来源那一行所在的库（from）和页面 ID（id） =====
// 卡片底栏的收藏、喜欢按钮在目标库已有这一条时，网页直接用 /video/cancel 标取消或恢复；这里只管「目标库还没有」的情形：
// 从来源行复制新建，目标库里有的列照抄（含分类、星标），取消日期、添加顺序、添加时间不抄；
// 添加顺序写当天批次（网页传来的本地日期）、编号接着目标库现有的最大号。万一目标库其实已有这一条（快照还没同步到），就清掉它的取消日期
const ADD_ORDER = "添加顺序";
const LINK_COL = { douyin: "视频链接", x: "帖子链接", rednote: "笔记链接" };
const ITEM_ID = { douyin: /\/(?:video|note)\/(\d+)/, x: /\/status\/(\d+)/, rednote: /\/explore\/([0-9a-f]{24})/ };
const NO_COPY = new Set(["取消日期", ADD_ORDER, "添加时间"]);
async function videoOther(env, { platform, v, from, id, date }) {
  const to = from === "K" ? "L" : from === "L" ? "K" : null;
  const source = LINK_COL[platform] && to ? videoSource(platform, to) : null;
  if (!source || !/^[0-9a-z]+$/i.test(v ?? "")) return fail(400, "bad request");
  if (!DATE_TIME.test(date ?? "") || Math.abs(Date.parse(date) - Date.now()) > 2 * 864e5) return fail(400, "bad date");
  const page = await videoRow(env, platform, from, id);
  if (!page) return fail(404, "not a video row");
  const url = page.properties[LINK_COL[platform]]?.url;
  if (!url || url.match(ITEM_ID[platform])?.[1] !== v) return fail(400, "bad request");
  const text = (p) => (p?.rich_text ?? []).map((t) => t.plain_text).join("");
  const query = (body) => notion(env, `data_sources/${source}/query`, { method: "POST", body: JSON.stringify(body) });
  const found = (await query({ filter: { property: LINK_COL[platform], url: { equals: url } }, page_size: 1 })).results[0];
  if (found) {
    await notion(env, `pages/${found.id}`, { method: "PATCH", body: JSON.stringify({ properties: { "取消日期": { date: null } } }) });
    await syncLater(env, { pages: [found.id] });
    return Response.json({ ok: true, id: found.id, c: found.properties["分类"]?.select?.name ?? null, q: text(found.properties[ADD_ORDER]) });
  }
  // 「批次 · 编号」越晚越大，按文字从大到小排第一行就是最大号
  const last = (await query({ filter: { property: ADD_ORDER, rich_text: { is_not_empty: true } }, sorts: [{ property: ADD_ORDER, direction: "descending" }], page_size: 1 })).results[0];
  const n = Number(text(last?.properties[ADD_ORDER]).match(/(\d+)$/)?.[1] ?? 0) + 1;
  const q = `${date.slice(0, 10)} · ${String(n).padStart(4, "0")}`;
  const target = (await notion(env, `data_sources/${source}`)).properties;
  const properties = Object.fromEntries(Object.entries(page.properties)
    .filter(([k, prop]) => target[k] && target[k].type === prop.type && !NO_COPY.has(k))
    .map(([k, prop]) => [k, writable(prop)]).filter(([, w]) => w));
  properties[ADD_ORDER] = { rich_text: [{ text: { content: q } }] };
  const made = await notion(env, "pages", { method: "POST", body: JSON.stringify({ parent: { type: "data_source_id", data_source_id: source }, properties }) });
  await syncLater(env, { pages: [made.id] });
  return Response.json({ ok: true, id: made.id, c: page.properties["分类"]?.select?.name ?? null, q });
}

// 读出来的属性值换成写入用的格式
function writable(prop) {
  const rich = (list) => list.map((t) => ({ type: "text", text: { content: t.plain_text } }));
  switch (prop.type) {
    case "title": return { title: rich(prop.title) };
    case "rich_text": return { rich_text: rich(prop.rich_text) };
    case "url": return { url: prop.url };
    case "number": return { number: prop.number };
    case "date": return { date: prop.date ? { start: prop.date.start } : null };
    case "select": return { select: prop.select ? { name: prop.select.name } : null };
    case "checkbox": return { checkbox: prop.checkbox };
    default: return null;
  }
}
// 星标：勾这条在各个库里那几行的「星标」列，三个平台一样
async function videoStar(env, { rows, platform, on }) {
  if (typeof on !== "boolean" || !Array.isArray(rows) || !rows.length || rows.length > 2) return fail(400, "bad request");
  for (const r of rows) if (!(await videoRow(env, platform, r.lib, r.id))) return fail(404, "not a video row");
  for (const r of rows) await notion(env, `pages/${r.id}`, { method: "PATCH", body: JSON.stringify({ properties: { [STARRED]: { checkbox: on } } }) });
  await syncLater(env, { pages: rows.map((r) => r.id) });
  return Response.json({ ok: true });
}
// ===== 微信：改文章的公众号。网页传页面 ID 列表和新名字：单篇改是一篇，整个号改名是这个号的全部文章，网页分批发 =====
// 每批上限：每行先读一次确认属于「公众号」库、再写一次，免费版每个请求最多 50 次子请求
const MAX_ACCOUNT_ROWS = 20;
async function wechatAccount(env, { ids, name }) {
  const source = DATABASES.wechat?.articles;
  name = typeof name === "string" ? name.trim() : "";
  if (!source || !name || name.length > 60 || !Array.isArray(ids) || !ids.length || ids.length > MAX_ACCOUNT_ROWS || !ids.every((id) => PAGE_ID.test(id ?? ""))) {
    return fail(400, "bad request");
  }
  // 写入连接能碰到整个「折角」页面，全部确认是「公众号」库的行之后再写
  for (const id of ids) {
    const page = await notion(env, `pages/${id}`);
    if (page.parent?.data_source_id !== source) return fail(404, "not an article row");
  }
  const written = [];
  try {
    for (const id of ids) {
      // 改过的就是确认过的，去掉「公众号待核」
      const properties = { "公众号": { rich_text: [{ type: "text", text: { content: name } }] }, "公众号待核": { checkbox: false } };
      await notion(env, `pages/${id}`, { method: "PATCH", body: JSON.stringify({ properties }) });
      written.push(id);
    }
  } finally {
    // 中途失败时，已经写进 Notion 的那几行也同步进数据文件
    if (written.length) await syncLater(env, { pages: written });
  }
  return Response.json({ ok: true });
}

// 改一篇的标题：写「标题」，「名称」跟着标题（卡片只留标题，不显示正文）
async function wechatTitle(env, { id, title }) {
  const source = DATABASES.wechat?.articles;
  title = typeof title === "string" ? title.replace(/\s+/g, " ").trim() : "";
  if (!source || !PAGE_ID.test(id ?? "") || !title || title.length > 200) return fail(400, "bad request");
  const page = await notion(env, `pages/${id}`);
  if (page.parent?.data_source_id !== source) return fail(404, "not an article row");
  const rich = [{ type: "text", text: { content: title } }];
  await notion(env, `pages/${id}`, { method: "PATCH", body: JSON.stringify({ properties: { "标题": { rich_text: rich }, "名称": { title: rich } } }) });
  await syncLater(env, { pages: [id] });
  return Response.json({ ok: true });
}

// 改一篇的分类（内容视图用）：只能改成「分类」单选已有的选项
async function wechatCategory(env, { id, category: name }) {
  const source = DATABASES.wechat?.articles;
  if (!source || !PAGE_ID.test(id ?? "") || typeof name !== "string" || !name) return fail(400, "bad request");
  const schema = await notion(env, `data_sources/${source}`);
  if (!(schema.properties["分类"]?.select?.options ?? []).some((o) => o.name === name)) return fail(409, "categories changed, sync from Notion first");
  const page = await notion(env, `pages/${id}`);
  if (page.parent?.data_source_id !== source) return fail(404, "not an article row");
  await notion(env, `pages/${id}`, { method: "PATCH", body: JSON.stringify({ properties: { "分类": { select: { name } }, [MANUAL]: { checkbox: true } } }) });
  await syncLater(env, { pages: [id] });
  return Response.json({ ok: true });
}

// 删除一篇：先确认是「公众号」库的行，再移进 Notion 回收站，30 天内可在 Notion 里恢复
async function wechatDelete(env, { id }) {
  const source = DATABASES.wechat?.articles;
  if (!source || !PAGE_ID.test(id ?? "")) return fail(400, "bad request");
  const page = await notion(env, `pages/${id}`);
  if (page.parent?.data_source_id !== source) return fail(404, "not an article row");
  await notion(env, `pages/${id}`, { method: "PATCH", body: JSON.stringify({ in_trash: true }) });
  await syncLater(env, { pages: [id] });
  return Response.json({ ok: true });
}

// ===== 豆瓣：一本书是「豆瓣读书」库的一行，一部影片是「豆瓣影视」库的一行，网页传页面 ID =====
// 两个库的星标、短评、取消日期三列同名，共用这几个接口。
// 写入连接能碰到整个「折角」页面，先确认这一行属于这两个库之一再写
async function updateBook(env, id, properties) {
  const sources = [DATABASES.douban?.books, DATABASES.douban?.movies].filter(Boolean);
  if (!sources.length || !PAGE_ID.test(id ?? "")) return fail(400, "bad request");
  const page = await notion(env, `pages/${id}`);
  if (!sources.includes(page.parent?.data_source_id)) return fail(404, "not a douban row");
  await notion(env, `pages/${id}`, { method: "PATCH", body: JSON.stringify({ properties }) });
  await syncLater(env, { pages: [id] });
  return Response.json({ ok: true });
}
async function bookStar(env, { id, on }) {
  if (typeof on !== "boolean") return fail(400, "bad request");
  return updateBook(env, id, { [STARRED]: { checkbox: on } });
}
// 标记取消：取消日期填此刻（填了就算取消，同内容页的库）；恢复：清空取消日期。近期新增按 Notion 行的创建时间排，恢复时不写别的列。
// 时刻由网页传本地时间带时区，近期取消按它排序，只接受与服务器时间相差两天以内的；恢复不用时刻
async function bookCancel(env, { id, on, date }) {
  if (typeof on !== "boolean") return fail(400, "bad request");
  if (!on) return updateBook(env, id, { "取消日期": { date: null } });
  if (!DATE_TIME.test(date ?? "") || Math.abs(Date.parse(date) - Date.now()) > 2 * 864e5) return fail(400, "bad date");
  return updateBook(env, id, { "取消日期": { date: { start: date } } });
}

// 短评：写、改、删都走这里，写空即删；与豆瓣短评同限 350 字，按字符数算
async function bookNote(env, { id, text }) {
  if (typeof text !== "string") return fail(400, "bad request");
  text = text.replace(/\r\n/g, "\n").trim();
  if ([...text].length > 350) return fail(400, "note too long");
  return updateBook(env, id, { "短评": { rich_text: text ? richOf(text) : [] } });
}

const ROUTES = {
  "/api/douban/star": bookStar,
  "/api/douban/note": bookNote,
  "/api/douban/cancel": bookCancel,
  "/api/wechat/account": wechatAccount,
  "/api/wechat/delete": wechatDelete,
  "/api/wechat/title": wechatTitle,
  "/api/wechat/category": wechatCategory,
  "/api/video/category": videoCategory,
  "/api/video/cancel": videoCancel,
  "/api/video/text": videoText,
  "/api/video/text/get": videoTextGet,
  "/api/video/star": videoStar,
  "/api/video/other": videoOther,
  "/api/star": star,
  "/api/category": category,
  "/api/subcategory": subcategory,
  "/api/unfollow": unfollow,
  "/api/order": order,
  "/api/sync": syncAll,
};

export async function handleWrite(request, env, pathname) {
  const route = ROUTES[pathname];
  if (!route) return fail(404, "not found");
  if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405, headers: { Allow: "POST" } });
  // 只接受本站页面发来的 JSON：跨站表单发不出 JSON，Origin 也对不上
  const origin = env.HOST?.trim() ? `https://${env.HOST.trim()}` : new URL(request.url).origin;
  if (request.headers.get("origin") !== origin || !(request.headers.get("content-type") ?? "").includes("application/json")) {
    return fail(403, "forbidden");
  }
  if (!(await signedIn(request, env))) return fail(401, "not signed in");
  let body;
  try {
    body = await request.json();
  } catch {
    return fail(400, "invalid json");
  }
  try {
    return await route(env, body);
  } catch (err) {
    console.error(`write ${pathname} failed: ${err.message}`);
    return fail(502, err.message);
  }
}
