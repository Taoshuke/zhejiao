# 部署指南

整套部署用到四样东西：Notion（放数据）、GitHub（放代码与数据文件、跑同步任务）、Cloudflare Workers（网页与接口）、Cloudflare Access（登录）。免费额度都够个人使用。

下面的「仓库」都指你用模板生成的那个**私有**仓库。

## 1. 生成私有仓库

在本仓库页面点「Use this template」→「Create a new repository」，可见性选 **Private**。克隆到本机。

## 2. Notion

1. 按 [notion-schema.md](notion-schema.md) 建好要用的数据库。不用的平台可以不建，相应地在 `src/platforms.mjs` 里删掉那一项。
   - 抖音的关注、喜欢、收藏，X 的关注、书签、喜欢，都可以用 `tools/` 里的脚本导出后导入，见 [tools/README.md](../tools/README.md)。
2. 在 <https://www.notion.so/profile/integrations> 建两个内部连接：
   - **只读连接**：权限只勾「读取内容」，给同步任务用。
   - **写入连接**：勾「读取内容」「更新内容」「插入内容」，给 Worker 用（网页上的改分类、标星、收藏夹等）。
3. 打开放这些数据库的 Notion 页面，「…」→「连接」，把两个连接都加上（子页面与数据库会一起继承）。
4. 逐个打开数据库，「…」→「复制数据源 ID」，填进 `src/platforms.mjs` 的 `DATABASES`。
5. 可选：把博主数据库的链接填进 `public/app.html` 的 `DB_URL`，空状态里会出现「打开数据库」按钮。

## 3. GitHub

1. 仓库「Settings → Secrets and variables → Actions」新建 Secret：`NOTION_TOKEN`，值是**只读连接**的令牌（`ntn_` 开头）。
2. 建一个 GitHub App（「Settings → Developer settings → GitHub Apps → New GitHub App」）：
   - Webhook 不勾；
   - 仓库权限：**Actions** 读写，**Contents** 只读，其余不给；
   - 建好后记下 **App ID**，在页面底部「Generate a private key」下载私钥（`.pem`）。
3. 在 App 页面「Install App」，只装到你的这个仓库。装好后浏览器地址里 `installations/` 后面的数字就是 **安装 ID**。

Worker 用这个 App 的安装令牌启动同步任务、读仓库里的数据文件、查同步进度。令牌一小时有效，Worker 自己换新的。

## 4. Cloudflare

需要一个托管在 Cloudflare 上的域名。

1. 改 `wrangler.jsonc`：
   - `routes` 的 `pattern` 和 `vars.HOST` 都写成你要用的子域名，比如 `zhejiao.example.com`；
   - `vars.GITHUB_REPO` 写 `你的用户名/仓库名`；
   - `GITHUB_APP_ID`、`GITHUB_APP_INSTALLATION_ID` 填上一步记下的两个数字。
2. **Access（登录）**：Cloudflare 后台「Zero Trust → Access → Applications → Add an application → Self-hosted」：
   - 目标填你的子域名，路径留空（整个域名都保护）；
   - 策略选 Allow，规则写你的邮箱；登录方式用默认的邮箱验证码即可，也可以接 Google 等身份提供商；
   - 建好后在应用的「Overview」里复制 **Application Audience (AUD) Tag**，填进 `vars.ACCESS_AUD`；
   - `vars.ACCESS_TEAM_DOMAIN` 填 `你的团队名.cloudflareaccess.com`（Zero Trust「Settings → Custom pages」可以看到团队名），`vars.ACCESS_EMAIL` 填你的邮箱。
3. **密钥**（不要写进任何文件）：

   ```bash
   npx wrangler secret put NOTION_WRITE_TOKEN        # 粘贴写入连接的令牌
   npx wrangler secret put GITHUB_APP_PRIVATE_KEY < 你的私钥.pem
   ```

   私钥是多行的，用重定向从文件读入，别在终端里粘贴。

4. **部署**，二选一：
   - **自动部署（推荐）**：Workers 后台「Create → Import a repository」连上你的仓库，构建命令留空、部署命令 `npx wrangler deploy`。在「Settings → Build → Build watch paths」的排除路径里加 `public/data/**`，同步任务提交数据时就不会触发部署。以后推送代码即部署。
   - **本机部署**：`node scripts/deploy.mjs`（本机有未提交改动或和远端不一致时会拒绝部署）。

## 5. 第一次同步

打开 `https://你的子域名/`，经 Access 登录后，进到每个平台的页面，点侧栏底部「从 Notion 同步」。同步任务读完 Notion、提交数据文件后，网页会自动刷新。

之后：
- 网页上的改动会自动写回 Notion，并只把改了的几行同步回网页；
- 在 Notion 里直接改的东西，要再点一次「从 Notion 同步」才会进网页。

## 本机调试

```bash
node scripts/demo-data.mjs          # 生成演示数据到 public/data/（不会被提交）
python -m http.server 8080 -d public
```

静态服务器没有 Worker 的路由，平台页从 `/app.html` 进，刷新 `/douyin` 这类地址会 404。要完整的路由用 `npx wrangler dev --var HOST:`（把 HOST 置空，本机不检查域名）；本机没有 Access 登录凭证，读数据接口会被拒，页面会自动退回读 `public/data/` 里的文件。

## 加一个平台

1. `src/platforms.mjs`：`NAMES` 里加英文名与中文名，`DATABASES` 里填它的数据源 ID；
2. `public/app.html`：`PLATFORM_LIST` 与 `ENABLED` 跟着改；
3. `public/index.html`：`PLATS` 里给它配色，首页卡片上的几个数字在 `platCard` 里按平台写；
4. 结构和抖音一样（博主、收藏、喜欢）的平台可以直接复用现有的页面与同步脚本，X 就是这样接进来的，页面上的叫法差异见 `app.html` 里的 `isX`；
5. 数据结构与现有平台不同时（比如微信），参照 `scripts/sync-wechat.mjs` 写一个同步脚本，并在工作流里加一步。

用不到某个平台时，把它从 `DATABASES` 和 `ENABLED` 里删掉，首页 `PLATS` 里它的配色改成 `null`，卡片就会显示为未接入。

## 出问题时

- 网页侧栏标红「备用数据」：Worker 暂时读不到仓库，显示的是缓存或部署时打包的那份。检查 GitHub App 是否还装在仓库上、私钥是否正确。
- 同步失败：网页会提示出错的步骤名，到仓库的 Actions 页面看那次运行的日志。最常见的是只读连接没被加到数据库所在的页面上。
- Workers Logs 已在 `wrangler.jsonc` 里打开，可以在 Cloudflare 后台回查请求。
