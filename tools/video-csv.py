"""把导出的收藏或喜欢视频连同分类结果写成 CSV，用来在 Notion 里新建「抖音收藏」「抖音喜欢」数据库（Notion 的「导入 CSV」）。

用法：
  python tools/video-csv.py collect <douyin-likes.json> <分类.json> <输出.csv>
  python tools/video-csv.py like    <douyin-likes.json> <分类.json> <输出.csv>

- 收藏和喜欢各一个数据库，收藏多一列「收藏夹」。分类用 tools/video-classify-prompt.md 的视频分类，和博主分类是两套。
  分类.json 是 {视频 id: 分类}，缺分类或分类不在名单里就拒绝出 CSV。
- 不存封面。行按列表位置排，最近收藏、喜欢的在前。
- 「添加时间」初次导入留空：接口不给时间，按位置错开会让全部旧视频冒充「近期」。以后新增的才记时刻。
- 列名与网页读取的一致，见 docs/notion-schema.md。填了「取消日期」就算取消，没有单独的勾选列。
- 勾选列写 Yes、No，多选列用逗号分隔，日期写 YYYY-MM-DD HH:MM（零时区，Notion 导入按零时区解析）。导入后把各列改成对应类型。
"""
import csv
import datetime
import json
import re
import sys
from pathlib import Path

CATEGORIES = ["人工智能", "编程开发", "数码硬件", "心理成长", "人生感悟", "哲学思想", "历史人文", "时事国际", "财经投资", "科学科普",
              "语言学习", "读书文学", "职场求职", "法律常识", "健康医疗", "健身康复", "美食烹饪", "音乐欣赏", "影视娱乐", "设计摄影",
              "穿搭美妆", "颜值写真", "幽默搞笑", "异国见闻", "旅行风光", "家居装修", "好物种草", "体育赛事", "汽车出行", "育儿教育",
              "眼镜验配", "内容不明"]


def one_line(s):
    return re.sub(r"\s+", " ", s or "").strip()


def clean_desc(desc):
    # 图文的文案在网页接口里被截断，末尾带抖音加的提示，去掉提示、留省略号标明截断
    return re.sub(r"…*版本过低，升级后可展示全部信息$", "…", desc or "")


def title(row):
    # 名称取文案里第一个话题标签之前的部分，太长截到 80 字；没有就用话题，再没有标「无文案」
    text = one_line(re.split(r"#", clean_desc(row["desc"]), maxsplit=1)[0])
    if not text:
        text = " ".join("#" + t for t in row["tags"]) or "（无文案）"
    return text[:80]


# Notion 导入 CSV 时把不带时区的时间当作零时区（按本机时间写会差出时区那几个小时），所以写零时区时间
def stamp(ts):
    return datetime.datetime.fromtimestamp(ts, datetime.timezone.utc).strftime("%Y-%m-%d %H:%M") if ts else ""


def main(kind, export_path, cats_path, out_path):
    rows = json.loads(Path(export_path).read_text(encoding="utf-8"))["rows"]
    cats = json.loads(Path(cats_path).read_text(encoding="utf-8"))
    flag, pos_key = ("collected", "collect_pos") if kind == "collect" else ("liked", "like_pos")
    rows = sorted((r for r in rows if r.get(flag)), key=lambda r: r[pos_key])
    bad = [(r["id"], cats.get(r["id"])) for r in rows if cats.get(r["id"]) not in CATEGORIES]
    if bad:
        sys.exit(f"{len(bad)} 个视频缺分类或分类不在名单里，例如 {bad[:5]}")
    header = ["名称", "分类"] + (["收藏夹"] if kind == "collect" else []) + [
        "作者", "视频链接", "作者主页链接", "类型", "时长（秒）", "发布时间", "点赞数", "话题", "文案", "特别关注", "取消日期", "添加时间"]
    with open(out_path, "w", encoding="utf-8", newline="") as f:
        w = csv.writer(f)
        w.writerow(header)
        for r in rows:
            link = f"https://www.douyin.com/{'note' if r['note'] else 'video'}/{r['id']}"
            w.writerow([title(r), cats[r["id"]]] + ([",".join(r.get("folders") or [])] if kind == "collect" else []) + [
                one_line(r["author"]), link, f"https://www.douyin.com/user/{r['author_sec']}" if r["author_sec"] else "",
                "图文" if r["note"] else "视频", "" if r["note"] else round((r["duration_ms"] or 0) / 1000),
                stamp(r["created"]), r["likes"] if r["likes"] is not None else "", ",".join(r["tags"]),
                one_line(clean_desc(r["desc"]))[:2000], "No", "", ""])
    print(f"写了 {len(rows)} 行到 {out_path}")


if __name__ == "__main__":
    if len(sys.argv) != 5 or sys.argv[1] not in ("collect", "like"):
        sys.exit(__doc__)
    main(*sys.argv[1:])
