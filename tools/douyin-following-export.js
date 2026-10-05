// 导出自己抖音账号的关注列表，得到 douyin-following.json，供 tools/resync.py 比对写回 Notion。使用前先读 tools/README.md 的免责说明。
//
// - 参数照网页关注列表选「最近关注」时页面自己发出的请求：source_type=1、count=20、按 max_time 时间游标翻页
//   （下一页的 max_time 取上一页返回的 min_time）。按时间翻页，取的过程中有关注、取关也不会错位。count 最多 20，设大了服务端也只回 20 个。
// - 每页之间停 1.2 到 1.8 秒，节奏接近手动翻页；约 500 页（1 万个账号）实测 20 分钟取完、没有触发限频。
//   连续请求太多会被限频，碰到第一次异常（空内容、非 0 状态、有下一页却给了空列表）就停，不重试；隔 30 分钟以上再接着取。
// - 每页存进本站 IndexedDB（库 follows-export，按 sec_uid 存，自动去重），标签页关掉也不丢，再运行第一段会从记下的游标接着取。
// - 每个账号记 pos（在「最近关注」列表里的位置，0 是最近关注的）和所在页的 page_min（该页最后一个账号的关注时刻）。
//   接口不给关注时间，resync.py 靠这两项推算关注先后与关注日期。
// - sec 与 user_id 是你自己抖音账号的标识，在页面里自动读取，不需要填。
//
// 用法：在已登录的 www.douyin.com 页面打开开发者工具的控制台，粘贴运行第一段（会立即开始），用 followsExport.live 看进度；
// 取完后运行第二段下载。下载核对无误后再删掉 IndexedDB 里的库。

// 第一段：开始或接着取
(() => {
  const SEC = "MS4wLjABAAAAyfFzOXL4hkXOQm0Sxk9LJJmUNl3Vbxw_j3n1HR292vg", USER_ID = "86934590612";
  const MAX_PAGES = 520;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const openDb = () => new Promise((ok, fail) => { const q = indexedDB.open("follows-export", 1); q.onupgradeneeded = () => { q.result.createObjectStore("rows", {keyPath: "sec_uid"}); q.result.createObjectStore("meta"); }; q.onsuccess = () => ok(q.result); q.onerror = () => fail(q.error); });
  let dbp = null; const db = () => (dbp ??= openDb());
  const tx = async (store, mode, fn) => { const d = await db(); return new Promise((ok, fail) => { const t = d.transaction(store, mode); const r = fn(t.objectStore(store)); t.oncomplete = () => ok(r && "result" in r ? r.result : undefined); t.onerror = () => fail(t.error); }); };
  const toRow = (u) => ({uid: u.uid, sec_uid: u.sec_uid, unique_id: u.unique_id || u.short_id || "", nickname: u.nickname, signature: u.signature || "", followers: u.follower_count, posts: u.aweme_count, verify: u.custom_verify || "", enterprise: u.enterprise_verify_reason || "", mutual: u.follower_status === 1, avatar: u.avatar_168x168?.url_list?.[0] || u.avatar_thumb?.url_list?.[0] || ""});
  const live = {phase: "idle", pages: 0, stored: 0, cursor: null, err: null, started: null, keys: null};
  async function start() {
    if (live.phase === "running") return "running";
    live.phase = "running"; live.err = null; live.started = new Date().toLocaleTimeString();
    // started 是第一页的 max_time 游标，也就是开始取的时刻；resync.py 拿它作第一页关注时刻的上界
    const now = Math.floor(Date.now() / 1000);
    const meta = (await tx("meta", "readonly", (s) => s.get("state"))) ?? {cursor: now, started: now, finished: false, pos: 0};
    try {
      while (!meta.finished) {
        // 每次运行最多取 MAX_PAGES 页，全量约 492 页，留出余量；到上限就停，断点续取接着来
        if (live.pages >= MAX_PAGES) { live.phase = "stopped"; live.err = `到上限 ${MAX_PAGES} 页`; return live.err; }
        live.cursor = meta.cursor;
        const r = await fetch(`/aweme/v1/web/user/following/list/?device_platform=webapp&aid=6383&channel=channel_pc_web&user_id=${USER_ID}&sec_user_id=${SEC}&offset=0&min_time=0&max_time=${meta.cursor}&count=20&source_type=1&gps_access=0&address_book_access=0&is_top=1`, {credentials: "include"});
        const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch {}
        const list = j?.followings ?? null;
        // 第一次异常就停：空内容、非 0 状态、或还有下一页却给了空列表
        if (!j || j.status_code !== 0 || !list || (!list.length && j.has_more)) { live.phase = "stopped"; live.err = `HTTP ${r.status} len ${t.length} code ${j?.status_code}`; return live.err; }
        const pos = meta.pos ?? 0;
        // page_min 是这一页返回的 min_time（下一页的游标），实测就是本页最后一个账号的关注时刻（Unix 秒），
        // 492 页从近到远严格递减到 2020-04；Notion「关注日期」据它推算
        await tx("rows", "readwrite", (s) => list.forEach((u, i) => s.put({...toRow(u), pos: pos + i, page_min: j.min_time})));
        if (!live.keys && list.length) live.keys = Object.keys(list[0]);
        meta.pos = pos + list.length;
        live.pages++;
        const next = j.min_time;
        if (!j.has_more || !list.length || !next || next >= meta.cursor) meta.finished = true; else meta.cursor = next;
        await tx("meta", "readwrite", (s) => s.put(meta, "state"));
        live.stored = await tx("rows", "readonly", (s) => s.count());
        await sleep(1200 + Math.random() * 600);
      }
      live.phase = "done"; return "done";
    } catch (e) { live.phase = "stopped"; live.err = String(e); return live.err; }
  }
  window.followsExport = {start, live, all: () => tx("rows", "readonly", (s) => s.getAll()), meta: () => tx("meta", "readonly", (s) => s.get("state"))};
  start();
  return "started";
})();

// 第二段：followsExport.live.phase 为 done 后运行，下载成 douyin-following.json；total_reported 填主页此刻显示的关注数
// IndexedDB 按 sec_uid 取出，下载前按 pos 排回「最近关注」的顺序，不排的话名单顺序是乱的
// const rows = (await followsExport.all()).sort((a, b) => a.pos - b.pos);
// const meta = await followsExport.meta();
// const blob = new Blob([JSON.stringify({fetched_at: new Date().toISOString(), started_at: new Date(meta.started * 1000).toISOString(), total_reported: 0, source: "following/list source_type=1 count=20 max_time cursor", rows})], {type: "application/json"});
// const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = "douyin-following.json"; document.body.appendChild(a); a.click(); a.remove();
