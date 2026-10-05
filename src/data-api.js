/**
 * 网页读数据与查同步进度的两个只读接口，由 worker.js 核验登录凭证后调用。
 *
 * GET /api/<平台>/creators：返回仓库 main 上最新的 public/data/<平台>/creators.json（博主）；
 * GET /api/<平台>/videos：同样的做法返回 public/data/<平台>/videos.json（收藏、喜欢、收藏夹；微信是公众号文章），网页切到「内容」时才读；
 * GET /api/<平台>/summary：同样的做法返回 public/data/<平台>/summary.json，首页用的几十 KB 摘要（数量与最近几条）。
 * 数据上线不依赖部署：数据文件要是随部署打包，构建服务一出故障，同步任务提交了的数据就上不了线。
 * 所以 Worker 直接从仓库读，同步任务一提交就生效。
 *   1. 带上缓存里那份的 ETag 问 GitHub，没变回 304（不计 GitHub 接口额度），用缓存；变了取新的，存进缓存；
 *   2. GitHub 读不到时用缓存里的上一份；
 *   3. 缓存也没有时，用最后一次部署时打包进去的那份。
 *   响应头 x-data-source 标出来源（github / stale-cache / bundled），后两种网页会提示数据可能不是最新的。
 *   只原样转发，不解析这近 4 MB 的 JSON，免得超出免费版每次 10 毫秒的计算时间。
 *
 * GET /api/sync-status?since=<POST /api/sync 返回的 at>：这次「从 Notion 同步」走到哪一步。
 *   waiting       合并器里有待启动的全量同步，定时器到点就启动
 *   queued / running / success / failure（附失败的步骤名）  GitHub 上点下之后建的全量运行的状态
 *   dispatch-failed  点下之后启动失败（附原因），不重试
 *   not-started   合并器里没有，GitHub 上也没有；刚启动、运行还没建出来的几秒里也是这个，网页持续一段时间才判失败
 */
import { githubHeaders } from "./github-app.js";

const repoApi = (env) => `https://api.github.com/repos/${env.GITHUB_REPO}`;

const debouncer = (env) => env.SYNC.get(env.SYNC.idFromName("sync"));

async function github(env, path, headers = {}) {
  const stub = debouncer(env);
  const res = await fetch(`${repoApi(env)}/${path}`, { headers: { ...githubHeaders(await stub.githubToken()), ...headers } });
  // 令牌被拒时清掉缓存，下次重新换：应用重装过（401），或应用新加了权限而缓存的令牌是之前换的（403）
  if (res.status === 401 || res.status === 403) await stub.forgetGithubToken();
  return res;
}

const dataResponse = (body, source) =>
  new Response(body, {
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-data-source": source },
  });

// 各平台的数据文件读法相同，file 如 douyin/creators.json
export async function serveFile(file, request, env, ctx) {
  // 缓存键只是个标识，不对应真实网址
  const cacheKey = new URL(`/__cache/${file}`, request.url).href;
  // DATA_FAULT 平时不设，只在测试备用数据时临时部署：github 模拟读不到仓库，github+cache 再加上缓存也没有
  const fault = env.DATA_FAULT ?? "";
  const cache = caches.default;
  const cached = fault === "github+cache" ? undefined : await cache.match(cacheKey);
  try {
    if (fault) throw new Error(`simulated fault ${fault}`);
    const etag = cached?.headers.get("x-etag");
    const res = await github(env, `contents/public/data/${file}?ref=${env.GITHUB_BRANCH || "main"}`, {
      Accept: "application/vnd.github.raw+json",
      ...(etag && { "If-None-Match": etag }),
    });
    if (res.status === 304 && cached) return dataResponse(cached.body, "github");
    if (!res.ok) throw new Error(`GitHub ${res.status}`);
    const fresh = new Response(res.body, {
      headers: { "content-type": "application/json; charset=utf-8", "cache-control": "max-age=31536000", "x-etag": res.headers.get("etag") ?? "" },
    });
    ctx.waitUntil(cache.put(cacheKey, fresh.clone()));
    return dataResponse(fresh.body, "github");
  } catch (err) {
    console.error(`read ${file} from GitHub failed: ${err.message}`);
    if (cached) return dataResponse(cached.body, "stale-cache");
    const bundled = await env.ASSETS.fetch(new Request(new URL(`/data/${file}`, request.url)));
    return dataResponse(bundled.body, "bundled");
  }
}

const json = (body, status = 200) => Response.json(body, { status, headers: { "cache-control": "no-store" } });

// 失败运行里第一个失败的步骤名，查不到时返回空串
async function failedStep(env, runId) {
  const res = await github(env, `actions/runs/${runId}/jobs`);
  if (!res.ok) return "";
  const { jobs = [] } = await res.json();
  for (const job of jobs) {
    const step = (job.steps ?? []).find((s) => s.conclusion === "failure");
    if (step) return step.name;
  }
  return "";
}

export async function syncStatus(request, env) {
  const since = Date.parse(new URL(request.url).searchParams.get("since") ?? "");
  if (Number.isNaN(since)) return json({ error: "bad since" }, 400);
  try {
    const res = await github(env, "actions/workflows/sync-follows.yml/runs?per_page=10&event=workflow_dispatch");
    if (!res.ok) throw new Error(`GitHub ${res.status}`);
    const { workflow_runs: runs = [] } = await res.json();
    // 列表从新到旧，取点下之后建的最早一次全量运行
    const run = runs.filter((r) => r.display_title === "sync-follows full" && Date.parse(r.created_at) >= since).at(-1);
    if (run) {
      if (run.status !== "completed") return json({ state: run.status === "in_progress" ? "running" : "queued", url: run.html_url });
      if (run.conclusion === "success") return json({ state: "success", url: run.html_url });
      return json({ state: "failure", conclusion: run.conclusion, step: await failedStep(env, run.id), url: run.html_url });
    }
    const { full, failed } = await debouncer(env).pendingFull();
    // 原因可能带着 GitHub 返回的整段内容，只留开头
    if (failed && Date.parse(failed.at) >= since) return json({ state: "dispatch-failed", error: failed.error.slice(0, 120) });
    return json({ state: full ? "waiting" : "not-started" });
  } catch (err) {
    console.error(`sync status failed: ${err.message}`);
    return json({ state: "unknown", error: err.message }, 502);
  }
}
