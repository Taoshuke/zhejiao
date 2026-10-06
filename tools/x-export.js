// 导出自己 X 账号的关注、书签、喜欢，得到 x-following-日期.json、x-bookmarks-日期.json、x-likes-日期.json。使用前先读 tools/README.md 的免责说明。
//
// - 用的是 x.com 网页自己会发的 GraphQL 请求：Following、Bookmarks、Likes。请求编号（queryId）、要带的 features、
//   网页的 Bearer 令牌都在运行时从页面已加载的脚本里读，X 改版换了编号也不用改这里。令牌只留在页面里，不打印、不存盘。
//   书签的请求编号在懒加载的模块里，所以要先打开书签页（x.com/i/bookmarks），等列表出来再运行。
// - 关注每页回的个数多于请求的 20 个，书签、喜欢每页 20 条；三种请求的限频在写这个工具时都是每 15 分钟 500 次，响应头 x-rate-limit-remaining 可查剩余次数。
// - 每页之间默认停 2 到 3 秒，可用 opts.gap 改；opts.maxPages 设每类最多取几页，到了就停，live.stoppedAtLimit 里会记下是哪一类。
//   碰到第一次异常就停，不重试；被限频后隔 15 分钟以上再取。
// - 接口不给关注、加书签、点喜欢的时间。每项记列表位置 pos（0 是最近的），先后靠它排。
// - 喜欢只能取到接口还会返回的那些，已删除或作者设了保护的帖子取不到，所以条数常比账号资料上的少。
// - 图片视频不存地址，只记有哪几种（photo、video、animated_gif）。
//
// 用法：在已登录的 x.com 书签页打开开发者工具的控制台，粘贴运行第一段（会立即开始，在后台跑）。第一段末尾的数组决定取哪几类。
// 用 xExport.live 看进度；live.done 为 true 后运行第二段，三个文件会下载到浏览器的下载目录。
// Chrome 可能拦下同一网站连续触发的下载，地址栏右侧会出现提示，选「始终允许」后再运行一次第二段。取数期间别刷新这个标签页。

// 第一段：开始取
((steps, opts) => {
  const gap = opts.gap ?? [2000, 3000];
  const maxPages = {following: 100, bookmarks: 150, likes: 150, ...opts.maxPages};
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const live = {step: null, pages: 0, items: {following: 0, bookmarks: 0, likes: 0}, done: false, error: null, stoppedAtLimit: []};
  const out = {following: [], bookmarks: [], likes: []};
  window.xExport = {live, out};

  // 从已加载的模块里读请求编号与 features；书签的在懒加载模块里，所以读 webpackChunk 而不是 script 标签
  const ops = {}, meta = {};
  const chunkKey = Object.keys(window).find((k) => k.startsWith("webpackChunk"));
  for (const [, mods] of window[chunkKey] ?? []) for (const id in mods) {
    const s = mods[id].toString();
    for (const m of s.matchAll(/queryId:"([^"]+)",operationName:"(Following|Bookmarks|Likes|UserByScreenName)"/g)) {
      ops[m[2]] = m[1];
      const seg = s.slice(m.index, m.index + 4000);
      const list = (re) => (seg.match(re)?.[1] ?? "").split(",").map((x) => x.replace(/"/g, "")).filter(Boolean);
      meta[m[2]] = {fs: list(/featureSwitches:\[([^\]]*)\]/), ft: list(/fieldToggles:\[([^\]]*)\]/)};
    }
  }
  let bearer = null;
  const findBearer = async () => {
    for (const s of [...document.scripts].map((x) => x.src).filter((x) => /twimg/.test(x))) {
      const b = (await fetch(s).then((r) => r.text())).match(/"(AAAAAAAAAAAAAAAAAAAAA[A-Za-z0-9%]+)"/);
      if (b) return b[1];
    }
    throw new Error("页面脚本里没找到 Bearer 令牌");
  };

  const get = async (op, variables) => {
    if (!ops[op]) throw new Error(`没找到 ${op} 的请求编号，先打开书签页再运行`);
    const qs = new URLSearchParams({
      variables: JSON.stringify(variables),
      features: JSON.stringify(Object.fromEntries(meta[op].fs.map((k) => [k, true]))),
      fieldToggles: JSON.stringify(Object.fromEntries(meta[op].ft.map((k) => [k, false]))),
    });
    const ct0 = document.cookie.match(/ct0=([^;]+)/)?.[1];
    const r = await fetch(`/i/api/graphql/${ops[op]}/${op}?${qs}`, {credentials: "include", headers: {
      authorization: "Bearer " + bearer, "x-csrf-token": ct0, "x-twitter-auth-type": "OAuth2Session",
      "x-twitter-active-user": "yes", "content-type": "application/json",
    }});
    if (!r.ok) throw new Error(`${op} 返回 ${r.status}，剩余额度 ${r.headers.get("x-rate-limit-remaining")}`);
    const body = await r.json();
    if (body.errors?.length && !body.data) throw new Error(`${op} 报错：${body.errors[0].message}`);
    return body;
  };

  const entriesOf = (body) => {
    const tl = body.data?.bookmark_timeline_v2?.timeline ?? body.data?.user?.result?.timeline?.timeline;
    return (tl?.instructions ?? []).flatMap((i) => i.entries ?? (i.entry ? [i.entry] : []));
  };

  const toUser = (u) => ({
    id: u.rest_id, sn: u.core?.screen_name ?? u.legacy?.screen_name, name: u.core?.name ?? u.legacy?.name,
    bio: u.profile_bio?.description ?? u.legacy?.description ?? "",
    followers: u.relationship_counts?.followers ?? u.legacy?.followers_count ?? null,
    avatar: (u.avatar?.image_url ?? u.legacy?.profile_image_url_https ?? "").replace("_normal.", "_400x400."),
    verified: !!u.is_blue_verified,
  });

  // 正文里的 t.co 短链换成原链接；末尾指向图片视频的那条短链去掉
  const fullText = (t) => {
    const note = t.note_tweet?.note_tweet_results?.result;
    let text = note?.text ?? t.legacy.full_text ?? "";
    const urls = [...(note?.entity_set?.urls ?? []), ...(t.legacy.entities?.urls ?? [])];
    for (const u of urls) if (u.url && u.expanded_url) text = text.split(u.url).join(u.expanded_url);
    for (const m of t.legacy.entities?.media ?? []) text = text.split(m.url).join("");
    return text.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").trim();
  };

  const toTweet = (r) => {
    const t = r.tweet ?? r;
    if (!t?.legacy) return null;
    const u = t.core?.user_results?.result ?? {};
    const sn = u.core?.screen_name ?? u.legacy?.screen_name;
    const q = t.quoted_status_result?.result;
    const qt = q && (q.tweet ?? q);
    return {
      id: t.rest_id, text: fullText(t), created: new Date(t.legacy.created_at).toISOString(), lang: t.legacy.lang,
      author: {id: u.rest_id, sn, name: u.core?.name ?? u.legacy?.name},
      url: `https://x.com/${sn}/status/${t.rest_id}`,
      media: [...new Set((t.legacy.extended_entities?.media ?? []).map((m) => m.type))],
      reply_to: t.legacy.in_reply_to_screen_name ?? undefined,
      quote: qt?.legacy ? {id: qt.rest_id, sn: qt.core?.user_results?.result?.core?.screen_name, text: fullText(qt)} : undefined,
      likes: t.legacy.favorite_count, views: t.views?.count ? Number(t.views.count) : undefined,
    };
  };

  const run = async (step, op, varsOf, pick) => {
    live.step = step;
    let cursor = null, pages = 0;
    const seen = new Set();
    for (;;) {
      if (pages >= maxPages[step]) { live.stoppedAtLimit.push(step); break; }
      const body = await get(op, varsOf(cursor));
      pages++; live.pages++;
      const entries = entriesOf(body);
      let added = 0;
      for (const e of entries) {
        const item = pick(e);
        if (!item || seen.has(item.id)) continue;
        seen.add(item.id);
        out[step].push({...item, pos: out[step].length});
        added++;
      }
      live.items[step] = out[step].length;
      const next = entries.find((e) => e.content?.cursorType === "Bottom")?.content?.value;
      // 到底的标志：没有新项，或下一页游标以 0| 开头（关注列表）
      if (!added || !next || next.startsWith("0|") || next === cursor) break;
      cursor = next;
      await sleep(gap[0] + Math.random() * (gap[1] - gap[0]));
    }
  };

  (async () => {
    bearer = await findBearer();
    const sn = document.querySelector("[data-testid=AppTabBar_Profile_Link]")?.getAttribute("href")?.slice(1);
    const me = (await get("UserByScreenName", {screen_name: sn})).data.user.result.rest_id;
    const tweetOf = (e) => e.entryId.startsWith("tweet-") ? toTweet(e.content?.itemContent?.tweet_results?.result ?? {}) : null;
    for (const step of steps) {
      if (step === "following") await run(step, "Following", (c) => ({userId: me, count: 20, includePromotedContent: false, ...(c && {cursor: c})}),
        (e) => e.entryId.startsWith("user-") && e.content?.itemContent?.user_results?.result?.rest_id ? toUser(e.content.itemContent.user_results.result) : null);
      if (step === "bookmarks") await run(step, "Bookmarks", (c) => ({count: 20, includePromotedContent: false, ...(c && {cursor: c})}), tweetOf);
      if (step === "likes") await run(step, "Likes", (c) => ({userId: me, count: 20, includePromotedContent: false, withClientEventToken: false, withBirdwatchNotes: false, withVoice: true, ...(c && {cursor: c})}), tweetOf);
      if (step !== steps.at(-1)) await sleep(gap[1]);
    }
    live.done = true;
  })().catch((e) => { live.error = String(e.message ?? e); live.done = true; });
  return "已开始，用 xExport.live 看进度";
})(["following", "bookmarks", "likes"], {});

// 第二段：取完后下载三个文件
// (() => {
//   const day = new Date().toLocaleDateString("sv-SE");
//   for (const [step, name] of [["following", "x-following"], ["bookmarks", "x-bookmarks"], ["likes", "x-likes"]]) {
//     const a = document.createElement("a");
//     a.href = URL.createObjectURL(new Blob([JSON.stringify(xExport.out[step], null, 1)], {type: "application/json"}));
//     a.download = `${name}-${day}.json`; a.click();
//   }
// })();
