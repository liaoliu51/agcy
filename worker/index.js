'use strict';
/**
 * QuantHub —— Cloudflare Worker 入口
 *
 * 与server.js 共用同一套 lib/ 逻辑（行情解析 / 资讯聚合 / 规则引擎）。
 * 静态资源通过 Workers Assets 绑定（wrangler.toml的 [assets]）直接托管，
 * Worker 只负责 /api/* 路由。
 *
 * 运行时约束与对策：
 *  1. 无文件系统→ chain.json / mapping.json 通过 import 静态引入（Wrangler 打包期内联）
 *  2. 无常驻进程     → 用「请求触发 + 内存 TTL 缓存」，并用 Cache API 做跨请求共享
 *  3. 无 Node http    → lib/http.js 已改为 fetch 优先
 *  4. 出口 IP 在境外  → 腾讯/新浪/同花顺/东财可能不通，/api/health 会如实报告，
 *                       前端据此自动降级为「浏览器直连腾讯行情 + script 注入」模式
 */

const { fetchQuotes, marketSession } = require('../lib/quotes');
const { fetchNews } = require('../lib/news');
const { buildReport } = require('../lib/analyzer');

const chain = require('../data/chain.json');
const mapping = require('../data/mapping.json');

/* ---------------- 缓存 ---------------- */
const QUOTES_TTL = 4000;   // 5秒刷新要求 → 服务端 4s 兜底
const NEWS_TTL = 60000;    // 资讯 60s

const state = {
  quotes: { data: [], at: 0 },
  news: { data: [], at: 0, failed: [] },
  report: { data: null, at: 0 },
  watchlist: mapping.defaultWatchlist.slice(),
  inflight: {},
};

async function refreshQuotes() {
  try {
    const q = await fetchQuotes(state.watchlist);
    state.quotes = { data: q, at: Date.now() };
  } catch (e) {
    state.quotes.err = String(e.message || e);
  }
  return state.quotes;
}

async function refreshNews() {
  try {
    const { news, failed } = await fetchNews(chain);
    news.__failed = failed;
    state.news = { data: news, at: Date.now(), failed };
    state.report.at = 0;
  } catch (e) {
    state.news.err = String(e.message || e);
  }
  return state.news;
}

/** 单飞：并发请求只触发一次上游抓取 */
function single(key, fn) {
  if (!state.inflight[key]) {
    state.inflight[key] = fn().finally(() => { delete state.inflight[key]; });
  }
  return state.inflight[key];
}

function ensureQuotes() {
  if (Date.now() - state.quotes.at > QUOTES_TTL) return single('q', refreshQuotes);
  return Promise.resolve(state.quotes);
}

function ensureNews() {
  if (Date.now() - state.news.at > NEWS_TTL) return single('n', refreshNews);
  return Promise.resolve(state.news);
}

function getReport() {
  if (state.report.data && Date.now() - state.report.at < 60000) return state.report.data;
  const r = buildReport(state.news.data, chain, mapping, state.quotes.data);
  r.dataQuality.sourceFailure = state.news.failed;
  state.report = { data: r, at: Date.now() };
  return r;
}

/* ---------------- 响应工具 ---------------- */
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function json(obj, code = 200, extra = {}) {
  return new Response(JSON.stringify(obj), {
    status: code,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...CORS, ...extra },
  });
}

/* ---------------- 路由 ---------------- */
async function handleApi(pathname, search, request) {
  const t0 = Date.now();

  if (pathname === '/api/quotes') {
    await ensureQuotes();
    return json({
      data: state.quotes.data,
      updatedAt: state.quotes.at,
      session: marketSession(),
      serverTime: Date.now(),
      costMs: Date.now() - t0,
      err: state.quotes.err,
    });
  }

  if (pathname === '/api/news') {
    await ensureNews();
    const tag = search.get('tag');
    const cat = search.get('cat');
    let list = state.news.data;
    if (tag) list = list.filter((n) => n.layers.some((l) => l.layerId === tag));
    if (cat) list = list.filter((n) => n.category === cat);
    return json({ data: list, updatedAt: state.news.at, failed: state.news.failed, total: state.news.data.length });
  }

  if (pathname === '/api/report') {
    await Promise.all([ensureNews(), ensureQuotes()]);
    return json(getReport());
  }

  if (pathname === '/api/chain') {
    return json(chain);
  }

  if (pathname === '/api/watchlist') {
    if (request.method === 'GET') return json({ data: state.watchlist });
    if (request.method === 'POST') {
      const j = await request.json().catch(() => null);
      if (j && Array.isArray(j.list)) {
        const seen = new Set();
        state.watchlist = j.list.filter((s) => s && s.code && !seen.has(s.code) && seen.add(s.code));
        state.quotes.at = 0;
        return json({ ok: true, count: state.watchlist.length });
      }
      return json({ ok: false, error: 'invalid' }, 400);
    }
  }

  if (pathname === '/api/refresh') {
    await Promise.all([refreshQuotes(), refreshNews()]);
    return json({ ok: true, quotes: state.quotes.data.length, news: state.news.data.length });
  }

  if (pathname === '/api/health') {
    return json({
      ok: true,
      runtime: 'cloudflare-worker',
      quotes: { count: state.quotes.data.length, at: state.quotes.at, err: state.quotes.err },
      news: { count: state.news.data.length, at: state.news.at, failed: state.news.failed, err: state.news.err },
      session: marketSession(),
    });
  }

  return json({ error: 'not found' }, 404);
}

module.exports = {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const p = url.pathname;

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

    if (p.startsWith('/api/')) {
      try {
        return await handleApi(p, url.searchParams, request);
      } catch (e) {
        return json({ error: String(e.message || e), stack: String(e.stack || '').split('\n').slice(0, 4) }, 500);
      }
    }

    // 非 API 路径交给 Assets（index.html / app.js / app.css）
    if (env && env.ASSETS && typeof env.ASSETS.fetch === 'function') {
      return env.ASSETS.fetch(request);
    }
    return new Response('QuantHub Worker: assets binding not configured', { status: 404 });
  },
};