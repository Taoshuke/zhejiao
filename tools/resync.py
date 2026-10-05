"""重抓抖音关注列表后（tools/douyin-following-export.js），把变化写回 Notion 的「抖音博主」数据库。使用前先读 tools/README.md。

用法：
  python tools/resync.py plan <新名单.json> <计划文件夹>   只读：比对 Notion 与新名单，生成 plan.json、new.tsv、unfollow-candidates.json
  python tools/resync.py confirm <计划文件夹>               把 unfollow-check.json（逐个查到的关注状态）并进计划
  python tools/resync.py classify <计划文件夹>              把 new.tsv 里填好的分类并进计划，并核对分类都存在
  python tools/resync.py apply <计划文件夹>                 按计划写 Notion；写完不同步网页，到网页上点「从 Notion 同步」

规则：
- 关注关系以抖音为准。Notion 里关注中、抖音已经没有的，勾「已取关」并填取关时间（写入时刻，带时区）。
- 「新关注」有三种，网页上一律当新关注：
  1. Notion 里没有这个账号：新建一行，要先分类；
  2. Notion 标了取关、抖音名单里还在：在原行上清掉已取关和取关日期；
  3. Notion 是关注中，但在抖音上取关后又关注了，被抖音挪到名单顶部：在原行上改。认法见 moved()。
  后两种保留原来的分类和特别关注。三种都换新的「关注日期」和「关注顺序」，网页排到最前、进「近期关注」。
- 关注日期按名单里每页的时间游标推算（page_min 就是该页最后一个账号的关注时刻）：同一页在上一页游标与本页游标之间按位置均分，
  第一页的上界是开始取的时刻 started_at。名单没有 page_min 或 started_at（旧格式）时退回写入时刻：
  按 pos 越靠前越新，往后每个早 1 分钟（Notion 日期只存到分钟，错开秒数会被丢掉）。
- 关注顺序（网页「关注先后」排序用，1 是最早关注的，越大越新）：接着 Notion 里现有的最大值往上编，同一批里越靠前编号越大。
- 两边都有且仍在关注的：昵称、头像、简介有变化就更新，粉丝数变化超过 1% 才更新；分类、星标不动。
  昵称只去首尾空白；简介压成一行；头像只比较链接路径，不比较服务器地址。
- 两边按 sec_uid 对应，Notion 里取自「主页链接」末尾。对不上或重复的单列出来，不写。
- 标记取关前逐个确认：plan 把候选写进 unfollow-candidates.json；在已登录的抖音页面里逐个查关注状态，
  结果存成 unfollow-check.json（sec_uid → follow_status，查不到为 null）。confirm 只保留 follow_status 为 0 的；
  仍在关注的说明名单漏了，不标并单列；查不到的（注销、封禁）单列出来由你决定。没 confirm 过，apply 拒绝执行。

环境变量：NOTION_WRITE_TOKEN（有读取、更新、插入内容权限的 Notion 连接令牌；Windows 上当前进程里没有时再读用户级环境变量），
NOTION_CREATORS_DS（「抖音博主」的数据源 ID，与 src/platforms.mjs 里 douyin.creators 相同）。
写入贴着 Notion 的限速跑：并发 6 个，429 时按 Retry-After 等待。
"""
import bisect
import csv
import datetime
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

DATA_SOURCE_ID = os.environ.get("NOTION_CREATORS_DS", "").strip() or sys.exit("缺少环境变量 NOTION_CREATORS_DS（「抖音博主」的数据源 ID）")
NOTION_VERSION = "2025-09-03"
FANS_THRESHOLD = 0.01
WORKERS = 6


def token():
    tok = os.environ.get("NOTION_WRITE_TOKEN")
    if not tok and sys.platform == "win32":
        # Windows 上用 setx 存的用户级环境变量，要重开终端才进进程环境，这里直接读注册表
        import winreg
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, "Environment") as k:
            tok = winreg.QueryValueEx(k, "NOTION_WRITE_TOKEN")[0]
    if not tok:
        sys.exit("缺少环境变量 NOTION_WRITE_TOKEN")
    return tok.strip()


TOKEN = token()


def notion(path, method="GET", body=None):
    for attempt in range(1, 9):
        req = urllib.request.Request(
            f"https://api.notion.com/v1/{path}",
            method=method,
            data=json.dumps(body).encode() if body is not None else None,
            headers={"Authorization": f"Bearer {TOKEN}", "Notion-Version": NOTION_VERSION, "Content-Type": "application/json"},
        )
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                return json.load(r)
        except urllib.error.HTTPError as e:
            # 429 是限速，502/503/504 多半是服务端瞬时故障：按 Retry-After 或递增间隔等待后重试，其余错误直接抛出
            if e.code in (429, 502, 503, 504) and attempt < 8:
                time.sleep(float(e.headers.get("retry-after") or attempt))
                continue
            raise RuntimeError(f"Notion {e.code} on {method} {path}: {e.read()[:300]!r}") from e


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
        batch = notion(f"data_sources/{DATA_SOURCE_ID}/query", "POST", body)
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
    """按时间游标推算名单里每个账号的关注时刻（sec_uid → 带时区的 ISO 时间）；旧格式名单返回 None。"""
    rows = raw["rows"]
    if not raw.get("started_at") or not rows or any(r.get("page_min") is None or r.get("pos") is None for r in rows):
        return None
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

    jumped = moved(sorted(exp, key=lambda r: r.get("pos", 0)), notion_by_sec)
    when = follow_times(raw)
    new, unfollow, update = [], [], []
    for s, e in by_sec.items():
        n = notion_by_sec.get(s)
        name = (e["nickname"] or "").strip() or e["unique_id"] or e["uid"]
        bio = one_line(e["signature"])
        if not n:
            new.append({"kind": "create", "sec_uid": s, "name": name, "url": f"https://www.douyin.com/user/{s}", "bio": bio, "fans": e["followers"],
                        "avatar": e["avatar"], "verify": e["verify"] or e["enterprise"], "posts": e["posts"], "category": None,
                        "pos": e.get("pos"), "date": when[s] if when else None})
            continue
        if n["gone"] or s in jumped:
            new.append({"kind": "unfollowed" if n["gone"] else "jumped", "id": n["id"], "name": n["name"], "fans": e["followers"],
                        "pos": e.get("pos"), "date": when[s] if when else None, "old_order": n["order"], "old_date": n["followed"]})
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
         "export_count": len(by_sec), "notion_count": len(rows), "max_order": max((r["order"] or 0 for r in rows), default=0), "new": new, "unfollow": unfollow, "unfollow_confirmed": not unfollow,
         "still_following": [], "unfollow_unknown": [], "update": update,
         "unmatched_notion": unmatched, "dup_notion": dup_notion, "dup_export": dup_export}
    save(out, p)
    (out / "unfollow-candidates.json").write_text(json.dumps([x["sec_uid"] for x in unfollow]), encoding="utf-8")
    with open(out / "new.tsv", "w", encoding="utf-8", newline="") as f:
        w = csv.writer(f, delimiter="\t")
        w.writerow(["sec_uid", "分类", "名称", "粉丝数", "认证", "作品数", "简介"])
        for x in new:
            if x["kind"] == "create":
                w.writerow([x["sec_uid"], "", x["name"], x["fans"], x["verify"], x["posts"], x["bio"]])
    summary(p)
    # 取关又关注的逐个列出来核对：正常应集中在名单顶部
    for x in sorted((x for x in new if x["kind"] == "jumped"), key=lambda x: x["pos"]):
        print(f"  取关又关注：{x['name']}｜名单第 {x['pos'] + 1} 位｜原关注顺序 {x['old_order']}｜原关注日期 {x['old_date']}｜推算日期 {x['date']}")


def summary(p):
    fields = {}
    for u in p["update"]:
        for k in u["changes"]:
            fields[k] = fields.get(k, 0) + 1
    kinds = {k: sum(1 for x in p["new"] if x["kind"] == k) for k in ("create", "unfollowed", "jumped")}
    print(f"新关注 {len(p['new'])}（新建 {kinds['create']}、原标取关 {kinds['unfollowed']}、取关又关注 {kinds['jumped']}）"
          f"｜已取关 {len(p['unfollow'])}｜资料有变化 {len(p['update'])} {fields}")
    print(f"对不上 {len(p['unmatched_notion'])}｜Notion 重复 {len(p['dup_notion'])}｜新名单重复 {len(p['dup_export'])}")


def confirm(out_dir):
    out = Path(out_dir)
    p = load(out)
    check = json.loads((out / "unfollow-check.json").read_text(encoding="utf-8"))
    keep, still, unknown = [], [], []
    for x in p["unfollow"]:
        st = check.get(x["sec_uid"], "missing")
        (keep if st == 0 else unknown if st in (None, "missing") else still).append({**x, "follow_status": st})
    p["unfollow"], p["still_following"], p["unfollow_unknown"], p["unfollow_confirmed"] = keep, still, unknown, True
    save(out, p)
    print(f"确认取关 {len(keep)}｜其实仍在关注（不标）{len(still)}｜查不到（待定）{len(unknown)}")


def classify(out_dir):
    out = Path(out_dir)
    p = load(out)
    schema = notion(f"data_sources/{DATA_SOURCE_ID}")
    options = {o["name"] for o in schema["properties"]["分类"]["select"]["options"]}
    with open(out / "new.tsv", encoding="utf-8", newline="") as f:
        cats = {row["sec_uid"]: row["分类"].strip() for row in csv.DictReader(f, delimiter="\t")}
    bad = []
    creates = [x for x in p["new"] if x["kind"] == "create"]
    for x in creates:
        x["category"] = cats.get(x["sec_uid"]) or None
        if x["category"] not in options:
            bad.append((x["name"], x["category"]))
    save(out, p)
    print(f"已并入 {len(creates) - len(bad)} 个分类" + (f"；缺少或不在 Notion 分类里的：{bad}" if bad else "，全部有效"))


def apply(out_dir):
    out = Path(out_dir)
    p = load(out)
    if not p.get("unfollow_confirmed"):
        sys.exit("取关名单还没有逐个确认，先查关注状态并运行 confirm")
    if "refollow" in p or any("kind" not in x for x in p["new"]):
        sys.exit("这是旧版本生成的计划（还单列改回关注中），重新运行 plan")
    missing = [x["name"] for x in p["new"] if x["kind"] == "create" and not x["category"]]
    if missing:
        sys.exit(f"新关注里还有没分类的：{missing}，先运行 classify")
    done_path = out / "done.json"
    done = set(json.loads(done_path.read_text(encoding="utf-8"))) if done_path.exists() else set()
    # 取关日期记写入时刻、带时区（Notion 只存到分钟），网页「近期取关」按它排序；重抓只知道取关发生在两次重抓之间
    now = datetime.datetime.now().astimezone().replace(microsecond=0)
    # 三种新关注合起来按列表位置排，越靠前（越晚关注）越新；没有位置的排最后，按粉丝数从多到少。
    # 关注日期用计划里按时间游标推算的；旧格式名单没有，就退回写入时刻，往后每个早 1 分钟
    followed = sorted(p["new"], key=lambda x: (x.get("pos") is None, x.get("pos") or 0, -(x.get("fans") or 0)))
    follow_at = {id(x): x.get("date") or (now - datetime.timedelta(minutes=i)).isoformat() for i, x in enumerate(followed)}
    if "max_order" not in p:
        sys.exit("计划里没有 max_order（旧版本生成的计划），重新运行 plan")
    order_of = {id(x): p["max_order"] + len(followed) - i for i, x in enumerate(followed)}
    jobs = []
    for x in (x for x in p["new"] if x["kind"] == "create"):
        jobs.append((f"new:{x['sec_uid']}", "pages", "POST", {"parent": {"type": "data_source_id", "data_source_id": DATA_SOURCE_ID}, "properties": {
            "名称": {"title": [{"text": {"content": x["name"]}}]},
            "平台": {"select": {"name": "抖音"}},
            "分类": {"select": {"name": x["category"]}},
            "主页链接": {"url": x["url"]},
            "简介": {"rich_text": [{"text": {"content": x["bio"][:2000]}}] if x["bio"] else []},
            "粉丝数": {"number": x["fans"]},
            "头像": {"url": x["avatar"] or None},
            "关注日期": {"date": {"start": follow_at[id(x)]}},
            "关注顺序": {"number": order_of[id(x)]},
        }}))
    for x in p["unfollow"]:
        jobs.append((f"unfollow:{x['id']}", f"pages/{x['id']}", "PATCH", {"properties": {"已取关": {"checkbox": True}, "取关日期": {"date": {"start": now.isoformat()}}}}))
    for x in (x for x in p["new"] if x["kind"] != "create"):
        jobs.append((f"follow:{x['id']}", f"pages/{x['id']}", "PATCH", {"properties": {"已取关": {"checkbox": False}, "取关日期": {"date": None}, "关注日期": {"date": {"start": follow_at[id(x)]}}, "关注顺序": {"number": order_of[id(x)]}}}))
    for x in p["update"]:
        props = {}
        for k, (_, v) in x["changes"].items():
            props[k] = ({"title": [{"text": {"content": v}}]} if k == "名称"
                        else {"rich_text": [{"text": {"content": v[:2000]}}] if v else []} if k == "简介"
                        else {"url": v} if k == "头像" else {"number": v})
        jobs.append((f"update:{x['id']}", f"pages/{x['id']}", "PATCH", {"properties": props}))
    todo = [j for j in jobs if j[0] not in done]
    print(f"共 {len(jobs)} 项，已写过 {len(jobs) - len(todo)} 项，这次写 {len(todo)} 项")
    # 每完成一项就记下，出错时已写的不会漏记，重跑时不会重复建行
    errors = []
    with ThreadPoolExecutor(WORKERS) as pool:
        futures = {pool.submit(notion, path, method, body): key for key, path, method, body in todo}
        for i, fut in enumerate(as_completed(futures), 1):
            key = futures[fut]
            try:
                fut.result()
                done.add(key)
            # 超时等网络错误也记下接着跑，不让整批中断、丢掉已写的记录；建行超时可能其实已建成，重跑前先按主页链接查
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
    # Notion 到网页什么时候同步由你在网页上决定，这里不启动同步
    print("Notion 已写完。请在网页侧栏点「从 Notion 同步」，约 1 分半到 2 分钟后网页更新")


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else ""
    if cmd == "plan" and len(sys.argv) == 4:
        plan(sys.argv[2], sys.argv[3])
    elif cmd in ("confirm", "classify", "apply") and len(sys.argv) == 3:
        {"confirm": confirm, "classify": classify, "apply": apply}[cmd](sys.argv[2])
    else:
        sys.exit(__doc__)
