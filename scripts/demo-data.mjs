/**
 * 生成虚构的演示数据，写进 public/data/（不提交，见 .gitignore），不配 Notion 也能在本机打开网页看效果：
 *   node scripts/demo-data.mjs
 *   npx wrangler dev 或任意静态服务器打开 public/（平台页是 app.html）
 * 名字、文案、链接全是编的，和真实账号无关。同样的种子每次生成同样的数据。
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { writeSummary } from "./summary.mjs";

const ROOT = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
let seed = 20261005;
const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const pick = (list) => list[Math.floor(rand() * list.length)];
const int = (lo, hi) => Math.floor(lo + rand() * (hi - lo + 1));
const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const now = Date.now();
const daysAgo = (d) => new Date(now - d * 864e5 - int(0, 86399) * 1000).toISOString();
const day = (iso) => iso.slice(0, 10);
// 演示用的头像：按名字算一个色相，渐变底上写名字的第一个字；不用 rand，免得改变其余数据
const hue = (name) => [...name].reduce((h, c) => (h * 31 + c.codePointAt(0)) % 360, 7);
const avatar = (name) => {
  const h = hue(name), ch = [...name.replace(/^@/, "")][0].toUpperCase();
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${h} 55% 62%)"/><stop offset="1" stop-color="hsl(${(h + 40) % 360} 50% 42%)"/></linearGradient></defs><rect width="96" height="96" fill="url(#g)"/><text x="48" y="50" font-family="PingFang SC,Microsoft YaHei,sans-serif" font-size="42" font-weight="600" fill="#fff" text-anchor="middle" dominant-baseline="central">${ch}</text></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
};
const write = (file, data) => {
  const path = join(ROOT, "public/data", file);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify(data));
  console.log(`演示数据：public/data/${file}`);
};

// ---------- 抖音博主 ----------
const FOLLOW_CATS = ["科技数码", "知识科普", "历史人文", "财经商业", "情感心理", "美食餐饮", "旅行探索", "运动健身", "影视娱乐", "生活分享", "职业日常", "家庭生活"];
const SYL = ["阿", "北", "晨", "大", "风", "光", "禾", "嘉", "可", "蓝", "林", "木", "南", "小", "青", "森", "桃", "晚", "夏", "言", "一", "知", "舟", "白", "半", "川"];
const TAIL = ["说", "日记", "研究所", "笔记", "工作室", "的厨房", "在路上", "聊科技", "讲历史", "Lab", "TV", "同学", "老师", "君"];
const BIO = ["每周更新一期，讲点有用的", "记录普通人的一天", "把复杂的事情讲简单", "关注我，一起慢慢变好", "不定期分享读书笔记", "前工程师，现在拍视频", "吃遍街头小馆", "背包走过三十个国家"];
const creators = Array.from({ length: 160 }, (_, i) => {
  const n = pick(SYL) + pick(SYL) + pick(TAIL);
  const fans = Math.round(Math.exp(rand() * 15.5));
  const followed = daysAgo(Math.pow(rand(), 2) * 900);
  const item = { id: uuid(1000 + i), n, c: pick(FOLLOW_CATS), u: "https://www.douyin.com/", b: pick(BIO), a: avatar(n), f: fans, j: followed, o: 0 };
  if (rand() < 0.08) item.s = 1;
  if (rand() < 0.04) { item.x = 1; item.d = daysAgo(int(1, 25)); }
  return item;
});
creators.sort((a, b) => a.j.localeCompare(b.j)).forEach((c, i) => (c.o = i + 1));
creators.sort((a, b) => b.f - a.f);
write("douyin/creators.json", { updated: new Date(now).toISOString(), categories: FOLLOW_CATS, items: creators });

// ---------- 抖音收藏与喜欢 ----------
const VIDEO_CATS = ["人工智能", "编程开发", "数码硬件", "心理成长", "历史人文", "财经投资", "科学科普", "读书文学", "美食烹饪", "旅行风光", "健身康复", "影视娱乐"];
const TOPIC = {
  人工智能: ["三分钟看懂大模型怎么回答问题", "用智能体自动整理邮件的完整流程", "本地跑一个小模型需要什么配置"],
  编程开发: ["写给新手的命令行入门", "一个周末做完的小工具，开源了", "为什么你的代码越写越难改"],
  数码硬件: ["这台旧笔记本换了固态硬盘之后", "相机买二手要看哪几处", "手机续航为什么越来越差"],
  心理成长: ["拖延不是懒，是在逃避某种感觉", "学会拒绝之后的第一个月", "如何和焦虑相处"],
  历史人文: ["一张地图看懂丝绸之路", "古人的一天是怎么过的", "这座城为什么叫这个名字"],
  财经投资: ["复利到底有多可怕", "看懂一家公司的财报只需三步", "为什么不建议追涨"],
  科学科普: ["为什么天空是蓝色的", "睡眠不足时大脑在发生什么", "一颗种子如何知道向上长"],
  读书文学: ["今年读过最好的一本书", "这本小说的结尾我想了很久", "读经典的正确姿势"],
  美食烹饪: ["十分钟快手早餐", "外婆的红烧肉做法", "一口锅做完一桌菜"],
  旅行风光: ["在海边小镇住了一周", "冷门却好看的山路自驾", "一个人旅行要带什么"],
  健身康复: ["久坐族的肩颈放松", "每天十五分钟在家练核心", "跑步膝盖疼怎么办"],
  影视娱乐: ["这部老电影现在看依然惊艳", "配乐让一场戏封神", "三分钟讲完一部纪录片"],
};
const FOLDERS = ["稍后再看", "学做菜"];
const videos = Array.from({ length: 180 }, (_, i) => {
  const c = pick(VIDEO_CATS), inK = rand() < 0.6, inL = !inK || rand() < 0.3;
  const it = {
    v: String(7300000000000000000n + BigInt(i * 7919)),
    u: "https://www.douyin.com/",
    t: `${pick(TOPIC[c])} #${c}`,
    a: pick(SYL) + pick(SYL) + pick(TAIL),
    du: int(15, 900),
    pt: daysAgo(1 + Math.pow(rand(), 1.8) * 800),
    lk: Math.round(Math.exp(rand() * 13)),
  };
  if (inL) it.L = { id: uuid(5000 + i), c, ...(rand() < 0.2 && { j: daysAgo(int(0, 40)) }) };
  if (inK) it.K = { id: uuid(6000 + i), c, ...(rand() < 0.2 && { j: daysAgo(int(0, 40)) }) };
  if (inK && rand() < 0.15) it.F = { s: rand() < 0.5 ? 1 : 0, f: rand() < 0.5 ? [pick(FOLDERS)] : [] };
  // 只在喜欢里的视频也能标星（星标同样记在收藏夹库）
  if (!inK && rand() < 0.08) it.F = { s: 1, f: [] };
  if (it.F && !it.F.s && !it.F.f.length) delete it.F;
  return it;
}).sort((a, b) => b.pt.localeCompare(a.pt));
write("douyin/videos.json", { updated: new Date(now).toISOString(), cats: { K: VIDEO_CATS, L: VIDEO_CATS }, folders: FOLDERS, items: videos });

// ---------- 微信公众号文章 ----------
const ACCOUNTS = ["慢读书房", "城市观察家", "格物笔记", "史海拾贝", "数字生活周刊", "经济学随笔", "山野手记", "思想市场", "科学松鼠会客厅", "电影手册"];
const TITLES = ["一本书读懂城市的形成", "为什么我们越来越难专注", "那些被遗忘的古代发明", "从一杯咖啡看全球贸易", "写给年轻人的理财第一课", "我们需要怎样的公共空间",
  "一位老匠人的四十年", "算法推荐会让人变窄吗", "重读《瓦尔登湖》", "山里的学校", "气候变化与我们的餐桌", "翻译是一门遗憾的艺术", "如何读一首诗", "小镇青年的十年", "博物馆里的一件小物"];
// 内容视图用的分类：按公众号大致对应一类，少数文章换到别的类
const ARTICLE_CATS = ["读书出版", "社会研究", "西方哲学", "中国历史", "商业科技", "经济研究", "人间故事", "政治理论", "教育学术", "艺术影视"];
const articles = Array.from({ length: 96 }, (_, i) => {
  const a = pick(ACCOUNTS);
  return {
    id: uuid(9000 + i),
    n: `${pick(TITLES)}${rand() < 0.3 ? `｜${pick(["访谈", "书评", "札记", "专题"])}` : ""}`,
    a,
    u: "https://mp.weixin.qq.com/",
    j: day(daysAgo(Math.pow(rand(), 1.6) * 1500)),
    o: 0,
    c: rand() < 0.8 ? ARTICLE_CATS[ACCOUNTS.indexOf(a)] : pick(ARTICLE_CATS),
  };
}).sort((x, y) => x.j.localeCompare(y.j));
articles.forEach((x, i) => (x.o = i + 1));
articles.reverse();
write("wechat/videos.json", { updated: new Date(now).toISOString(), cats: ARTICLE_CATS, items: articles });

// ---------- X 博主、书签与喜欢 ----------
// 账号分类是 X 单独的一套；X 不给关注时间，先后只靠关注顺序
const X_CATS = ["人工智能", "编程开发", "软件工具", "投资理财", "加密货币", "新闻媒体", "国际局势", "文艺娱乐", "知识科普", "生活分享", "个人日常"];
const FIRST = ["Alex", "Mia", "Leo", "Nora", "Sam", "Iris", "Owen", "Ada", "Kai", "Luna", "Theo", "Zoe", "Max", "Ivy", "Ben", "Eli"];
const LAST = ["Chen", "Park", "Rivera", "Ito", "Novak", "Silva", "Hart", "Moreau", "Lin", "Berg", "Kaur", "Wells"];
const X_BIO = {
  人工智能: ["Building small agents that do boring work", "研究大模型推理，偶尔写写博客", "ML engineer. Notes on evals and tooling"],
  编程开发: ["Rust, Go, and too many side projects", "写前端十年，最近在学编译器", "Open source maintainer"],
  软件工具: ["Shipping a calm note-taking app", "一个人做效率工具", "Product updates and tips"],
  投资理财: ["Long-term investor. Not financial advice", "每周写一篇市场笔记", "Index funds and patience"],
  加密货币: ["Onchain since 2017", "研究链上数据", "Wallet design and security"],
  新闻媒体: ["Daily briefing on tech and policy", "独立新闻编辑", "Correspondent covering Asia"],
  国际局势: ["Writing about trade and diplomacy", "关注国际关系与地缘", "Foreign policy analyst"],
  文艺娱乐: ["Film nerd. Mostly old movies", "插画师，画城市和猫", "Making music at night"],
  知识科普: ["Explaining physics with napkin drawings", "科普作者，讲点生物学", "History threads every Sunday"],
  生活分享: ["Living in a small coastal town", "记录在国外的日常", "Coffee, bikes, and long walks"],
  个人日常: ["", "hi", "just here to read"],
};
// 名字不重复：从名与姓的全部组合里挑
const NAMES = FIRST.flatMap((f) => LAST.map((l) => `${f} ${l}`));
const xCreators = Array.from({ length: 96 }, (_, i) => {
  const name = NAMES.splice(Math.floor(rand() * NAMES.length), 1)[0], c = pick(X_CATS);
  const item = { id: uuid(12000 + i), n: name, c, u: "https://x.com/", b: pick(X_BIO[c]), a: avatar(name), f: Math.round(Math.exp(4 + rand() * 11.5)), o: 0 };
  if (!item.b) delete item.b;
  if (rand() < 0.08) item.s = 1;
  if (rand() < 0.03) { item.x = 1; item.d = daysAgo(int(1, 25)); }
  return item;
});
xCreators.forEach((c, i) => (c.o = i + 1));
xCreators.sort((a, b) => b.f - a.f);
write("x/creators.json", { updated: new Date(now).toISOString(), categories: X_CATS, items: xCreators });

// 帖子沿用内容分类（和抖音视频同一套）
const POST_CATS = ["人工智能", "编程开发", "数码硬件", "财经投资", "时事国际", "科学科普", "读书文学", "人生感悟"];
const POST = {
  人工智能: ["把一个评测集从 2000 条精简到 200 条，结论几乎没变。小而准的评测比大而全的更有用。", "Spent the weekend wiring an agent to triage my inbox. The hard part was deciding what it should never do.", "上下文越长越好吗？实测下来，先把资料整理干净，比一股脑塞进去效果好得多。"],
  编程开发: ["A tiny CLI that turns any folder into a static gallery. ~200 lines, no dependencies.", "重构的第一步不是改代码，是先补测试。", "Hot take: most config files should be code."],
  数码硬件: ["换了块屏幕，旧笔记本又能再战三年。", "The best camera upgrade is still a better lens.", "机械键盘的轴体选错了，打字一天手腕就知道。"],
  财经投资: ["复利最难的部分不是数学，是坚持不动。", "Reading 10-Ks so you don't have to: three things to check first.", "利率每变一点，房贷月供差多少，算给你看。"],
  时事国际: ["Thread: what the new trade agreement actually changes, in plain words.", "一张图看懂这次选举的各方席位。", "Why shipping costs matter more than headlines suggest."],
  科学科普: ["为什么夜空是黑的？这个问题困扰了天文学家两百年。", "Octopuses taste with their arms. Yes, really.", "一棵树一天能蒸发多少水。"],
  读书文学: ["今年读到最好的开头，第一句就让人停不下来。", "Rereading a book ten years later is meeting a different author.", "写作的秘诀之一，是把形容词删掉一半。"],
  人生感悟: ["慢慢来，比较快。", "Most good things in life are boring on day one.", "允许自己有一段时间什么都不做。"],
};
const posts = Array.from({ length: 140 }, (_, i) => {
  const c = pick(POST_CATS), inK = rand() < 0.55, inL = !inK || rand() < 0.25;
  const it = {
    v: String(1900000000000000000n + BigInt(i * 104729)),
    u: "https://x.com/",
    t: pick(POST[c]),
    a: `${pick(FIRST)} ${pick(LAST)}`,
    pt: daysAgo(1 + Math.pow(rand(), 1.8) * 700),
    lk: Math.round(Math.exp(rand() * 11)),
  };
  if (inL) it.L = { id: uuid(14000 + i), c, ...(rand() < 0.15 && { j: daysAgo(int(0, 40)) }) };
  if (inK) it.K = { id: uuid(16000 + i), c, ...(rand() < 0.15 && { j: daysAgo(int(0, 40)) }) };
  // X 与小红书的星标是库里的「星标」列，同一条两个库一起勾
  if (rand() < 0.1) for (const k of ["K", "L"]) if (it[k]) it[k].s = 1;
  return it;
}).sort((a, b) => b.pt.localeCompare(a.pt));
write("x/videos.json", { updated: new Date(now).toISOString(), cats: { K: POST_CATS, L: POST_CATS }, folders: [], items: posts });

// ---------- 小红书博主、收藏与点赞 ----------
// 博主分类沿用抖音博主那套；笔记分类沿用内容分类。卡片上的文字是标题接正文
const RED_TAIL = ["的日常", "Studio", "爱生活", "在纽约", "学英语", "读书会", "的小屋", "种草机", "Vlog", "说设计"];
const redCreators = Array.from({ length: 88 }, (_, i) => {
  const n = pick(SYL) + pick(SYL) + pick(RED_TAIL);
  const item = { id: uuid(18000 + i), n, c: pick(FOLLOW_CATS), u: "https://www.xiaohongshu.com/", b: pick(BIO), a: avatar(n), f: Math.round(Math.exp(3 + rand() * 11)), o: 0 };
  if (rand() < 0.06) item.s = 1;
  return item;
});
redCreators.forEach((c, i) => (c.o = redCreators.length - i));
redCreators.sort((a, b) => b.f - a.f);
write("rednote/creators.json", { updated: new Date(now).toISOString(), categories: FOLLOW_CATS, items: redCreators });

const NOTE_CATS = ["读书文学", "语言学习", "职场求职", "财经投资", "人生感悟", "美食烹饪", "旅行风光", "穿搭美妆"];
// 每条是 [标题, 正文]
const NOTE = {
  读书文学: [["今年读完的十二本书", "按读完的先后排，最喜欢第七本。"], ["把一本难读的书读完的方法", "每天只读十页，读不懂的先跳过。"], ["睡前读诗的第一百天", "抄下来的句子攒了一整本。"], ["二手书店淘到的旧版", "扉页上还有上一位主人的字。"], ["重读小时候的童话", "发现很多情节当年根本没看懂。"], ["一个人的读书会", "读完写三行，坚持了半年。"]],
  语言学习: [["三个月备考雅思的时间表", "前两周只练听力，后面每天一套题。"], ["每天二十分钟练听力", "一年后能听懂大半的播客了。"], ["背单词不如读原文", "读到第三本小说，生词明显少了。"], ["日语五十音一周记住", "用歌和卡片，地铁上就能练。"], ["口语练习找搭子", "每周两次线上聊天，各说半小时。"], ["法语入门的三本教材", "从发音讲起的那本最适合自学。"]],
  职场求职: [["转行第一年踩过的坑", "最大的坑是不敢开口问。"], ["面试被问到最多的五个问题", "附上我自己的回答思路。"], ["简历改了八版之后", "删掉一半的形容词，回复多了。"], ["第一次带新人", "先把自己的流程写下来。"], ["周报怎么写不费劲", "每天下班前记三行就够。"], ["从实习到转正的三个月", "最有用的是每周找导师聊一次。"]],
  财经投资: [["刚工作的第一笔存款", "先留半年的生活费，再说别的。"], ["记账一年，发现钱都花在哪了", "外卖和打车占了三成。"], ["给自己定的消费规则", "超过五百的东西等一周再买。"], ["保险怎么买不踩坑", "先配医疗险和意外险。"], ["攒钱旅行的小方法", "每月固定转一笔进单独的账户。"], ["看懂工资条", "公积金和个税那几行终于明白了。"]],
  人生感悟: [["三十岁之后才明白的几件事", "身体比什么都重要。"], ["允许自己慢一点", "不用每件事都赶在别人前面。"], ["和父母好好说话", "先听完，再说自己的想法。"], ["一个人住的第三年", "学会了修水龙头，也学会了独处。"], ["断舍离之后", "家里空了，心里也轻了。"], ["给十年后的自己写信", "封好放进抽屉，到时候再拆。"]],
  美食烹饪: [["一周不重样的便当", "周日备菜两小时，平时十分钟装盒。"], ["零失败的家常小炒", "火要大，菜要沥干。"], ["第一次烤出完整的戚风", "蛋白打到硬性发泡是关键。"], ["十分钟的早餐", "前一晚泡好燕麦，早上加水果。"], ["奶奶的红烧肉", "不放一滴水，全靠黄酒和冰糖。"], ["电饭煲也能做的焖饭", "腊肠和米一起下锅，香得很。"]],
  旅行风光: [["小众海岛五天四夜攻略", "人少水清，住在渔村里。"], ["第一次独自旅行的清单", "证件拍照存在手机里。"], ["高铁能到的周末小城", "两天走完老街和湖边。"], ["雨天的古镇", "撑伞走石板路，反而更安静。"], ["徒步一条山脊线", "七个小时，看到了云海。"], ["坐慢车看风景", "绿皮车上和邻座聊了一路。"]],
  穿搭美妆: [["通勤穿搭的五个公式", "基础款搭一件亮色就够。"], ["敏感肌用了半年的护肤顺序", "精简到三步，泛红少了。"], ["小个子怎么穿长裙", "高腰加短外套，显腿长。"], ["一支口红的三种涂法", "薄涂、叠涂、晕染各有味道。"], ["衣柜只留三十件", "每件都能互相搭配。"], ["夏天的防晒怎么选", "通勤用轻薄的，出游用防水的。"]],
};
// 每条笔记各用一次，卡片上不出现重复的文字
const notes = Object.entries(NOTE).flatMap(([c, list]) => list.map((pair) => [c, pair])).map(([c, [title, body]], i) => {
  const inK = rand() < 0.75, inL = !inK || rand() < 0.15;
  const v = (0x6a00000000000000000000n + BigInt(i * 7907)).toString(16).padStart(24, "0").slice(-24);
  const it = {
    v,
    u: `https://www.xiaohongshu.com/explore/${v}`,
    t: `${title}
${body}`,
    a: pick(SYL) + pick(SYL) + pick(RED_TAIL),
    pt: daysAgo(1 + Math.pow(rand(), 1.6) * 500),
    lk: Math.round(Math.exp(rand() * 10)),
  };
  if (inK) it.K = { id: uuid(20000 + i), c };
  if (inL) it.L = { id: uuid(22000 + i), c };
  if (rand() < 0.15) for (const k of ["K", "L"]) if (it[k]) it[k].s = 1;
  return it;
}).sort((a, b) => b.pt.localeCompare(a.pt));
write("rednote/videos.json", { updated: new Date(now).toISOString(), cats: { K: NOTE_CATS, L: NOTE_CATS }, folders: [], items: notes });

writeSummary("douyin");
writeSummary("wechat");
writeSummary("x");
writeSummary("rednote");
