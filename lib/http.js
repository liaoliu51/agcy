'use strict';
/**
 * 运行时自适应网络层 —— 同一份代码跑在 Node.js 与 Cloudflare Workers
 *
 * 设计要点：
 *  - Workers / Node18+ 均有全局 fetch，优先走 fetch（自动处理 https / 重定向 / gzip）
 *  - 老 Node 或 fetch 不可用时回退到原生 http/https 模块
 *  - GBK 解码：Workers 的 TextDecoder 支持完整 ICU，Node 亦同；失败回退 UTF-8
 *  - 代理仅在 Node 侧显式开启时生效（Workers 无代理概念）
 */

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const IS_WORKER = typeof WebSocketPair !== 'undefined' || typeof caches !== 'undefined';
const HAS_FETCH = typeof fetch === 'function';

function env(name, dflt) {
  try {
    // Workers 的 nodejs_compat 会注入 process.env，可能为空对象
    const v = typeof process !== 'undefined' && process.env ? process.env[name] : undefined;
    return v === undefined || v === '' ? dflt : v;
  } catch (e) {
    return dflt;
  }
}

/** GBK / UTF-8 自适应解码，接受 Buffer 或 ArrayBuffer */
function decode(buf, gbk) {
  if (typeof buf === 'string') return buf;
  try {
    return gbk ? new TextDecoder('gbk').decode(buf) : new TextDecoder('utf-8').decode(buf);
  } catch (e) {
    // GBK 解码器不可用 → 按 UTF-8 读，数字与结构字段仍然正确
    return new TextDecoder('utf-8').decode(buf);
  }
}

/** fetch 路径 */
async function viaFetch(url, { referer, gbk, timeout }) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      redirect: 'follow',
      headers: {
        'User-Agent': UA,
        'Referer': referer || 'https://finance.sina.com.cn/',
        'Accept': '*/*',
        'Accept-Language': 'zh-CN,zh;q=0.9',
      },
    });
    const buf = await res.arrayBuffer();
    return decode(buf, gbk);
  } finally {
    clearTimeout(timer);
  }
}

/** 原生 http/https 路径（仅 Node） */
function viaNodeHttp(url, { referer, gbk, timeout }) {
  // 惰性 require：Workers 打包器会静态扫描顶层 require('http') 并判为非法外部依赖，
  // 放进函数体内使其只在 Node 分支执行，打包时不会命中。
  const http = require('node:http');
  const https = require('node:https');
  const t = new URL(url);
  const isHttps = t.protocol === 'https:';
  const proxyPort = env('HUB_PROXY_PORT', '');
  const useProxy = env('HUB_USE_PROXY', '0') === '1' && proxyPort;

  const o = {
    hostname: t.hostname,
    port: t.port || (isHttps ? 443 : 80),
    path: t.pathname + t.search,
    method: 'GET',
    headers: { 'User-Agent': UA, Referer: referer || 'https://finance.sina.com.cn/', Accept: '*/*' },
    timeout,
    rejectUnauthorized: false,
  };
  if (useProxy) {
    o.hostname = '127.0.0.1';
    o.port = proxyPort;
    o.path = url;
    o.headers.Host = t.host;
  }

  return new Promise((resolve, reject) => {
    const mod = isHttps ? https : http;
    const req = mod.request(o, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        const next = new URL(res.headers.location, url).toString();
        return httpGet(next, { referer, gbk, timeout }).then(resolve, reject);
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(decode(Buffer.concat(chunks), gbk)));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end();
  });
}

/**
 * 统一 GET，返回文本
 * @param {string} url
 * @param {{referer?:string, gbk?:boolean, timeout?:number}} opts
 */
function httpGet(url, opts = {}) {
  const o = {
    referer: opts.referer,
    gbk: !!opts.gbk,
    timeout: opts.timeout || 15000,
  };
  if (HAS_FETCH) {
    return viaFetch(url, o).catch((e) => (IS_WORKER ? Promise.reject(e) : viaNodeHttp(url, o)));
  }
  return viaNodeHttp(url, o);
}

/** 行情专用封装（GBK） */
function fetchRaw(url, opts = {}) {
  return httpGet(url, { referer: 'https://gu.qq.com/', gbk: true, timeout: opts.timeout || 12000 });
}

module.exports = { httpGet, fetchRaw, decode, IS_WORKER, HAS_FETCH };