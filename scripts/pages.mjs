import { existsSync, readFileSync } from "node:fs";

// 网页改过的行由工作流里「读取网页改过的行」那一步（scripts/read-pages.mjs）各读一次，存进 SYNC_PAGES_FILE 给博主、内容、微信、豆瓣四个同步脚本共用，
// 免得每个脚本都把每一行读一遍再判断属不属于自己；本机单独运行脚本时没有这个文件，就自己读
export async function loadPages(ids, notion) {
  const file = process.env.SYNC_PAGES_FILE;
  const saved = file && existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
  const pages = new Map();
  for (const id of ids) pages.set(id, id in saved ? saved[id] : await notion(`pages/${id}`));
  return pages;
}
