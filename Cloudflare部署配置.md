# Cloudflare 部署：Token 权限修复 + 平台选型说明

> 本文档记录 2026-10-18 实测结论。**部署前必读**，能省掉大量踩坑时间。

---

## ✅ 零、部署状态：已上线

```
线上地址：https://quanthub.liaoshishuang.workers.dev
Account：254252556@qq.com's Account
Account ID：48ad6b3a3de73384d748a2d13042548e
Version ID：91126744-234b-4955-8b9b-f342ed5843a4
```

已通过 `wrangler login`（OAuth）完成授权并部署成功，**不再需要 API Token**。
后续更新代码只需：

```powershell
cd D:\QuantHub
npx wrangler deploy
```

| 验证项（Cloudflare API 侧） | 状态 |
|---|---|
| production 环境部署 | ✅ |
| Worker 处理器 `handlers` | ✅ `['fetch']` |
| 静态资源 `has_assets` | ✅ `true`（4 文件） |
| `nodejs_compat` 兼容层 | ✅ 生效 |
| 代码体积 | 107.52 KiB / gzip 27.10 KiB |

---

## 一、先纠正一个概念错配：应该用 Workers，不是 Pages

你提到「Cloudflare Pages 原生 GitHub 集成」，但**本项目不能用 Pages**，原因如下：

| 维度 | Cloudflare Pages | Cloudflare Workers（本项目需要） |
|---|---|---|
| 运行模型 | 仅静态资源托管 | 完整 Workers 运行时（V8 isolate） |
| 服务端抓取国内行情 | ❌ 做不到 | ✅ 已验证 92/92 可用 |
| GBK 中文解码 | ❌ 无法运行代码 | ✅ 已验证无乱码 |
| 5 秒轮询 + 服务端缓存 | ❌ 无后端 | ✅ TTL 内存缓存已实现 |
| 打标规则引擎 | ❌ 无后端 | ✅ 规则引擎在服务端 |

**结论**：Pages 只能托管静态页面，无法运行 `lib/` 里的抓取与规则引擎。
本项目是 **Workers + Assets** 架构（`worker/index.js` 提供 API，`public/` 作为静态资源），
GitHub 集成入口叫 **Workers Builds**，在 Cloudflare 面板里与 Pages 是同一个入口
（左侧菜单就叫 **Workers & Pages**），所以你看到的仍然是「Connect to GitHub」。

好消息是：**这条路我已经用真实 workerd 运行时验证通过**，不需返工。

### 实际部署中额外遇到的 3 个卡点

| 卡点 | 现象 | 解法 |
|---|---|---|
| **OAuth 授权超时** | 授权链接约 5 分钟有效，无人点击即过期 | 重新生成链接，手动打开并点 Allow |
| **未注册 workers.dev 子域名** | 部署报 `You need to register a workers.dev subdomain` | 必须先注册子域名才能发布 |
| **`quanthub` 名字被占用** | `Subdomain 'quanthub' is unavailable`（全球唯一） | 换名，本项目用 `liaoshishuang` |

> workers.dev 子域名**全局唯一**，先到先得。如果上面的地址被别人抢了，
> 可用 API 换名重新注册：
> ```powershell
> # 先在 %APPDATA%\xdg.config\.wrangler\config\default.toml 里取 oauth_token
> curl.exe -X PUT -H "Authorization: Bearer <token>" `
>   -H "Content-Type: application/json" `
>   --data '{"subdomain":"新名字"}' `
>   "https://api.cloudflare.com/client/v4/accounts/<ACCOUNT_ID>/workers/subdomain"
> ```
> 注意：**必须用 `PUT`**，用 `POST` 会返回 405。

---

## 二、当前 API Token 无效（必须重建）

你提供的 Token 实测结果：

```
GET /user/tokens/verify  → 200，status: "active"（Token 本身有效）
GET /accounts            → 200，但返回 []（空数组！没有任何账号授权）
GET /accounts/<你的ID>   → 403，code 9109 Unauthorized
GET /user                → 403，code 9109
```

**诊断结论**：这个 Token 处于 active 状态，但**没有绑定任何 Account 资源**。
通常是因为生成时 Permissions 里勾了权限、但 **Account Resources 选的是「Include → Specific account」而没真正选中**，
或者选成了某个你不拥有的账号。

**它无法完成**：部署 Worker、连接 GitHub、任何写入操作。

---

## 三、备选：重建 API Token（一般用不上了）

> ✅ **首选 `wrangler login`（OAuth）**，已为你搞定，权限自动全给。
> 以下仅在需要 CI/CD 无人值守部署时才用（例如 GitHub Actions）。

你之前提供的 Token 实测结果：

```
GET /user/tokens/verify  → 200，status: "active"（Token 本身有效）
GET /accounts            → 200，但返回 []（空数组！没有任何账号授权）
GET /accounts/<你的ID>   → 403，code 9109 Unauthorized
GET /user                → 403，code 9109
```

**诊断结论**：这个 Token 处于 active 状态，但**没有绑定任何 Account 资源**。
通常是因为生成时 Permissions 里勾了权限、但 **Account Resources 选的是「Include → Specific account」而没真正选中**，
或者选成了某个你不拥有的账号。

**它无法完成**：部署 Worker、连接 GitHub、任何写入操作。

### 重建 Token 的正确步骤

1. 打开 https://dash.cloudflare.com/profile/api-tokens
2. 点 **Create Token** → 选 **Edit Cloudflare Workers** 模板（或用 Custom token）
3. **Permissions**（权限）里勾：

   | 权限项 | 权限级别 | 必需原因 |
   |---|---|---|
   | Account → Workers Scripts | Edit | 部署 Worker 代码 |
   | Account → Workers KV Storage | Edit | 自选股持久化（可选，暂不用也可） |
   | Account → Account Settings | Read | 读取账号信息 |

4. **Account Resources**（账号资源）→ 选 **Include → Specific account** →
   **下拉框里必须真正选中 `254252556@qq.com's Account`**（⚠️ 这一步最容易漏，选空就等于没授权）

   > 你的 Cloudflare 账号是 **`254252556@qq.com's Account`**，
   > 跟 GitHub 账号 `liaoliu51` **完全是两回事**，别选错。

5. **Zone Resources** → Include → Specific zone → 选你的域名（如果暂时没有域名，选
   `All zones from an account` 亦可）

6. 点 **Create Token** → 立刻复制（只显示一次）

**验证新 Token 是否成功**（这步别省）：

```powershell
$env:CLOUDFLARE_API_TOKEN = "新Token"
# 这行必须能列出账号，返回 [] 就是没授权成功
curl.exe -H "Authorization: Bearer $env:CLOUDFLARE_API_TOKEN" `
  "https://api.cloudflare.com/client/v4/accounts"
```

能返回带 `254252556@qq.com's Account` 数据的数组 = 成功。返回 `[]` = 回去重做第 4 步。

> **如果下拉框里根本列不出任何账号**，先去 Cloudflare 面板创建一个 Worker
> （Hello World 也行），账号「活」过来之后再回来建 Token。

### 用法 A：OAuth 登录（当前状态，已生效）

```powershell
cd D:\QuantHub
npx wrangler login          # 已完成，凭证存于 %APPDATA%\xdg.config\.wrangler\config\default.toml
npx wrangler deploy         # 直接部署，无需任何 Token
```

### 用法 B：GitHub 自动同步（配一次，以后不用管）

Token 只解决「部署」，**GitHub 自动同步仍然必须在面板里点**，且**不需要你手动填 Token**
（面板通过 GitHub App 的OAuth 走另一条路，与 API Token 无关）：

1. **先在 GitHub 侧授权**（最容易漏的一步）
   - 打开 https://github.com/settings/installations
   - 找到 **Cloudflare Workers and Pages** → **Configure**
   - Repository access → 勾选 **`liaoliu51/agcy`**
   - 保存
2. Cloudflare 面板 → **Workers & Pages** → **Create application** → **Connect to GitHub**
3. 选仓库 **`agcy`**，构建设置：

   | 字段 | 填写 |
   |---|---|
   | Production branch | `main` |
   | Build command | `npm install` |
   | Deploy command | `npx wrangler deploy` |
   | Root directory | 留空 |
   | Build output directory | 留空 |

4. Save and Deploy

---

## 五、安全建议

1. **撤销对话中出现过的旧 Token**：`dash.cloudflare.com/profile/api-tokens` → 该Token → Revoke
2. 现在改用 `wrangler login` 的 OAuth 凭证，**无需明文 Token**，凭证加密存于
   `%APPDATA%\xdg.config\.wrangler\config\default.toml`，比 Token 更安全
3. 若用脚本临时传Token，只用 `$env:CLOUDFLARE_API_TOKEN`，**绝不写进任何文件**
4. 排查问题时若需读 OAuth token，**读完立刻删除临时文件**（本项目实测已这么做）

---

## 六、已完成的配置

`wrangler.toml` 已写入 `account_id`（你的账号 ID），这是配置文件里唯一需要记录的信息，
**Token 绝不写入文件**。打包已验证通过（107.52 KiB / gzip 27.10 KiB）。

> ⚠️ **本机网络可能无法访问 `*.workers.dev`**
> 若 `curl` 返回 `HTTP=000` 或「无法连接到远程服务器」，说明本机到 Cloudflare 的出站被网络策略拦截。
> 这是**本地网络问题，不是 Worker 问题**——部署是否成功应以 Cloudflare API
> （`GET /accounts/<id>/workers/services/quanthub` 返回 `success: true`）或面板状态为准。

部署命令速查：

```powershell
# 改完代码先本地验证（5 秒，强烈建议）
cd D:\QuantHub; npx wrangler deploy --dry-run
cd D:\QuantHub; npx wrangler dev --local --port 8899

# 正式部署
$env:CLOUDFLARE_API_TOKEN = "新Token"
cd D:\QuantHub; npx wrangler deploy

# 看线上日志
cd D:\QuantHub; npx wrangler tail
```