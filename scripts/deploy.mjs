/**
 * 本机部署：node scripts/deploy.mjs [传给 wrangler deploy 的参数]
 *
 * 平时推送到 main 由 Workers Builds 自动部署，本机部署只在构建服务出故障或测试时用。
 * 本机部署打包的是本机的文件，本机仓库落后于远端时，部署出去的就是旧代码和旧的备用数据。
 * 所以先取一次远端，本机有未提交的改动、或不等于 origin/main 时拒绝部署。
 * 部署成功后提醒处理还在排队的旧构建：它们之后若构建成功，会把线上换回旧代码。
 */
import { execFileSync, spawnSync } from "node:child_process";

const git = (...args) => execFileSync("git", ["--no-pager", ...args], { encoding: "utf8" }).trimEnd();

git("fetch", "origin", "main");
const dirty = git("status", "--porcelain");
if (dirty) {
  console.error(`本机有未提交的改动，不部署：\n${dirty}`);
  process.exit(1);
}
const head = git("rev-parse", "HEAD");
const remote = git("rev-parse", "origin/main");
if (head !== remote) {
  const behind = git("rev-list", "--count", "HEAD..origin/main");
  const ahead = git("rev-list", "--count", "origin/main..HEAD");
  console.error(`本机 ${head.slice(0, 7)} 不等于 origin/main ${remote.slice(0, 7)}（落后 ${behind} 个、超前 ${ahead} 个提交），不部署。先拉取或推送。`);
  process.exit(1);
}
console.log(`本机与 origin/main 一致（${head.slice(0, 7)}），开始部署`);
// Windows 上 npx 是 .cmd，要经 shell 才能启动
const { status } = spawnSync("npx", ["wrangler", "deploy", ...process.argv.slice(2)], { stdio: "inherit", shell: process.platform === "win32" });
if (status === 0) {
  console.log(`
部署成功。如果是因为 Workers Builds 出故障才从本机部署的，还要做两件事：
  1. 到 Cloudflare 后台这个 Worker → 部署 → 构建历史，取消还在排队或进行中的旧提交的构建；
  2. 构建服务恢复后，对最新提交 ${head.slice(0, 7)} 的构建点「重试构建」，确认成功。`);
}
process.exit(status ?? 1);
