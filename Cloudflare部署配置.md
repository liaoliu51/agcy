# Cloudflare 部署：Token 权限修复 + 平台选型说明

> 本文档记录 2026-10-18 实测结论。**部署前必读**，能省掉大量踩坑时间。

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

## 三、重建 Token 的正确步骤

1. 打开 https://dash.cloudflare.com/profile/api-tokens
2. 点 **Create Token** → 选 **Edit Cloudflare Workers** 模板（或用 Custom token）
3. **Permissions**（权限）里勾：

   | 权限项 | 权限级别 | 必需原因 |
   |---|---|---|
   | Account → Workers Scripts | Edit | 部署 Worker 代码 |
   | Account → Workers KV Storage | Edit | 自选股持久化（可选，暂不用也可） |
   | Account → Account Settings | Read | 读取账号信息 |

4. **Account Resources**（账号资源）→ 选 **Include → Specific account** →
   **下拉框里必须真正选中 `liaoliu51` 对应的那个账号**（⚠️ 这一步最容易漏，选空就等于没授权）

5. **Zone Resources** → Include → Specific zone → 选你的域名（如果暂时没有域名，选
   `All zones from an account` 亦可）

6. 点 **Create Token** → 立刻复制（只显示一次）

> **如果下拉框里根本列不出任何账号**，说明你的 Cloudflare 账号还没创建任何资源。
> 先随便创建一个 Worker（Hello World 也行）让账号「活」过来，再回来建Token。

---

## 四、拿到新 Token 后的两种用法

### 用法 A：命令行部署（立即可用）

```powershell
# 临时设置，只在当前 PowerShell 会话有效，不落盘
$env:CLOUDFLARE_API_TOKEN = "粘贴你的新Token"

cd D:\QuantHub
npx wrangler deploy
```

配置好 `account_id` 后，wrangler 不再要求交互式登录。

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
2. 新 Token **不要贴在对话里**，只用 `$env:CLOUDFLARE_API_TOKEN` 传递
3. 若想长期免登录，可执行 `wrangler login` 走 OAuth（凭证加密存在
   `%APPDATA%\xdg.config\.wrangler\`，比明文 Token 更安全）：

   ```powershell
   cd D:\QuantHub; npx wrangler login
   ```

---

## 六、已完成的配置

`wrangler.toml` 已写入 `account_id`（你的账号 ID），这是配置文件里唯一需要记录的信息，
**Token 绝不写入文件**。打包已验证通过（107.52 KiB / gzip 27.10 KiB）。

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