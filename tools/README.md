# 工具

把你**自己抖音或 X 账号**的关注、喜欢、收藏（X 是书签）导出来，分类后放进 Notion，或者在重新导出后把变化写回 Notion。网页本身不依赖这些工具，Notion 里的数据也可以手动录入或从别处导入。

## 免责说明

- 这些脚本只读取**你本人已登录账号**里你自己能看到的列表（关注、喜欢、收藏），在你自己的浏览器里，用网页版自己发出的同一类请求，按接近手动翻页的节奏运行。它们不破解、不绕过任何访问控制，不读取别人的私密数据，也不对外分发数据。
- 抖音和 X 的网页接口都不是公开 API，随时可能变化或失效；频繁请求可能触发限频，甚至影响账号。是否使用、怎么使用，由你自己判断并承担后果。
- 使用前请阅读并遵守抖音、X 各自的用户协议与当地法律法规。导出的数据只用于个人整理，不要用于商业用途或公开传播他人信息。
- 本项目与抖音、北京字节跳动科技有限公司、腾讯、X Corp.、Notion 均无关联。本软件按「原样」提供，不附带任何担保，详见 [LICENSE](../LICENSE)。

## 各工具

| 文件 | 做什么 |
|---|---|
| `douyin-following-export.js` | 在已登录的 www.douyin.com 页面控制台运行，导出关注列表为 `douyin-following.json`（带每个账号在「最近关注」里的位置与所在页的时间游标） |
| `douyin-likes-export.js` | 同样的方式导出喜欢、收藏、各收藏夹里的视频为 `douyin-likes.json` |
| `x-export.js` | 在已登录的 x.com 书签页控制台运行，导出关注、书签、喜欢为三个 JSON 文件（每项带列表位置，0 是最近的） |
| `classify-prompt.md` | 给博主分类的提示词，交给大模型批量分类 |
| `video-classify-prompt.md` | 给视频分类的提示词 |
| `video-csv.py` | 把导出的视频加分类结果写成 CSV，用 Notion 的「导入 CSV」建「抖音收藏」「抖音喜欢」库 |
| `resync.py` | 目前只支持抖音。重新导出关注列表后，比对 Notion「抖音博主」库：新关注、取关、取关后又关注、资料变化，先生成计划、你确认后再写入 |

## 典型流程

### 第一次导入关注

1. 在已登录的抖音网页打开开发者工具控制台，粘贴 `douyin-following-export.js` 的第一段运行，等进度结束后运行第二段下载 JSON。
2. 用 `classify-prompt.md` 让大模型给账号分类（也可以自己分）。
3. 整理成 CSV 用 Notion 导入，列名照 [docs/notion-schema.md](../docs/notion-schema.md)。

### 第一次导入 X

1. 在已登录的 x.com 打开书签页，等列表出来，在控制台粘贴 `x-export.js` 的第一段运行；`xExport.live.done` 变成 true 后运行第二段，下载三个 JSON 文件。
2. 账号用 `classify-prompt.md`、帖子用 `video-classify-prompt.md` 让大模型分类，分类名可以换成适合 X 的一套。
3. 整理成 CSV 用 Notion 导入，列名照 [docs/notion-schema.md](../docs/notion-schema.md) 的「X 博主」「X 书签与 X 喜欢」两节。`video-csv.py` 是给抖音视频写的，X 的字段不同，要自己整理。

### 以后的更新（抖音）

```bash
export NOTION_WRITE_TOKEN=ntn_...          # 有写入权限的连接
export NOTION_CREATORS_DS=<抖音博主的数据源 ID>
python tools/resync.py plan douyin-following.json plan/
# 按提示逐个核对取关候选，生成 plan/unfollow-check.json
python tools/resync.py confirm plan/
# 给新关注的账号填好 plan/new.tsv 里的分类
python tools/resync.py classify plan/
python tools/resync.py apply plan/
```

写完 Notion 后，到网页上点「从 Notion 同步」。

## 节奏与限频

- 两个抖音导出脚本每页之间停 1.2 到 1.8 秒（喜欢、收藏数量大时建议调到 3 到 4 秒），X 导出脚本停 2 到 3 秒；碰到第一次异常就停，不自动重试。
- 抖音被限频后隔 30 分钟以上再接着取，脚本会从记下的断点继续；X 的脚本不记断点，隔 15 分钟以上重新取一遍。
- 取数期间不要用同一账号在别处大量浏览。
