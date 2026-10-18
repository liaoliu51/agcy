# QuantHub

**AI 产业链事件驱动交易框架 · 实时行情与投研工作台**

基于自建的七层产业链框架 + 规则引擎，实时抓取 A股/港股/美股行情与财经快讯，输出可追溯的投资分析日报。

---

## 能力

| 模块 | 说明 |
|---|---|
| **行情** | 腾讯自选股接口，A股/港股/美股/指数共 92 只默认标的，5 秒刷新，含 PE/PB/换手/振幅/市值 |
| **资讯** | 新浪7×24、新浪滚动、同花顺、东方财富 四源聚合，每 60 秒抓取，GBK 自动解码 |
| **产业链框架** | 八层结构（能源→机房→液冷→芯片→互联→存储→模型→应用）+ 三条传导链+ 10 个科技标签 |
| **规则引擎** | 关键词 × 产业链层 × 标的 三维匹配，每条结论可追溯到具体命中词，无黑盒 |
| **日报** | 五段式输出：核心约束 / 一致预期 / 活跃层与休眠层 / 传导链状态 / 交易建议与风险 |
| **双运行时** | 同一份 `lib/` 代码同时跑在 Node.js 与 Cloudflare Workers |
| **自动降级** | 后端取不到国内行情时，前端自动切「浏览器直连腾讯行情」模式，功能不降级 |

---

## 目录结构

```
Quanthub/
├── lib/                # 核心逻辑（Node 与 Workers 共用）
│   ├── http.js         #   运行时自适应网络层（fetch 优先，Node http 回退）
│   ├── quotes.js       #   腾讯行情解析（A股/港股/美股/指数）
│   ├── news.js         #   四源资讯聚合 + 产业链打标
│   ├── analyzer.js     #   规则引擎 → 投资分析日报
│   └── data/           #   知识库：chain.json（框架）+ mapping.json（标的映射）
├── worker/index.js     # Cloudflare Worker 入口
├── public/             # 前端单页应用（零构建，原生 JS）
│   ├── index.html
│   ├── app.js# 主逻辑 + 5s 轮询 + 省流降频
│   ├── direct.js       #   浏览器直连降级层
│   └── app.css
├── server.js           # 本地 Node 服务（监听 127.0.0.1:8791）
├── wrangler.toml       # Cloudflare 部署配置
├── start_hub.bat       # Windows 一键启动
└── stop_hub.bat
```

**扩展框架只需改 `data/chain.json` 与 `data/mapping.json`，代码零改动。**

---

## 本地运行

```bash
node server.js
# 打开 http://127.0.0.1:8791
```

可选环境变量：

| 变量 | 默认 | 说明 |
|---|---|---|
| `HUB_PORT` | 8791 | 监听端口 |
| `HUB_NEWS` | 1 | 设为 `0` 关闭资讯抓取 |
| `HUB_NEWS_INTERVAL` | 60000 | 资讯抓取间隔（ms） |
| `HUB_USE_PROXY` | 0 | 设为 `1` 走 HTTP 代理 |
| `HUB_PROXY_PORT` | — | 代理端口，如 7897 |

---

## 部署到 Cloudflare Workers

代码仓库：https://github.com/liaoliu51/agcy （private，分支 `main`）
Cloudflare Account ID 已写入 `wrangler.toml`。

> 📌 **首次部署前请先读 `Cloudflare部署配置.md`** —— 内含实测结论：
> ① 本项目必须用 **Workers**（不能用 Pages，Pages 无法运行抓取与规则引擎）
> ② GitHub 自动同步的 GitHub App 授权前置步骤
> ③ API Token 权限配置的踩坑诊断

**推荐方式：GitHub 自动同步**（配一次，以后 `git push` 即自动部署）

1. 先在 https://github.com/settings/installations 给 **Cloudflare Workers and Pages** 授权 `agcy` 仓库
   （App 默认只认`Only select repositories`，不加进去 Cloudflare 面板看不到该仓库）
2. Cloudflare 面板 → Workers & Pages → Create application → **Connect to GitHub** → 选 `agcy`
3. 构建设置：生产分支 `main`｜Build command `npm install`｜Deploy command `npx wrangler deploy`｜Root directory 留空

**备选：命令行部署**

```bash
npm install
npx wrangler login
npx wrangler deploy
```

**本地验证（改完代码先跑，能提前发现部署问题）**

```bash
npx wrangler deploy --dry-run      # 只验证打包，5 秒出结果
npx wrangler dev --local --port 8899   # 真实 workerd 运行时，最严格
```

> **关于国内数据源**：Cloudflare Workers 出口 IP 在境外，可能无法访问腾讯/新浪等国内接口。
> 此时前端会自动切换到「浏览器直连模式」—— 行情由用户浏览器直连腾讯自选股（script 注入 + 浏览器原生 GBK 解码，绕开 CORS），**功能完全一致**。
> 资讯与日报依赖服务端抓取，若境外出口不通则该两页数据为空。
> 访问 `/api/health` 可查看各源实际连通情况。

> **已验证**：真实 workerd 运行时下，行情 92/92（228ms，GBK 中文名解码正确）、资讯 120 条四源零失败、日报三段传导链全部识别、静态资源全部 200。

---

## 数据源

**行情**：qt.gtimg.cn（腾讯自选股）
**资讯**：zhibo.sina.com.cn、feed.mix.sina.com.cn、news.10jqka.com.cn、np-listapi.eastmoney.com

---

## 免责声明

本项目为个人研究与技术实践工具，所有输出均由规则引擎基于公开资讯自动生成，**不构成任何投资建议**。投资有风险，决策需独立判断。