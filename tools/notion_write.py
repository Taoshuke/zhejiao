"""本机批量改用户可定字段（分类、子分类等）的唯一入口。这类脚本都从这里写，不要自己发 PATCH。
关注状态、昵称、头像、简介、粉丝数是平台上的事实，由 resync.py 照抖音写，不经这里，也不看「人工」。

规则：用户定的东西不改。写每一行之前先读它此刻的样子，下面两种情况跳过不写，最后列出来给用户看：
- 勾了「人工」：用户在网页上改分类、子分类时 Worker 会自动勾上（src/write-api.js 的 MANUAL）；用户也可以在 Notion 里自己勾，取消勾选就是交还给脚本；
- 最后修改人是真人：用户直接在 Notion 里改过、还没被别的写入覆盖。
新建行（POST pages）不受限制。

用法：
    from notion_write import api, update_rows
    skipped, failed = update_rows([(页面 ID, {属性...}), ...])
令牌：环境变量 NOTION_WRITE_TOKEN；Windows 上进程环境里没有时读注册表 HKCU\\Environment（setx 存的用户级变量要重开终端才进进程环境）。并发 6 个，429 与 502/503/504 按 Retry-After 或递增间隔等待后重试。resync.py 也用这里的 api()。
"""
import json
import os
import sys
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor

MANUAL = "人工"
NOTION_VERSION = "2025-09-03"
WORKERS = 6


import functools


@functools.cache
def _token():
    """第一次请求 Notion 时才读令牌，没设令牌也能看各脚本的用法说明"""
    tok = os.environ.get("NOTION_WRITE_TOKEN")
    if not tok and sys.platform == "win32":
        import winreg
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, "Environment") as k:
            tok = winreg.QueryValueEx(k, "NOTION_WRITE_TOKEN")[0]
    if not tok:
        sys.exit("缺少环境变量 NOTION_WRITE_TOKEN")
    return tok.strip()


def api(method, path, body=None):
    for attempt in range(1, 9):
        req = urllib.request.Request(f"https://api.notion.com/v1/{path}", method=method,
                                     data=json.dumps(body).encode() if body is not None else None,
                                     headers={"Authorization": f"Bearer {_token()}", "Notion-Version": NOTION_VERSION, "Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=60) as f:
                return json.load(f)
        except urllib.error.HTTPError as e:
            # 429 是限速，502/503/504 多半是服务端瞬时故障：按 Retry-After 或递增间隔等待后重试，其余错误直接抛出
            if e.code in (429, 502, 503, 504) and attempt < 8:
                time.sleep(float(e.headers.get("Retry-After") or attempt))
                continue
            raise RuntimeError(f"Notion {e.code} on {method} {path}: {e.read().decode()[:200]}")


def owned_by_user(page):
    """这一行是不是用户定的：勾了「人工」，或者最后修改人是真人"""
    if page.get("properties", {}).get(MANUAL, {}).get("checkbox"):
        return "勾了人工"
    # last_edited_by 只带 id，读一次用户类型（结果缓存）：person 是真人，bot 是网页或本机脚本用的写入连接
    uid = page.get("last_edited_by", {}).get("id")
    if uid and _user_type(uid) == "person":
        return "用户在 Notion 里改过"
    return None


_user_types = {}


def _user_type(uid):
    if uid not in _user_types:
        try:
            _user_types[uid] = api("GET", f"users/{uid}").get("type")
        except RuntimeError:
            _user_types[uid] = "unknown"
    return _user_types[uid]


def snapshot(data_source_id):
    """一次查出整个库的行（每页 100 行），给大批量写入代替逐行 GET；快照之后用户再改的行查不到，所以大批写入前要请用户先停手"""
    pages, cursor = {}, None
    while True:
        r = api("POST", f"data_sources/{data_source_id}/query", {"page_size": 100, **({"start_cursor": cursor} if cursor else {})})
        pages.update((p["id"], p) for p in r["results"])
        if not r.get("has_more"):
            return pages
        cursor = r["next_cursor"]


def update_rows(jobs, workers=WORKERS, pages=None):
    """jobs: [(page_id, properties)]。pages 是 snapshot() 的结果，给了就不逐行 GET。返回 (skipped, failed)：skipped 是 [(page_id, 名称, 原因)]，failed 是 [(page_id, 错误)]"""
    skipped, failed = [], []

    def one(job):
        pid, props = job
        try:
            page = pages[pid] if pages is not None and pid in pages else api("GET", f"pages/{pid}")
            why = owned_by_user(page)
            if why:
                title = next((p for p in page["properties"].values() if p["type"] == "title"), {"title": []})
                skipped.append((pid, "".join(t["plain_text"] for t in title["title"]), why))
                return
            api("PATCH", f"pages/{pid}", {"properties": props})
        except Exception as e:
            failed.append((pid, str(e)))

    with ThreadPoolExecutor(workers) as ex:
        list(ex.map(one, jobs))
    for pid, name, why in skipped:
        print(f"跳过（{why}）：{name} {pid}")
    for pid, err in failed:
        print(f"失败：{pid} {err}")
    print(f"共 {len(jobs)} 行，写了 {len(jobs) - len(skipped) - len(failed)}，跳过 {len(skipped)}，失败 {len(failed)}")
    return skipped, failed
