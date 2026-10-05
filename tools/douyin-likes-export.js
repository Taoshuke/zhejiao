// 导出自己抖音账号的喜欢与收藏，得到 douyin-likes.json，供 tools/video-csv.py 生成导入 Notion 的 CSV。使用前先读 tools/README.md 的免责说明。
//
// - 三段依次取：收藏的视频、各收藏夹里的视频、喜欢的视频。每段各记游标，停下后再运行第一段从断点接着取。
//   收藏：POST /aweme/v1/web/aweme/listcollection/，body count=30&cursor=，下一页用返回的 cursor。
//   收藏夹：GET /aweme/v1/web/collects/list/ 列出收藏夹，再按 collects_id 取 /aweme/v1/web/collects/video/list/。
//   喜欢：GET /aweme/v1/web/aweme/favorite/，count=18，下一页用返回的 max_cursor。
//   每页实际回的个数常比请求的少，差的多半是已删除、私密或失效的视频；收藏夹显示的数量也会比取到的多。
// - 每页之间默认停 1.2 到 1.8 秒，可用 opts.gap 改；数量很大时建议 [3000, 4000]，实测 500 多页没有触发限频。
//   opts.maxPages 设每次最多取几页，到了就停（断点留着，再运行第一段接着取）。
// - 每页存进本站 IndexedDB（库 likes-export，按视频 ID 存），同一视频在几段里出现会合并成一行。
// - 碰到第一次异常（空内容、非 0 状态、有下一页却给了空列表）就停，不重试；隔 30 分钟以上再接着取。
// - 接口不给点喜欢、收藏的时间。每段给视频记位置（like_pos、collect_pos，0 是最近的），先后靠它排。
// - 不存封面：封面地址带有效期，网页也不显示封面。
//
// 用法：在已登录的 www.douyin.com 页面打开开发者工具的控制台，粘贴运行第一段（会立即开始）。第一段末尾的数组决定取哪几段，
// 可以分段取，比如先取 ["collect", "folders"]，过后再取 ["like"]。取数期间不要用同一账号在别处大量浏览抖音。


// 第一段：开始或接着取
((steps, opts) => {
  const SEC = "MS4wLjABAAAAyfFzOXL4hkXOQm0Sxk9LJJmUNl3Vbxw_j3n1HR292vg";
  const BASE = "device_platform=webapp&aid=6383&channel=channel_pc_web";
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const openDb = () => new Promise((ok, fail) => { const q = indexedDB.open("likes-export", 1); q.onupgradeneeded = () => { q.result.createObjectStore("rows", {keyPath: "id"}); q.result.createObjectStore("meta"); }; q.onsuccess = () => ok(q.result); q.onerror = () => fail(q.error); });
  let dbp = null; const db = () => (dbp ??= openDb());
  const tx = async (store, mode, fn) => { const d = await db(); return new Promise((ok, fail) => { const t = d.transaction(store, mode); const r = fn(t.objectStore(store)); t.oncomplete = () => ok(r && "result" in r ? r.result : undefined); t.onerror = () => fail(t.error); }); };
  const toRow = (a) => ({
    id: a.aweme_id, desc: a.desc || "", note: Array.isArray(a.images) && a.images.length > 0,
    author: a.author?.nickname || "", author_sec: a.author?.sec_uid || "", author_uid: a.author?.uid || "",
    created: a.create_time, duration_ms: a.video?.duration || a.duration || 0,
    likes: a.statistics?.digg_count ?? null, collects: a.statistics?.collect_count ?? null,
    comments: a.statistics?.comment_count ?? null, shares: a.statistics?.share_count ?? null,
    tags: (a.text_extra || []).map((t) => t.hashtag_name).filter(Boolean),
  });
  // 读出已有的行再合并：喜欢、收藏、收藏夹三段的标记各自叠加，资料以最后一次为准
  const merge = (store, list, extra) => list.forEach((a, i) => {
    const q = store.get(a.aweme_id);
    q.onsuccess = () => {
      const old = q.result ?? {folders: []}, add = extra(i, old);
      store.put({...old, ...toRow(a), ...add, folders: [...new Set([...(old.folders || []), ...(add.folders || [])])]});
    };
  });
  const get = async (url, opt) => { const r = await fetch(url, {credentials: "include", ...opt}); const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch {} return {r, t, j}; };
  const bad = ({r, t, j}, list) => (!j || j.status_code !== 0 || !list || (!list.length && j.has_more)) ? `HTTP ${r.status} len ${t.length} code ${j?.status_code}` : null;
  const live = {phase: "idle", step: null, pages: 0, stored: 0, err: null, started: null};
  let cfg = {gap: [1200, 1800], maxPages: Infinity}, batch = 0;
  const pause = () => sleep(cfg.gap[0] + Math.random() * (cfg.gap[1] - cfg.gap[0]));
  class Limit extends Error {}

  // 按游标翻完一段；fetchPage 返回 {res, list, next}，mark 给每条视频加这一段的标记
  async function run(key, fetchPage, mark) {
    const meta = (await tx("meta", "readonly", (s) => s.get(key))) ?? {cursor: 0, finished: false, pos: 0};
    live.step = key;
    while (!meta.finished) {
      if (batch >= cfg.maxPages) throw new Limit();
      const {res, list, next} = await fetchPage(meta.cursor);
      const err = bad(res, list);
      if (err) throw new Error(`${key}: ${err}`);
      const pos = meta.pos;
      await tx("rows", "readwrite", (s) => merge(s, list, (i, old) => mark(pos + i, old)));
      meta.pos = pos + list.length;
      live.pages++; batch++;
      if (!res.j.has_more || !list.length || !next || next === meta.cursor) meta.finished = true; else meta.cursor = next;
      await tx("meta", "readwrite", (s) => s.put(meta, key));
      live.stored = await tx("rows", "readonly", (s) => s.count());
      await pause();
    }
  }

  async function start(only = steps, o = opts) {
    if (live.phase === "running") return "running";
    cfg = {...cfg, ...o}; batch = 0;
    live.phase = "running"; live.err = null; live.started = new Date().toLocaleTimeString();
    try {
      if (only.includes("collect")) await run("collect", async (cursor) => {
        const res = await get(`/aweme/v1/web/aweme/listcollection/?${BASE}`, {method: "POST", headers: {"content-type": "application/x-www-form-urlencoded"}, body: `count=30&cursor=${cursor}`});
        return {res, list: res.j?.aweme_list ?? null, next: res.j?.cursor};
      }, (pos) => ({collected: true, collect_pos: pos}));

      let folders = only.includes("folders") ? await tx("meta", "readonly", (s) => s.get("folders")) : [];
      if (!folders) {
        const res = await get(`/aweme/v1/web/collects/list/?${BASE}&cursor=0&count=50`);
        const err = bad(res, res.j?.collects_list);
        if (err) throw new Error(`folders: ${err}`);
        if (res.j.has_more) throw new Error("folders: 收藏夹超过 50 个，先补上收藏夹翻页");
        batch++;
        folders = res.j.collects_list.map((c) => ({id: c.collects_id_str || String(c.collects_id), name: c.collects_name, total: c.total_number}));
        await tx("meta", "readwrite", (s) => s.put(folders, "folders"));
        await pause();
      }
      for (const f of folders) {
        await run(`folder:${f.id}`, async (cursor) => {
          const res = await get(`/aweme/v1/web/collects/video/list/?${BASE}&collects_id=${f.id}&cursor=${cursor}&count=20`);
          return {res, list: res.j?.aweme_list ?? null, next: res.j?.cursor};
        }, () => ({folders: [f.name]}));
      }

      if (only.includes("like")) await run("like", async (cursor) => {
        const res = await get(`/aweme/v1/web/aweme/favorite/?${BASE}&sec_user_id=${SEC}&max_cursor=${cursor}&min_cursor=0&count=18`);
        return {res, list: res.j?.aweme_list ?? null, next: res.j?.max_cursor};
      }, (pos) => ({liked: true, like_pos: pos}));
      live.phase = "done"; return "done";
    } catch (e) {
      if (e instanceof Limit) { live.phase = "paused"; return `paused after ${batch} pages`; }
      live.phase = "stopped"; live.err = String(e.message || e); return live.err;
    }
  }
  window.likesExport = {start, live, all: () => tx("rows", "readonly", (s) => s.getAll()), meta: async () => Object.fromEntries(await Promise.all(["collect", "folders", "like"].map(async (k) => [k, await tx("meta", "readonly", (s) => s.get(k))])))};
  start();
  return "started";
})(["collect", "folders", "like"], {});

// 第二段：likesExport.live.phase 为 done 后运行，下载成 douyin-likes.json；
// favoriting_count 填主页此刻的喜欢数（profile/other 接口 user.favoriting_count），收藏没有总数可比
// const rows = await likesExport.all();
// const blob = new Blob([JSON.stringify({fetched_at: new Date().toISOString(), favoriting_count: 0, folders: (await likesExport.meta()).folders, rows})], {type: "application/json"});
// const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = "douyin-likes.json"; document.body.appendChild(a); a.click(); a.remove();
