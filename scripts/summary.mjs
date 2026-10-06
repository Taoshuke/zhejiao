/**
 * 首页用的摘要 public/data/<平台>/summary.json：各平台的数量和最近几条，几 KB，首页只读它，不读几 MB 的数据文件。
 * 由三个同步脚本在写完数据文件后调用，按这个平台现有的数据文件重算；也可以直接运行 node scripts/summary.mjs [平台…]，不写平台就是全部。
 * 抖音与 X（k 是书签）：f 关注中的博主数，k、l 收藏、喜欢里没取消的条数，recent 最近关注的博主与最近收藏的视频；
 * 微信：k 文章数，a 公众号数，recent 最近收藏的文章。recent 里每条：type（follow、collect、article），t 标题或名字，a 作者、公众号或头像，j 时间，u 链接，p 网页里的去处。
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const read = (slug, file) => {
  const path = join(ROOT, `public/data/${slug}/${file}.json`);
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null;
};
const time = (s) => Date.parse(s ?? "") || 0;
// 视频文案去掉话题标签
const caption = (t) => (t ?? "").replace(/#[^\s#]+/g, "").replace(/\s+/g, " ").trim() || t || "";

// 抖音与 X 的数据结构相同（博主、收藏或书签、喜欢），共用一个
function creatorsAndVideos(slug) {
  const creators = read(slug, "creators"), videos = read(slug, "videos");
  if (!creators && !videos) return null;
  const live = (creators?.items ?? []).filter((c) => !c.x);
  const follows = [...live].sort((a, b) => time(b.j) - time(a.j) || (b.o ?? 0) - (a.o ?? 0)).slice(0, 6)
    .map((c) => ({ type: "follow", t: c.n, a: c.a, j: c.j, u: c.u, p: `/${slug}` }));
  const items = videos?.items ?? [];
  // 收藏的「添加时间」导入时可能是空的（抖音导出里没有收藏的时刻），没有时间的不算「最近」
  const collects = items.filter((v) => v.K && !v.K.x && v.K.j).sort((a, b) => time(b.K.j) - time(a.K.j)).slice(0, 6)
    .map((v) => ({ type: "collect", t: caption(v.t).slice(0, 80), a: v.a, j: v.K.j, u: v.u, p: `/${slug}/collect` }));
  return {
    updated: [creators?.updated, videos?.updated].filter(Boolean).sort().at(-1) ?? null,
    f: live.length,
    k: items.filter((v) => v.K && !v.K.x).length,
    l: items.filter((v) => v.L && !v.L.x).length,
    recent: [...follows, ...collects],
  };
}

function wechat() {
  const data = read("wechat", "videos");
  if (!data) return null;
  const items = data.items ?? [];
  return {
    updated: data.updated ?? null,
    k: items.length,
    a: new Set(items.map((d) => d.a).filter(Boolean)).size,
    recent: items.slice(0, 6).map((d) => ({ type: "article", t: (d.n || "").slice(0, 80), a: d.a, j: d.j, u: d.u, p: "/wechat" })),
  };
}

const BUILDERS = { douyin: () => creatorsAndVideos("douyin"), wechat, x: () => creatorsAndVideos("x") };

export function writeSummary(slug) {
  const summary = BUILDERS[slug]?.();
  if (!summary) return;
  writeFileSync(join(ROOT, `public/data/${slug}/summary.json`), JSON.stringify(summary));
  console.log(`摘要：public/data/${slug}/summary.json`);
}

if (process.argv[1] && new URL(import.meta.url).pathname.endsWith(process.argv[1].replace(/\\/g, "/").split("/").pop())) {
  for (const slug of process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(BUILDERS)) writeSummary(slug);
}
