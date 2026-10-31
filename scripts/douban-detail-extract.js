// 从豆瓣条目页读出详情页要用的资料，在已登录的 Chrome 里打开 book.douban.com 后，粘进页面同源运行（存放位置与写出方法见 docs/notion-schema.md「豆瓣读书」「豆瓣影视」两节）。
// 只读 HTML 不点任何按钮；每本间隔 8 到 12 秒、每 50 本歇 2 分钟，遇到跳转登录或验证页立即停，避免豆瓣按异常请求封 IP
// （连读详情页太快会被跳到 sec.douban.com 验证页）。结果是 {豆瓣编号: 资料}，由 scripts/write-douban-details.mjs 写成 public/details/douban/<编号>.json
//
// 资料字段（短键名，缺的不写）：
//   sub 副标题  orig 原作名  nation 作者国别（作者栏方括号里的字）  series 丛书  date 出版年（豆瓣原样，如 1964-8）
//   pages 页数  binding 装帧  price 定价  isbn
//   rating 豆瓣评分  votes 评价人数  dist 五星到一星的百分比
//   intro 内容简介（段落以换行分隔）  toc 目录（一行一项）
async function doubanDetail(v) {
  const res = await fetch(`/subject/${v}/`, {credentials: "include"});
  if (res.redirected && !res.url.includes(`/subject/${v}`)) throw new Error(`跳转到了 ${res.url}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const html = await res.text();
  if (/sec\.douban\.com|登录跳转|有异常请求/.test(html) && !html.includes('id="info"')) throw new Error("被要求登录或验证");
  const doc = new DOMParser().parseFromString(html, "text/html");
  // 解析出来的文档没有排版，innerText 不认 <br>，先把换行标出来再取文字
  const text = (el) => { if (!el) return ""; const c = el.cloneNode(true); c.querySelectorAll("br").forEach((b) => b.replaceWith("\n")); return c.textContent; };
  const clean = (s) => s.replace(/[ \t ]+/g, " ").replace(/ *\n */g, "\n").replace(/\n{2,}/g, "\n").trim();
  const out = {};
  // 信息栏：「标签: 值」一行一项，作者、译者可能被 <a> 拆开，按换行重组
  const info = {};
  for (const line of clean(text(doc.querySelector("#info"))).split("\n")) {
    const m = line.match(/^([^:：]{1,6})[:：]\s*(.*)$/);
    if (m) info[m[1].trim()] = m[2].trim(); else if (Object.keys(info).length) { const k = Object.keys(info).at(-1); info[k] = `${info[k]} ${line}`.trim(); }
  }
  const sub = info["副标题"] || clean(text(doc.querySelector("#wrapper .subtitle, h1 + .subtitle")));
  if (sub) out.sub = sub;
  if (info["原作名"]) out.orig = info["原作名"];
  const nation = (info["作者"] ?? "").match(/^[\[［(（〔【]\s*([^\]］)）〕】]{1,8})\s*[\]］)）〕】]/);
  if (nation) out.nation = nation[1].trim();
  if (info["丛书"]) out.series = info["丛书"];
  if (info["出版年"]) out.date = info["出版年"];
  if (/^\d+/.test(info["页数"] ?? "")) out.pages = parseInt(info["页数"], 10);
  if (info["装帧"]) out.binding = info["装帧"];
  if (info["定价"]) out.price = info["定价"];
  if (info["ISBN"]) out.isbn = info["ISBN"];
  // 评分：人数太少时豆瓣不给分（「评价人数不足」），那就不写
  const rating = parseFloat(text(doc.querySelector(".rating_num")));
  const votes = parseInt(text(doc.querySelector(".rating_people span, .rating_people")), 10);
  if (rating > 0 && votes > 0) {
    out.rating = rating; out.votes = votes;
    const dist = [...doc.querySelectorAll(".rating_per")].map((e) => parseFloat(text(e)));
    if (dist.length === 5 && dist.every((p) => p >= 0)) out.dist = dist;
  }
  // 内容简介：在「内容简介」那一节里，有「展开全部」时完整版在 span.all 里；作者简介是另一节，不取
  const report = doc.querySelector("#link-report");
  const introEl = report?.querySelector("span.all .intro") ?? report?.querySelector(".intro");
  if (introEl) {
    const paras = [...introEl.querySelectorAll("p")].map((p) => clean(text(p))).filter(Boolean);
    const intro = paras.length ? paras.join("\n") : clean(text(introEl));
    if (intro) out.intro = intro;
  }
  // 目录：完整版在 #dir_<编号>_full，末尾是「· · · · · · (收起)」；没有完整版时取短版，去掉「(更多)」
  const dirEl = doc.querySelector(`#dir_${v}_full`) ?? doc.querySelector(`#dir_${v}_short`);
  if (dirEl) {
    const toc = clean(text(dirEl)).split("\n").map((s) => s.trim()).filter((s) => s && !/^[·\s.]*[(（]?(收起|更多)[)）]?$/.test(s) && !/^[·\s]+$/.test(s));
    if (toc.length) out.toc = toc;
  }
  return out;
}

// 依次读一批编号；出错立即停，返回已读到的部分和停在哪一本
async function doubanDetails(ids, {min = 8000, max = 12000, restEvery = 50, rest = 120000} = {}) {
  const got = {};
  for (let i = 0; i < ids.length; i++) {
    try { got[ids[i]] = await doubanDetail(ids[i]); } catch (err) { return {got, stoppedAt: ids[i], error: err.message}; }
    if (i < ids.length - 1) await new Promise((r) => setTimeout(r, (i + 1) % restEvery ? min + Math.random() * (max - min) : rest));
  }
  return {got};
}
