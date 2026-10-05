# 安全说明

## 设计上的保护

- 整站放在 Cloudflare Access 后面；Worker 的读数据、写入、查同步进度接口还会再核验一次 Access 签发的登录凭证（签名、受众、签发方、有效期、允许的邮箱），Access 配置出错放开时也读不到、写不进。
- 写入接口只接受本站页面发来的 JSON 请求（核对 Origin），并先确认要改的行属于对应的数据库，再写 Notion。
- 密钥只放在 Cloudflare 的 Worker 密钥与 GitHub 仓库 Secrets 里，不写进任何文件：Notion 写入令牌、GitHub App 私钥只给 Worker，Notion 只读令牌只给同步任务。
- GitHub App 只装在你自己的仓库上，权限只有 Actions 读写、Contents 只读。

## 部署时请注意

- 用模板生成的仓库一定要设成**私有**，数据文件会提交进去。
- 不要把 `.dev.vars`、私钥文件、令牌提交进仓库。
- 令牌泄露时，到 Notion 的连接设置里重新生成，GitHub App 私钥在 App 页面删除旧的、生成新的，再用 `npx wrangler secret put` 换掉。

## 报告问题

发现安全问题请不要开公开 Issue，通过 GitHub 的「Report a vulnerability」（Security 标签页）私下报告。
