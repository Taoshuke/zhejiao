"""重抓抖音关注列表后（tools/douyin-following-export.js），把变化写回 Notion 的「抖音博主」数据库。使用前先读 tools/README.md。

用法（在仓库根目录下运行；环境变量 NOTION_CREATORS_DS 填「抖音博主」的数据源 ID）：
  python tools/resync.py plan <新名单.json> <计划文件夹>   只读：比对 Notion 与新名单，生成 plan.json、new.tsv、unfollow-candidates.json
  python tools/resync.py apply <计划文件夹>                 用户放行后运行：先核对 unfollow-check.json 与填好的 new.tsv，有问题就停、一行不写；
                                                            核对通过才写 Notion

规则：
- 关注关系以抖音为准。Notion 里关注中、抖音已经没有的，勾「已取关」并填取关时间（写入时刻，带时区）。
- 「新关注」有三种，网页上一律当新关注（不再单列「改回关注中」）：
  1. Notion 里没有这个账号：新建一行，要先分类并填子分类（一律要填，看不准按最可能的填；上下级见 src/subcategories.mjs）；
  2. Notion 标了取关、抖音名单里还在：在原行上清掉已取关和取关日期；
  3. Notion 是关注中，但在抖音上取关后又关注了，被抖音挪到名单顶部：在原行上改。认法见 moved()。
  后两种保留原来的分类、子分类和特别关注。三种都换新的「关注日期」和「关注顺序」，网页排到最前、进「近期关注」。
- 关注日期按名单里每页的时间游标推算（page_min 就是该页最后一个账号的关注时刻）：同一页在上一页游标与本页游标之间按位置均分，
  第一页的上界是开始取的时刻 started_at。名单缺这两项就拒绝，用 tools/douyin-following-export.js 重新导出。
- 关注顺序（网页「关注先后」排序用，1 是最早关注的，越大越新）：接着 Notion 里现有的最大值往上编，同一批里越靠前编号越大。
- 两边都有且仍在关注的：昵称、头像、简介有变化就更新，粉丝数变化超过 1% 才更新；分类、子分类、星标不动。
  昵称只去首尾空白；简介压成一行；头像只比较链接路径，不比较服务器地址。这些是抖音上的事实，照抖音写，不看「人工」。
- 两边按 sec_uid 对应，Notion 里取自「主页链接」末尾。对不上或重复的单列出来，不写。
- 标记取关前逐个确认：plan 把候选写进 unfollow-candidates.json；在已登录的抖音页面里逐个查关注状态，
  结果存成 unfollow-check.json（sec_uid → follow_status，查不到为 null）。apply 只标 follow_status 为 0 的；
  仍在关注的说明名单漏了，不标并单列；查不到的（注销、封禁）单列给用户定。有候选而没有 unfollow-check.json，apply 拒绝执行。

Notion 请求与令牌用 tools/notion_write.py 的 api()。
"""
import bisect
import csv
import datetime
import json
import os
import re
import sys
import time
import urllib.parse
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

from notion_write import WORKERS, api

DATA_SOURCE_ID = os.environ.get("NOTION_CREATORS_DS", "").strip() or sys.exit("缺少环境变量 NOTION_CREATORS_DS（「抖音博主」的数据源 ID）")
FANS_THRESHOLD = 0.01
SUBCATEGORIES_FILE = Path(__file__).resolve().parent.parent / "src" / "subcategories.mjs"


def douyin_subcategories():
    """网站的分类与子分类上下级，分类与子分类都以它为准。依赖 subcategories.mjs 每个分类一行 "分类": [...] 的写法"""
    text = SUBCATEGORIES_FILE.read_text(encoding="utf-8")
    return {m.group(1): json.loads(m.group(2)) for m in re.finditer(r'^\s*"([^"]+)": (\[.*\]),$', text, re.M)}


def one_line(s):
    return re.sub(r"\s+", " ", s or "").strip()


def text(rich):
    return "".join(t.get("plain_text", "") for t in rich or [])


def sec_uid_of(url):
    m = re.search(r"/user/([^/?#]+)", url or "")
    return m.group(1) if m else None


def avatar_key(url):
    return urllib.parse.urlsplit(url).path if url else ""


def notion_rows():
    rows, cursor = [], None
    while True:
        body = {"page_size": 100}
        if cursor:
            body["start_cursor"] = cursor
        batch = api("POST", f"data_sources/{DATA_SOURCE_ID}/query", body)
        for pg in batch["results"]:
            p = pg["properties"]
            rows.append({
                "id": pg["id"], "name": text(p["名称"]["title"]), "url": p["主页链接"]["url"],
                "bio": text(p["简介"]["rich_text"]), "fans": p["粉丝数"]["number"], "avatar": p["头像"]["url"],
                "gone": p["已取关"]["checkbox"], "order": (p.get("关注顺序") or {}).get("number"),
                "followed": ((p.get("关注日期") or {}).get("date") or {}).get("start"),
            })
        if not batch.get("has_more"):
            return rows
        cursor = batch["next_cursor"]


def save(out, p):
    (out / "plan.json").write_text(json.dumps(p, ensure_ascii=False, indent=1), encoding="utf-8")


def load(out):
    return json.loads((out / "plan.json").read_text(encoding="utf-8"))


def moved(exp_rows, notion_by_sec):
    """Notion 里关注中、但在抖音上取关后又关注过的账号（sec_uid 集合）。
    按新名单从上往下排，没动过的老账号「关注顺序」应该一路从大到小；求最长的一段严格递减序列，视为没动过，
    其余就是被抖音挪到前面去的。没有关注顺序的不参与判断。"""
    seq = [(r["sec_uid"], notion_by_sec[r["sec_uid"]]["order"]) for r in exp_rows
           if r["sec_uid"] in notion_by_sec and not notion_by_sec[r["sec_uid"]]["gone"] and notion_by_sec[r["sec_uid"]]["order"]]
    # 对 -order 求最长严格递增子序列（耐心排序），再沿前驱回溯出这条序列
    tails, tail_idx, prev = [], [], [None] * len(seq)
    for i, (_, order) in enumerate(seq):
        k = bisect.bisect_left(tails, -order)
        prev[i] = tail_idx[k - 1] if k else None
        if k == len(tails):
            tails.append(-order)
            tail_idx.append(i)
        else:
            tails[k] = -order
            tail_idx[k] = i
    keep, i = set(), (tail_idx[-1] if tail_idx else None)
    while i is not None:
        keep.add(i)
        i = prev[i]
    return {seq[i][0] for i in range(len(seq)) if i not in keep}


def follow_times(raw):
    """按时间游标推算名单里每个账号的关注时刻（sec_uid → 带时区的 ISO 时间）。"""
    rows = raw["rows"]
    if not raw.get("started_at") or not rows or any(r.get("page_min") is None or r.get("pos") is None for r in rows):
        sys.exit("名单缺 started_at、page_min 或 pos，用 tools/douyin-following-export.js 重新导出")
    upper = datetime.datetime.fromisoformat(raw["started_at"]).timestamp()
    pages = {}
    for r in sorted(rows, key=lambda r: r["pos"]):
        pages.setdefault(r["page_min"], []).append(r)
    when = {}
    for lower in sorted(pages, reverse=True):
        grp = pages[lower]
        for i, r in enumerate(grp):
            t = upper - (upper - lower) * (i + 1) / len(grp)
            when[r["sec_uid"]] = datetime.datetime.fromtimestamp(t).astimezone().replace(microsecond=0).isoformat()
        upper = lower
    return when


def plan(export_path, out_dir):
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    raw = json.loads(Path(export_path).read_text(encoding="utf-8"))
    exp = raw["rows"]
    when = follow_times(raw)
    t0 = time.time()
    rows = notion_rows()
    print(f"读了 Notion {len(rows)} 行，用时 {time.time() - t0:.0f} 秒；新名单 {len(exp)} 个账号（主页关注数 {raw.get('total_reported')}）")

    by_sec, dup_export = {}, []
    for r in exp:
        (dup_export.append(r["nickname"]) if r["sec_uid"] in by_sec else by_sec.__setitem__(r["sec_uid"], r))
    notion_by_sec, unmatched, dup_notion = {}, [], []
    for r in rows:
        s = sec_uid_of(r["url"])
        if not s:
            unmatched.append({"id": r["id"], "name": r["name"], "url": r["url"]})
        elif s in notion_by_sec:
            dup_notion.append({"id": r["id"], "name": r["name"]})
        else:
            notion_by_sec[s] = r

    jumped = moved(sorted(exp, key=lambda r: r["pos"]), notion_by_sec)
    new, unfollow, update = [], [], []
    for s, e in by_sec.items():
        n = notion_by_sec.get(s)
        name = (e["nickname"] or "").strip() or e["unique_id"] or e["uid"]
        bio = one_line(e["signature"])
        if not n:
            new.append({"kind": "create", "sec_uid": s, "name": name, "url": f"https://www.douyin.com/user/{s}", "bio": bio, "fans": e["followers"],
                        "avatar": e["avatar"], "verify": e["verify"] or e["enterprise"], "posts": e["posts"], "pos": e["pos"], "date": when[s]})
            continue
        if n["gone"] or s in jumped:
            new.append({"kind": "unfollowed" if n["gone"] else "jumped", "id": n["id"], "name": n["name"], "fans": e["followers"],
                        "pos": e["pos"], "date": when[s], "old_order": n["order"], "old_date": n["followed"]})
        changes = {}
        if name != n["name"]:
            changes["名称"] = [n["name"], name]
        if bio != one_line(n["bio"]):
            changes["简介"] = [n["bio"], bio]
        if e["avatar"] and avatar_key(e["avatar"]) != avatar_key(n["avatar"]):
            changes["头像"] = [n["avatar"], e["avatar"]]
        old = n["fans"] or 0
        if e["followers"] is not None and ((old == 0 and e["followers"] > 0) or (old and abs(e["followers"] - old) > FANS_THRESHOLD * old)):
            changes["粉丝数"] = [n["fans"], e["followers"]]
        if changes:
            update.append({"id": n["id"], "name": n["name"], "changes": changes})
    for s, n in notion_by_sec.items():
        if s not in by_sec and not n["gone"]:
            unfollow.append({"id": n["id"], "name": n["name"], "sec_uid": s})

    p = {"created": datetime.datetime.now().isoformat(timespec="seconds"), "export": str(export_path),
         "export_count": len(by_sec), "notion_count": len(rows), "max_order": max((r["order"] or 0 for r in rows), default=0),
         "new": new, "unfollow": unfollow, "update": update,
         "unmatched_notion": unmatched, "dup_notion": dup_notion, "dup_export": dup_export}
    save(out, p)
    (out / "unfollow-candidates.json").write_text(json.dumps([x["sec_uid"] for x in unfollow]), encoding="utf-8")
    with open(out / "new.tsv", "w", encoding="utf-8", newline="") as f:
        w = csv.writer(f, delimiter="\t")
        w.writerow(["sec_uid", "分类", "子分类", "名称", "粉丝数", "认证", "作品数", "简介"])
        for x in new:
            if x["kind"] == "create":
                w.writerow([x["sec_uid"], "", "", x["name"], x["fans"], x["verify"], x["posts"], x["bio"]])
    fields = {}
    for u in update:
        for k in u["changes"]:
            fields[k] = fields.get(k, 0) + 1
    kinds = {k: sum(1 for x in new if x["kind"] == k) for k in ("create", "unfollowed", "jumped")}
    print(f"新关注 {len(new)}（新建 {kinds['create']}、原标取关 {kinds['unfollowed']}、取关又关注 {kinds['jumped']}）"
          f"｜取关候选 {len(unfollow)}｜资料有变化 {len(update)} {fields}")
    print(f"对不上 {len(unmatched)}｜Notion 重复 {len(dup_notion)}｜新名单重复 {len(dup_export)}")
    # 取关又关注的逐个列出给用户核对：正常应集中在名单顶部
    for x in sorted((x for x in new if x["kind"] == "jumped"), key=lambda x: x["pos"]):
        print(f"  取关又关注：{x['name']}｜名单第 {x['pos'] + 1} 位｜原关注顺序 {x['old_order']}｜原关注日期 {x['old_date']}｜推算日期 {x['date']}")


def apply(out_dir):
    out = Path(out_dir)
    p = load(out)

    # 取关逐个确认：只标确实不在关注的
    unfollow, still, unknown = [], [], []
    if p["unfollow"]:
        check_path = out / "unfollow-check.json"
        if not check_path.exists():
            sys.exit("有取关候选但没有 unfollow-check.json：先在抖音页面逐个查关注状态")
        check = json.loads(check_path.read_text(encoding="utf-8"))
        for x in p["unfollow"]:
            st = check.get(x["sec_uid"], "missing")
            (unfollow if st == 0 else unknown if st in (None, "missing") else still).append(x)

    # 新建的账号：分类、子分类都以网站的上下级为准
    subs = douyin_subcategories()
    with open(out / "new.tsv", encoding="utf-8", newline="") as f:
        filled = {row["sec_uid"]: row for row in csv.DictReader(f, delimiter="\t")}
    bad = []
    for x in (x for x in p["new"] if x["kind"] == "create"):
        row = filled.get(x["sec_uid"], {})
        x["category"] = (row.get("分类") or "").strip()
        x["subcategory"] = (row.get("子分类") or "").strip()
        if x["subcategory"] not in subs.get(x["category"], []):
            bad.append((x["name"], x["category"], x["subcategory"]))
    if bad:
        sys.exit(f"new.tsv 里分类或子分类缺少、不存在或不属于该分类：{bad}")

    kinds = {k: sum(1 for x in p["new"] if x["kind"] == k) for k in ("create", "unfollowed", "jumped")}
    print(f"新关注 {len(p['new'])}（新建 {kinds['create']}、原标取关 {kinds['unfollowed']}、取关又关注 {kinds['jumped']}）｜资料有变化 {len(p['update'])}")
    print(f"标取关 {len(unfollow)}｜其实仍在关注（不标）{len(still)} {[x['name'] for x in still]}｜查不到（不标，待用户定）{len(unknown)} {[x['name'] for x in unknown]}")

    # 三种新关注合起来按列表位置排，越靠前（越晚关注）越新，关注顺序接着 Notion 现有最大值往上编
    followed = sorted(p["new"], key=lambda x: x["pos"])
    order_of = {id(x): p["max_order"] + len(followed) - i for i, x in enumerate(followed)}
    # 取关日期记写入时刻、带时区（Notion 只存到分钟），网页「近期取关」按它排序；重抓只知道取关发生在两次重抓之间
    now = datetime.datetime.now().astimezone().replace(microsecond=0).isoformat()
    jobs = []
    for x in (x for x in p["new"] if x["kind"] == "create"):
        jobs.append((f"new:{x['sec_uid']}", "POST", "pages", {"parent": {"type": "data_source_id", "data_source_id": DATA_SOURCE_ID}, "properties": {
            "名称": {"title": [{"text": {"content": x["name"]}}]},
            "平台": {"select": {"name": "抖音"}},
            "分类": {"select": {"name": x["category"]}},
            "子分类": {"select": {"name": x["subcategory"]}},
            "主页链接": {"url": x["url"]},
            "简介": {"rich_text": [{"text": {"content": x["bio"][:2000]}}] if x["bio"] else []},
            "粉丝数": {"number": x["fans"]},
            "头像": {"url": x["avatar"] or None},
            "关注日期": {"date": {"start": x["date"]}},
            "关注顺序": {"number": order_of[id(x)]},
        }}))
    for x in unfollow:
        jobs.append((f"unfollow:{x['id']}", "PATCH", f"pages/{x['id']}", {"properties": {"已取关": {"checkbox": True}, "取关日期": {"date": {"start": now}}}}))
    for x in (x for x in p["new"] if x["kind"] != "create"):
        jobs.append((f"follow:{x['id']}", "PATCH", f"pages/{x['id']}", {"properties": {"已取关": {"checkbox": False}, "取关日期": {"date": None}, "关注日期": {"date": {"start": x["date"]}}, "关注顺序": {"number": order_of[id(x)]}}}))
    for x in p["update"]:
        props = {}
        for k, (_, v) in x["changes"].items():
            props[k] = ({"title": [{"text": {"content": v}}]} if k == "名称"
                        else {"rich_text": [{"text": {"content": v[:2000]}}] if v else []} if k == "简介"
                        else {"url": v} if k == "头像" else {"number": v})
        jobs.append((f"update:{x['id']}", "PATCH", f"pages/{x['id']}", {"properties": props}))

    # 每完成一项就记进 done.json（检查点）：出错时已写的不会漏记，重跑只补没成功的、不会重复建行
    done_path = out / "done.json"
    done = set(json.loads(done_path.read_text(encoding="utf-8"))) if done_path.exists() else set()
    todo = [j for j in jobs if j[0] not in done]
    print(f"共 {len(jobs)} 项，已写过 {len(jobs) - len(todo)} 项，这次写 {len(todo)} 项")
    errors = []
    with ThreadPoolExecutor(WORKERS) as pool:
        futures = {pool.submit(api, method, path, body): key for key, method, path, body in todo}
        for i, fut in enumerate(as_completed(futures), 1):
            key = futures[fut]
            try:
                fut.result()
                done.add(key)
            # 超时等网络错误也记下接着跑，不让整批中断；建行超时可能其实已建成，重跑前先按主页链接查
            except Exception as e:
                errors.append((key, f"{type(e).__name__}: {e}"))
            if i % 200 == 0 or i == len(todo):
                done_path.write_text(json.dumps(sorted(done)), encoding="utf-8")
                print(f"已处理 {i}/{len(todo)}，出错 {len(errors)}", flush=True)
    done_path.write_text(json.dumps(sorted(done)), encoding="utf-8")
    if errors:
        for key, msg in errors[:10]:
            print(f"出错：{key} {msg}")
        sys.exit(f"{len(errors)} 项没写成功，已写的记在 done.json；查明原因后重跑 apply，只会补写没成功的")
    # Notion 到网页由用户决定什么时候同步，这里不启动同步
    print("Notion 已写完。请在网页侧栏点「从 Notion 同步」，约 1 分半到 2 分钟后网页更新")


if __name__ == "__main__":
    args = sys.argv[1:]
    if len(args) == 3 and args[0] == "plan":
        plan(args[1], args[2])
    elif len(args) == 2 and args[0] == "apply":
        apply(args[1])
    else:
        sys.exit(__doc__)
