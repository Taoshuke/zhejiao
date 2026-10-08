/**
 * 折角的 Worker。部署在自己的域名上（wrangler.jsonc 的 routes 与 vars.HOST）。
 *
 * 静态资源（页面、图标、清单）由 assets 先行匹配直接返回，不运行这里的代码，也不计调用次数；
 * 进到这里的有这几类：
 * - 不是 HOST 的请求：路径以 REDIRECT_PREFIXES 里的某段开头的（比如搬家前的旧地址），整条路径（连问号后）308 跳到 HOST，其余 404；
 * - 首页 / 是静态的 index.html；按平台分的网址 /<平台>、/<平台>/creator、/collect、/like 没有对应的静态文件，在这里返回 app.html；
 * - /api/*：GET <平台>/creators、<平台>/videos、<平台>/summary（首页用的摘要）、sync-status 交给 data-api.js，网页从仓库读最新数据、查同步进度；
 * - 其余 POST 交给 write-api.js：网页上的改动写进 Notion，再交给 SyncDebouncer 启动同步。
 * 两类接口都先核验 Cloudflare Access 的登录凭证。
 *
 * 同步方向：网页到 Notion 自动；Notion 到网页手动，由用户在网页上点「从 Notion 同步」，批量脚本写完也不自动触发。
 * Notion 不推送事件，批量改 Notion 不产生任何请求。
 *
 * SyncDebouncer 把 DEBOUNCE_MS 内的改动合成一次 sync-follows 运行：
 * - 网页改的行记下页面 ID，按页面同步，只读这几行，不把 Notion 里还没手动同步的改动带进网页；
 * - 改了分类顺序时另读一次分类选项；
 * - 点了「从 Notion 同步」就把当前平台的几个库全表重读；同一次运行里其他平台的改动照常按页面同步。
 * GitHub 同一并发组里新排队的运行会取消旧的排队运行，所以已有一次在排队、还没开始时不再启动，
 * 改动留在这里，过 RETRY_MS 再试，页面 ID 不会因为被取消而丢掉。
 *
 * 需要的配置：HOST（网站域名）、GITHUB_REPO（放代码与数据文件的仓库，owner/name）、REDIRECT_PREFIXES（可选，逗号分隔），
 * 以及 write-api.js、github-app.js 里列的几项；需要的密钥：GITHUB_APP_PRIVATE_KEY（见 github-app.js）、NOTION_WRITE_TOKEN（见 write-api.js）。
 */
import { DurableObject } from "cloudflare:workers";
import { handleWrite, signedIn } from "./write-api.js";
import { serveFile, syncStatus } from "./data-api.js";
import { DATABASES, NAMES } from "./platforms.mjs";
import { forgetToken, githubHeaders, installationToken } from "./github-app.js";

// 同步任务所在的仓库来自配置 GITHUB_REPO
const workflowUrl = (env, path) => `https://api.github.com/repos/${env.GITHUB_REPO}/actions/workflows/sync-follows.yml/${path}`;
// 还没开始跑的运行状态；pending 是并发组里排在正在跑的那次后面
const NOT_STARTED = new Set(["queued", "pending", "waiting", "requested"]);
// 合并窗口：单次点击只多等这么久，连续操作在窗口内合成一次
const DEBOUNCE_MS = 15_000;
// 有一次在排队时、或网页改动的同步启动失败时，隔这么久再试
const RETRY_MS = 20_000;
// 网页改动的同步启动连续失败这么多次就停下；下一次网页操作会重新开始。
// 手动同步（全量）启动失败不重试，记下时间和原因，网页查进度时直接提示「同步没有启动」
const MAX_ATTEMPTS = 5;

// 有排队中、还没开始的运行时返回 true。查询失败按没有处理：宁可多启动一次，也不让改动卡在这里
async function runQueued(env, headers) {
  const res = await fetch(workflowUrl(env, "runs?per_page=10"), { headers });
  if (!res.ok) {
    console.error(`list runs failed ${res.status}`);
    return false;
  }
  const { workflow_runs: runs = [] } = await res.json();
  return runs.some((r) => NOT_STARTED.has(r.status));
}

// full 是要全表重读的平台；同一次运行里也带上网页改的行，属于其他平台的照常按页面同步
async function dispatch(env, headers, job) {
  const inputs = { mode: job.full.length ? "full" : "pages", platforms: job.full.join(","), pages: job.pages.join(","), order: job.order ? "1" : "0" };
  const res = await fetch(workflowUrl(env, "dispatches"), { method: "POST", headers, body: JSON.stringify({ ref: env.GITHUB_BRANCH || "main", inputs }) });
  if (!res.ok) {
    const err = new Error(`dispatch ${res.status}: ${await res.text()}`);
    err.status = res.status;
    throw err;
  }
  console.log(`dispatched ${inputs.mode} platforms=${inputs.platforms} pages=${job.pages.length} order=${inputs.order}`);
}

export class SyncDebouncer extends DurableObject {
  async load() {
    const full = await this.ctx.storage.get("full");
    return {
      // 旧版本记的是 true（当时只有抖音），换成平台名单
      full: Array.isArray(full) ? full : full ? ["douyin"] : [],
      order: (await this.ctx.storage.get("order")) ?? false,
      pages: (await this.ctx.storage.get("pages")) ?? [],
    };
  }

  async merge(job) {
    const cur = await this.load();
    await this.ctx.storage.put({
      full: [...new Set([...cur.full, ...(job.full ?? [])])],
      order: cur.order || Boolean(job.order),
      pages: [...new Set([...cur.pages, ...(job.pages ?? [])])],
    });
  }

  // 并入待同步的改动：{ pages: [页面 ID] } / { order: true } / { full: [平台] }；没有定时器时定一个
  async request(job) {
    await this.merge(job);
    await this.ctx.storage.delete(["attempts", ...(job.full?.length ? ["fullFailed"] : [])]);
    if ((await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(Date.now() + DEBOUNCE_MS);
  }

  // 先取走改动再启动：启动期间新来的改动写进新的记录、定下一次定时器，不会被这次清掉。
  // 启动失败时把改动并回去：手动同步那部分去掉并记下原因；网页改动的那几行隔 RETRY_MS 再试，最多 MAX_ATTEMPTS 次
  async alarm() {
    const job = await this.load();
    if (!job.full.length && !job.order && !job.pages.length) return;
    try {
      // DISPATCH_FAULT 平时不设，只在测试「同步没有启动」时临时部署
      if (this.env.DISPATCH_FAULT) throw new Error("模拟的启动失败");
      const headers = githubHeaders(await installationToken(this.env, this.ctx.storage));
      if (await runQueued(this.env, headers)) {
        await this.ctx.storage.setAlarm(Date.now() + RETRY_MS);
        console.log("a sync is still queued, retrying later");
        return;
      }
      await this.ctx.storage.delete(["full", "order", "pages"]);
      try {
        await dispatch(this.env, headers, job);
      } catch (err) {
        if (err.status === 401) await forgetToken(this.ctx.storage);
        await this.merge(job);
        throw err;
      }
      await this.ctx.storage.delete("attempts");
    } catch (err) {
      console.error(`dispatch failed: ${err.message}`);
      if (job.full.length) {
        await this.ctx.storage.delete("full");
        await this.ctx.storage.put("fullFailed", { at: new Date().toISOString(), error: err.message });
      }
      const rest = await this.load();
      if (!rest.order && !rest.pages.length) return;
      const attempts = ((await this.ctx.storage.get("attempts")) ?? 0) + 1;
      if (attempts < MAX_ATTEMPTS) {
        await this.ctx.storage.put("attempts", attempts);
        await this.ctx.storage.setAlarm(Date.now() + RETRY_MS);
      } else {
        // 改动留在合并器里，下一次网页操作或手动同步时一起启动
        await this.ctx.storage.delete("attempts");
        console.error(`gave up after ${attempts} attempts`);
      }
    }
  }

  // 以下供 data-api.js 调用。安装令牌缓存在这里，所有请求共用一份，不必每次重新换
  githubToken() {
    return installationToken(this.env, this.ctx.storage);
  }

  forgetGithubToken() {
    return forgetToken(this.ctx.storage);
  }

  // 有没有待启动的全量同步；failed 是最近一次手动同步启动失败的时间和原因
  async pendingFull() {
    return { full: (await this.load()).full.length > 0, failed: (await this.ctx.storage.get("fullFailed")) ?? null };
  }

  // 有没有还没启动的网页改动（按页面同步的行或分类顺序）
  async pendingPages() {
    const job = await this.load();
    return job.pages.length > 0 || job.order;
  }
}

// 页面网址：/<平台>（博主），/creator 同博主，/collect 收藏，/like 喜欢；没有数据库的平台也认，页面上自己换到有数据的平台
const PAGE = new RegExp(`^/(?:${Object.keys(NAMES).join("|")})(?:/(?:creator|collect|like))?/?$`);
const DATA = /^\/api\/([a-z]+)\/(creators|videos|summary)$/;
// 不是 HOST 的请求里，路径以这些段开头的跳到 HOST（比如网站从主站某个路径搬到独立域名后，旧地址照样能用）
const prefixes = (env) => (env.REDIRECT_PREFIXES ?? "").split(",").map((s) => s.trim().replace(/^\/|\/$/g, "")).filter(Boolean);

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url), { pathname } = url;
    // 别的域名上只做跳转。308 而不是 301：旧标签页里的写入是 POST，308 跳转后仍是 POST，请求体也跟过去；
    // 旧的接口路径 /<前缀>/api/… 跳过去正好是 /api/…。没配 HOST 时（本机调试）不检查域名
    const host = env.HOST?.trim();
    if (host && url.hostname !== host) {
      const hit = prefixes(env).find((p) => pathname === `/${p}` || pathname.startsWith(`/${p}/`));
      return hit ? Response.redirect(`https://${host}${pathname.slice(hit.length + 1) || "/"}${url.search}`, 308) : new Response("Not Found", { status: 404 });
    }
    if (PAGE.test(pathname) && request.method === "GET") return env.ASSETS.fetch(new Request(new URL("/app", request.url), request));
    const data = pathname.match(DATA);
    if (request.method === "GET" && (pathname === "/api/sync-status" || (data && DATABASES[data[1]]))) {
      if (!(await signedIn(request, env))) return Response.json({ error: "not signed in" }, { status: 401 });
      return data ? serveFile(`${data[1]}/${data[2]}.json`, request, env, ctx) : syncStatus(request, env);
    }
    if (pathname.startsWith("/api/")) return handleWrite(request, env, pathname);
    return env.ASSETS.fetch(request);
  },
};
