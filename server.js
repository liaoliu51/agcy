'use strict';
/**
 * QuantHub —— AI 产业链事件驱动交易框架 · 实时行情与投研工作台
 * 零外部依赖，Node 原生 http 模块
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { fetchQuotes, marketSession } = require('./lib/quotes');
const { fetchNews } = require('./lib/news');
const { buildReport } = require('./lib/analyzer');
const { summarize, summarizeBatch, cfg: summaryCfg } = require('./lib/summary');

const ROOT = __dirname;
const PUBLIC = path.join(ROOT, 'public');
const DATA = path.join(ROOT, 'data');
const PORT = parseInt(process.env.HUB_PORT || '8791', 10);

// —— 加载知识库 ——
const chain = JSON.parse(fs.readFileSync(path.join(DATA, 'chain.json'), 'utf8'));
const mapping = JSON.parse(fs.readFileSync(path.join(DATA, 'mapping.json'), 'utf8'));

// —— 内存缓存 ——
const cache = {
  quotes: { data: [], at: 0 },
  news: { data: [], at: 0, failed: [] },
  report: { data: null, at: 0 },
  watchlist: mapping.defaultWatchlist.slice(),
};

const NEWS_INTERVAL = parseInt(process.env.HUB_NEWS_INTERVAL || '60000', 10); // 60s
const NEWS_ENABLED = process.env.HUB_NEWS !== '0';

const log = (...a) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...a);

/* ---------------- 行情刷新 ---------------- */
async function refreshQuotes() {
  try {
    const list = cache.watchlist;
    const q = await fetchQuotes(list);
    cache.quotes = { data: q, at: Date.now() };
    const ok = q.filter((x) => !x.error).length;
    log(`quotes refreshed: ${ok}/${q.length}`);
  } catch (e) {
    log('quotes error:', e.message);
  }
}

/* ---------------- 资讯刷新 ---------------- */
async function refreshNews() {
  if (!NEWS_ENABLED) return;
  try {
    const { news, failed } = await fetchNews(chain);
    news.__failed = failed;
    cache.news = { data: news, at: Date.now(), failed };
    log(`news refreshed: ${news.length} (tagged ${news.filter((n) => n.tagged).length}), failed sources: ${failed.length}`);
    cache.report.at = 0; // 强制重建报告
  } catch (e) {
    log('news error:', e.message);
  }
}

/* ---------------- 报告构建 ---------------- */
function getReport() {
  const fresh = Date.now() - cache.report.at < 60000;
  if (cache.report.data && fresh) return cache.report.data;
  const r = buildReport(cache.news.data, chain, mapping, cache.quotes.data);
  r.dataQuality.sourceFailure = cache.news.failed;
  cache.report = { data: r, at: Date.now() };
  return r;
}

/* ---------------- 静态文件 ---------------- */
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml' };

function serveStatic(req, res, urlPath) {
  let p = urlPath === '/' ? '/index.html' : urlPath;
  const fp = path.join(PUBLIC, path.normalize(p).replace(/^([/\\])+/, ''));
  if (!fp.startsWith(PUBLIC)) { res.writeHead(403); return res.end('forbidden'); }
  fs.readFile(fp, (err, buf) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(fp)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(buf);
  });
}

function json(res, obj, code = 200) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

/* ---------------- 请求体读取 ---------------- */
function readBody(req, limit = 1e6) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (c) => {
      body += c;
      if (body.length > limit) req.destroy();
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

/* ---------------- 服务 ---------------- */
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://${req.headers.host}`);
  const p = u.pathname;
  const t0 = Date.now();

  try {
    switch (p) {
      case '/api/quotes': {
        const needRefresh = Date.now() - cache.quotes.at > 4000;
        if (needRefresh && cache.quotes.at === 0) await refreshQuotes();
        return json(res, {
          data: cache.quotes.data,
          updatedAt: cache.quotes.at,
          session: marketSession(),
          serverTime: Date.now(),
          costMs: Date.now() - t0,
        });
      }
      case '/api/news': {
        if (cache.news.at === 0) await refreshNews();
        const tag = u.searchParams.get('tag');
        const cat = u.searchParams.get('cat');
        let list = cache.news.data;
        if (tag) list = list.filter((n) => n.layers.some((l) => l.layerId === tag));
        if (cat) list = list.filter((n) => n.category === cat);
        return json(res, { data: list, updatedAt: cache.news.at, failed: cache.news.failed, total: cache.news.data.length });
      }
      case '/api/report': {
        if (cache.news.at === 0) await refreshNews();
        if (cache.quotes.at === 0) await refreshQuotes();
        return json(res, getReport());
      }
      case '/api/chain': {
        return json(res, chain);
      }
      case '/api/watchlist': {
        if (req.method === 'GET') return json(res, { data: cache.watchlist });
        if (req.method === 'POST') {
          let body = '';
          req.on('data', (c) => { body += c; if (body.length > 1e6) req.destroy(); });
          return req.on('end', () => {
            try {
              const j = JSON.parse(body);
              if (Array.isArray(j.list)) {
                const seen = new Set();
                cache.watchlist = j.list.filter((s) => s && s.code && !seen.has(s.code) && seen.add(s.code));
                cache.quotes.at = 0;
                log(`watchlist updated: ${cache.watchlist.length}`);
                return json(res, { ok: true, count: cache.watchlist.length });
              }
              return json(res, { ok: false, error: 'invalid' }, 400);
            } catch (e) { return json(res, { ok: false, error: String(e.message) }, 400); }
          });
        }
        break;
      }
      case '/api/refresh': {
        await Promise.all([refreshQuotes(), refreshNews()]);
        return json(res, { ok: true, quotes: cache.quotes.data.length, news: cache.news.data.length });
      }
      case '/api/summary': {
        if (!summaryCfg().enabled) return json(res, { ok: false, reason: 'not-configured', message: '未配置 AI 接口' });
        const lang = (u.searchParams.get('lang') || 'bi').toLowerCase();
        const body = await readBody(req);
        let item = null;
        try { item = body ? JSON.parse(body) : null; } catch (e) { /* ignore */ }
        if (item && item.url) return json(res, await summarize(item, lang));
        if (item && Array.isArray(item.list)) {
          const limit = Math.min(parseInt(item.limit || '5', 10), 10);
          return json(res, { ok: true, lang, results: await summarizeBatch(item.list, lang, limit) });
        }
        return json(res, { ok: false, reason: 'bad-request' }, 400);
      }
      case '/api/health': {
        return json(res, {
          ok: true,
          quotes: { count: cache.quotes.data.length, at: cache.quotes.at },
          news: { count: cache.news.data.length, at: cache.news.at, failed: cache.news.failed },
          aiSummary: { enabled: summaryCfg().enabled, model: summaryCfg().model || 'auto' },
          session: marketSession(),
          uptimeSec: Math.round(process.uptime()),
        });
      }
      default:
        return serveStatic(req, res, p);
    }
  } catch (e) {
    log('ERR', p, e.stack || e.message);
    return json(res, { error: String(e.message || e) }, 500);
  }
});

server.listen(PORT, '127.0.0.1', async () => {
  log(`QuantHub listening http://127.0.0.1:${PORT}`);
  log(`proxy=${process.env.HUB_USE_PROXY === '1' ? 'ON ' + process.env.HUB_PROXY_PORT : 'OFF'} newsInterval=${NEWS_INTERVAL}ms`);
  await refreshQuotes();
  if (NEWS_ENABLED) {
    refreshNews();
    setInterval(refreshNews, NEWS_INTERVAL);
  }
  setInterval(refreshQuotes, 5000); // 服务端5秒兜底轮询
});

process.on('uncaughtException', (e) => log('UNCAUGHT', e.stack || e.message));