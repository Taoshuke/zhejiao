// 从豆瓣电影条目页读出影片详情页要用的资料，在已登录的 Chrome 里打开 movie.douban.com 后，粘进页面同源运行（存放位置与写出方法见 docs/notion-schema.md「豆瓣读书」「豆瓣影视」两节）。
// 做法与节奏同 douban-detail-extract.js（书）：只读 HTML 不点任何按钮，每部间隔 8 到 12 秒，遇到跳转登录或验证页立即停。
// 结果是 {豆瓣编号: 资料}，由 `node scripts/write-douban-details.mjs --movie <资料.json>` 写成 public/details/douban-movie/<编号>.json；
// 片名、导演、主演、年份、地区另要填进 Notion「豆瓣影视」的「片名」「出品信息」两列（出品信息写成「导演 / 主演 / 年份 / 地区」，
// 多人用顿号分隔），海报按 poster 网址下载成 public/covers/douban-movie/<编号>.jpg。
//
// 资料字段（短键名，缺的不写）：
//   title 中文片名  orig 原名  y 年份  dr 导演  wr 编剧  ac 主演（数组，最多取前 8 位）  genre 类型（数组）
//   region 制片国家/地区  lang 语言  date 上映日期  dur 片长  alias 又名  imdb
//   rating 豆瓣评分  votes 评价人数  dist 五星到一星的百分比  intro 剧情简介（段落以换行分隔）  poster 海报网址
async function doubanMovie(v) {
  // 标签页正开着这部影片时直接读当前页面：从首页同源请求条目页可能失败（Failed to fetch），打开条目页本身可以读
  const doc = location.pathname === `/subject/${v}/` ? document : await fetchSubject(v);
  // 解析出来的文档没有排版，innerText 不认 <br>，先把换行标出来再取文字
  const text = (el) => { if (!el) return ""; const c = el.cloneNode(true); c.querySelectorAll("br").forEach((b) => b.replaceWith("\n")); return c.textContent; };
  const clean = (s) => s.replace(/[ \t ]+/g, " ").replace(/ *\n */g, "\n").replace(/\n{2,}/g, "\n").trim();
  // 人名有时是「蔡明亮 Ming-liang Tsai」，有中文名时只留中文名
  const list = (s) => (s ?? "").split(/\s*\/\s*/).map((x) => x.trim().replace(/^(.*[一-鿿].*?)\s+[A-Za-z][A-Za-z .'-]*$/, "$1")).filter(Boolean);
  const out = {};
  // 信息栏：「标签: 值」一行一项；「制片国家/地区」标签本身带斜杠，标签长度放宽到 8
  const info = {};
  for (const line of clean(text(doc.querySelector("#info"))).split("\n")) {
    const m = line.match(/^([^:：]{1,8})[:：]\s*(.*)$/);
    if (m) info[m[1].trim()] = m[2].trim(); else if (Object.keys(info).length) { const k = Object.keys(info).at(-1); info[k] = `${info[k]} ${line}`.trim(); }
  }
  // 标题栏是「中文片名 原名」连写，中文片名取网页标题里「 (豆瓣)」前面那段，剩下的是原名
  const title = (doc.title ?? "").replace(/\s*\(豆瓣\)\s*$/, "").trim();
  const full = clean(text(doc.querySelector('[property="v:itemreviewed"]')));
  if (title) out.title = title;
  if (full && title && full.startsWith(title) && full.length > title.length) out.orig = full.slice(title.length).trim();
  const year = text(doc.querySelector("h1 .year")).match(/\d{4}/);
  if (year) out.y = year[0];
  if (info["导演"]) out.dr = list(info["导演"]);
  if (info["编剧"]) out.wr = list(info["编剧"]);
  if (info["主演"]) out.ac = list(info["主演"]).slice(0, 8);
  if (info["类型"]) out.genre = list(info["类型"]);
  if (info["制片国家/地区"]) out.region = info["制片国家/地区"];
  if (info["语言"]) out.lang = info["语言"];
  if (info["上映日期"] || info["首播"]) out.date = info["上映日期"] || info["首播"];
  // 剧集没有片长，写成「共几集，每集多久」
  if (info["片长"]) out.dur = info["片长"];
  else if (info["集数"]) out.dur = `共${info["集数"]}集${info["单集片长"] ? `，每集${info["单集片长"]}` : ""}`;
  if (info["又名"]) out.alias = info["又名"];
  if (info["IMDb"]) out.imdb = info["IMDb"];
  // 评分：人数太少时豆瓣不给分，那就不写
  const rating = parseFloat(text(doc.querySelector(".rating_num")));
  const votes = parseInt(text(doc.querySelector('[property="v:votes"], .rating_people span')), 10);
  if (rating > 0 && votes > 0) {
    out.rating = rating; out.votes = votes;
    const dist = [...doc.querySelectorAll(".ratings-on-weight .rating_per")].map((e) => parseFloat(text(e)));
    if (dist.length === 5 && dist.every((p) => p >= 0)) out.dist = dist;
  }
  // 剧情简介：有「展开全部」时完整版在 span.all 里
  const introEl = doc.querySelector("#link-report-intra span.all") ?? doc.querySelector('[property="v:summary"]');
  const intro = clean(text(introEl)).split("\n").map((s) => s.trim()).filter(Boolean).join("\n");
  if (intro) out.intro = intro;
  // 海报：条目页给的是缩略图，换成大图的路径
  const poster = doc.querySelector("#mainpic img")?.getAttribute("src");
  if (poster) out.poster = poster.replace(/\/s_ratio_poster\//, "/l_ratio_poster/");
  return out;
}

async function fetchSubject(v) {
  const res = await fetch(`/subject/${v}/`, {credentials: "include"});
  if (res.redirected && !res.url.includes(`/subject/${v}`)) throw new Error(`跳转到了 ${res.url}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const html = await res.text();
  if (/sec\.douban\.com|登录跳转|有异常请求/.test(html) && !html.includes('id="info"')) throw new Error("被要求登录或验证");
  return new DOMParser().parseFromString(html, "text/html");
}

// 依次读一批编号；出错立即停，返回已读到的部分和停在哪一部
async function doubanMovies(ids, {min = 8000, max = 12000} = {}) {
  const got = {};
  for (let i = 0; i < ids.length; i++) {
    try { got[ids[i]] = await doubanMovie(ids[i]); } catch (err) { return {got, stoppedAt: ids[i], error: err.message}; }
    if (i < ids.length - 1) await new Promise((r) => setTimeout(r, min + Math.random() * (max - min)));
  }
  return {got};
}
