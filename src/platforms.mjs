/**
 * 平台与 Notion 数据库的对应。每个平台各建一组数据库，网址和数据文件都按平台分开：
 *   网址 /<平台>（博主）、/<平台>/collect（收藏）、/<平台>/like（喜欢），首页 /
 *   数据 public/data/<平台>/creators.json（博主）、videos.json（收藏、喜欢、收藏夹）、summary.json（首页摘要）
 * 点一次「从 Notion 同步」只同步当前平台的这组数据库。
 * 同步脚本（scripts/）、Worker（src/）都从这里读；页面 public/app.html 里的 PLATFORM_LIST、ENABLED 要跟着改。
 * 以后加平台：在 NAMES 里已有英文名，再在 DATABASES 里填上它的数据源 ID（哪个库还没有就不写那一项）。
 * 微信只有一个库「公众号」，是收藏的公众号文章，键名 articles，由 scripts/sync-wechat.mjs 同步成 public/data/wechat/videos.json；
 * 网页上微信只有一页文章，侧栏按文章的公众号分类，没有单独的数据文件；网页上能改标题、公众号，能删除文章。
 * X 照抖音的样子分博主、书签、喜欢三个库，书签用 collect 这个键，网页上叫「书签」；没有收藏夹库。
 * 帖子库的列与抖音视频库对应：帖子链接对视频链接，正文对文案，没有话题、时长；多一列「顺序」，1 是最早加的。
 * 部署前把下面的数据源 ID 换成你自己 Notion 里的（打开数据库，… → 复制数据源 ID）。库的列名见 docs/notion-schema.md。
 * 小红书分博主、收藏、点赞三个库。笔记库的列同 X 的帖子库，链接列叫「笔记链接」，名称是笔记标题，另有「话题」。
 */
export const NAMES = { douyin: "抖音", wechat: "微信", x: "X", rednote: "小红书", bilibili: "哔哩哔哩" };

export const DATABASES = {
  douyin: {
    creators: "00000000-0000-0000-0000-000000000001", // 抖音博主
    collect: "00000000-0000-0000-0000-000000000002", // 抖音收藏
    like: "00000000-0000-0000-0000-000000000003", // 抖音喜欢
    folders: "00000000-0000-0000-0000-000000000004", // 抖音收藏夹
  },
  wechat: {
    articles: "00000000-0000-0000-0000-000000000005", // 公众号（微信收藏里带链接的文章）
  },
  x: {
    creators: "00000000-0000-0000-0000-000000000006", // X 博主
    collect: "00000000-0000-0000-0000-000000000007", // X 书签
    like: "00000000-0000-0000-0000-000000000008", // X 喜欢
  },
  rednote: {
    creators: "00000000-0000-0000-0000-000000000009", // 小红书博主
    collect: "00000000-0000-0000-0000-00000000000a", // 小红书收藏
    like: "00000000-0000-0000-0000-00000000000b", // 小红书点赞
  },
};

// 环境变量 SYNC_PLATFORMS（逗号分隔）里要全表重读的平台；SYNC_MODE=full 而没写平台时（手动运行工作流）全部平台
export function fullPlatforms(env) {
  const listed = (env.SYNC_PLATFORMS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  for (const slug of listed) if (!DATABASES[slug]) throw new Error(`不认识的平台：${slug}`);
  if (listed.length) return new Set(listed);
  return new Set(env.SYNC_MODE === "pages" ? [] : Object.keys(DATABASES));
}
