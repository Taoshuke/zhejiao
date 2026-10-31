// 把 douban-detail-extract.js 在浏览器里读到的豆瓣资料写成详情页用的静态文件 public/details/douban/<豆瓣编号>.json。
// 输入是 {编号: 资料} 的 JSON 文件；读到的资料为空（豆瓣条目页上什么都没有）就不写，已有的文件不删。
// 已有文件里带 checked 的是简介由本站重写或按站外资料人工核对过的，不拿豆瓣资料覆盖。
// 这些文件随网页部署（不在 public/data 下，推送后由 Workers Builds 构建上线），详情页打开时按编号读一个。
// 影片加 --movie：输入是 douban-movie-extract.js 读到的资料，写成 public/details/douban-movie/<编号>.json。
// 用法：node scripts/write-douban-details.mjs [--movie] <资料.json>
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const movie = process.argv.includes("--movie");
const DIR = join(import.meta.dirname, "..", "public", "details", movie ? "douban-movie" : "douban");
const input = JSON.parse(readFileSync(process.argv.filter((a) => a !== "--movie")[2], "utf8"));
mkdirSync(DIR, { recursive: true });
let written = 0;
for (const [v, detail] of Object.entries(input)) {
  if (!/^\d+$/.test(v) || !detail || !Object.keys(detail).length) continue;
  const file = join(DIR, `${v}.json`);
  if (existsSync(file) && JSON.parse(readFileSync(file, "utf8")).checked) { console.log(`跳过 ${v}：已按站外资料核对`); continue; }
  writeFileSync(file, JSON.stringify(detail) + "\n");
  written++;
}
console.log(`写了 ${written} ${movie ? "部" : "本"}的详情资料到 public/details/${movie ? "douban-movie" : "douban"}/`);
