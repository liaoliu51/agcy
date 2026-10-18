'use strict';
/**
 * AI 摘要模块 —— 基于 OpenAI 兼容接口生成新闻摘要（双语模式）
 *
 * 站点配置通过环境变量注入，绝不写入代码库：
 *   AI_API_BASE   形如 https://api.wenwen.dev/v1
 *   AI_API_KEY    接口密钥
 *   AI_MODEL      模型名（可留空，由服务端自动选择）
 *
 * 双语模式：
 *   zh   仅中文摘要
 *   bi   中英双语摘要（默认，英文单独一段，便于外盘对照）
 *   en   仅英文摘要
 *
 * 设计要点：
 *  - 纯fetch 实现，Node 与 Cloudflare Workers 双运行时通用（lib/http.js已封装）
 *  - 内置 60秒 TTL 缓存 + 单飞去重，防止资讯轮询把接口打爆
 *  - 失败不抛错，返回 {ok:false, reason}，前端据此显示「摘要不可用」，不影响主流程
 */

const { httpGet } = require('./http');

const TTL = parseInt(process.env.QH_SUMMARY_TTL || '60000', 10);
const TIMEOUT = parseInt(process.env.QH_SUMMARY_TIMEOUT || '45000', 10);

function cfg() {
  const base = (process.env.AI_API_BASE || '').replace(/\/+$/, '');
  const key = process.env.AI_API_KEY || '';
  // key 仅要求非空，不强制 sk- 前缀（部分网关自定义前缀）
  return { base, key, model: process.env.AI_MODEL || '', enabled: !!(base && key) };
}

/* ---------------- 缓存 ---------------- */
const cache = new Map(); // url -> { at, data }
const inflight = new Map();

function cacheGet(key) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL) return hit.data;
  return null;
}

function cacheSet(key, data) {
  cache.set(key, { at: Date.now(), data });
  // 简单上限，避免长会话内存无限增长
  if (cache.size > 300) {
    const oldest = [...cache.entries()].sort((a, b) => a[1].at - b[1].at).slice(0, 100);
    for (const [k] of oldest) cache.delete(k);
  }
}

/* ---------------- 提示词 ---------------- */
function buildPrompt(item, lang) {
  const title = String(item.title || '').slice(0, 200);
  const summary = String(item.summary || '').slice(0, 1200);
  const layers = (item.layers || []).map((l) => l.layerName).join('、');
  const source = item.source || '';
  const time = item.timeStr || '';

  const ctx = [
    `标题：${title}`,
    summary ? `正文摘要：${summary}` : '',
    layers ? `所属AI 产业链层级：${layers}` : '',
    source ? `来源：${source}` : '',
    time ? `时间：${time}` : '',
  ].filter(Boolean).join('\n');

  if (lang === 'zh') {
    return `你是一名 A 股科技投资研究分析师。请为下面这条财经快讯写一段中文摘要。

要求：
1. 先用一句话说清「发生了什么」，含关键主体与关键数字
2. 再用1-2 句说清「对 AI 产业链/相关标的影响方向」，利好/利空/中性要明确
3. 不超过 160 字，不加标题、不用markdown 符号
4. 原文若未提供足够信息，只描述已知事实，不臆测

${ctx}`;
  }

  if (lang === 'en') {
    return `You are an equity research analyst covering the AI supply chain. Write a concise English summary of the news item below.

Requirements:
1. First sentence: what happened, with key entities and figures
2. Then 1-2 sentences: directional impact on the AI supply chain (bullish / bearish / neutral)
3. Under 160 characters, no headline, no markdown
4. Do not speculate beyond the source

${ctx}`;
  }

  // 双语
  return `你是一名 A 股科技投资研究分析师。请为下面这条财经快讯写摘要，**先中文后英文**。

格式要求（严格遵守）：
【中文】一句话说清发生了什么（含关键主体与数字），再用 1-2 句说明对 AI 产业链/相关标的影响方向（利好/利空/中性需明确）。中文不超过 150 字。

【English】One sentence on what happened (key entities and figures), then 1-2 sentences on the directional impact on the AI supply chain (bullish/bearish/neutral). Under 150 characters.

其他要求：不加其他小标题，不用 markdown 符号；原文信息不足时只描述已知事实，不臆测。

${ctx}`;
}

/* ---------------- 调用接口 ---------------- */
// httpGet 仅支持 GET，这里需要 POST，故单独实现（保持 Node / Workers 双运行时）
async function postJson(url, payload, headers) {
  if (typeof fetch === 'function') {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT);
    try {
      const res = await fetch(url, {
        method: 'POST',
        signal: ctrl.signal,
        headers,
        body: JSON.stringify(payload),
      });
      const text = await res.text();
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
      return JSON.parse(text);
    } finally {
      clearTimeout(timer);
    }
  }
  // Node 回退
  const https = require('node:https');
  const http = require('node:http');
  const u = new URL(url);
  const mod = u.protocol === 'https:' ? https : http;
  const data = JSON.stringify(payload);
  return new Promise((resolve, reject) => {
    const req = mod.request({
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      method: 'POST',
      headers: { ...headers, 'Content-Length': Buffer.byteLength(data) },
      timeout: TIMEOUT,
      rejectUnauthorized: false,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const t = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try { resolve(JSON.parse(t)); } catch (e) { reject(e); }
        } else reject(new Error(`HTTP ${res.statusCode}: ${t.slice(0, 200)}`));
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end(data);
  });
}

/** 解析双语输出为结构化字段 */
function parseBilingual(text) {
  const zhMatch = String(text).match(/【\s*中文\s*】\s*([\s\S]*?)(?=【\s*English\s*】|$)/i);
  const enMatch = String(text).match(/【\s*English\s*】\s*([\s\S]*)$/i);
  const zh = (zhMatch ? zhMatch[1] : '').trim();
  const en = (enMatch ? enMatch[1] : '').trim();
  if (zh && en) return { zh, en, text };
  // 格式不符时整段作为中文
  return { zh: String(text).trim(), en: '', text };
}

/**
 * 为单条新闻生成摘要
 * @param {object} item 资讯对象（需含 title/summary/url）
 * @param {'zh'|'bi'|'en'} lang
 */
async function summarize(item, lang = 'bi') {
  const key = `${item.url || item.title}::${lang}`;
  const hit = cacheGet(key);
  if (hit) return hit;

  if (inflight.has(key)) return inflight.get(key);

  const task = (async () => {
    if (!cfg().enabled) {
      return { ok: false, reason: 'not-configured', message: '未配置 AI 接口' };
    }
    try {
      const { base, key: apiKey, model } = cfg();
      const payload = {
        messages: [
          { role: 'system', content: '你是严谨的财经研究助理，输出简洁、无臆测、格式严格。' },
          { role: 'user', content: buildPrompt(item, lang) },
        ],
        temperature: 0.3,
        max_tokens: 500,
      };
      if (model) payload.model = model;

      const j = await postJson(`${base}/chat/completions`, payload, {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      });

      const content = j?.choices?.[0]?.message?.content || j?.choices?.[0]?.text || '';
      if (!content) {
        return { ok: false, reason: 'empty', message: '接口未返回内容' };
      }

      const out = lang === 'bi' ? parseBilingual(content) : { zh: '', en: '', text: content.trim() };
      const data = {
        ok: true,
        lang,
        text: content.trim(),
        zh: lang === 'en' ? '' : (out.zh || content.trim()),
        en: lang === 'zh' ? '' : (out.en || ''),
        model: j?.model || model || '',
        usage: j?.usage || null,
        at: Date.now(),
      };
      cacheSet(key, data);
      return data;
    } catch (e) {
      return { ok: false, reason: 'api-error', message: String(e.message || e).slice(0, 200) };
    } finally {
      inflight.delete(key);
    }
  })();

  inflight.set(key, task);
  return task;
}

/** 批量摘要（串行，避免打爆接口；可传 limit） */
async function summarizeBatch(items, lang = 'bi', limit = 10) {
  const out = [];
  for (const it of (items || []).slice(0, limit)) {
    out.push({ url: it.url, title: it.title, result: await summarize(it, lang) });
  }
  return out;
}

module.exports = { summarize, summarizeBatch, cfg, parseBilingual };