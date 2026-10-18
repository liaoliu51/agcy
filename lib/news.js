'use strict';
/**
 * 资讯聚合模块 —— 多源财经快讯抓取 + 产业链打标
 * 已实测可用源：新浪7x24 / 同花顺 / 东方财富 / 新浪滚动
 * 已废弃：财联社 telegraph API（返回404）
 */
const { httpGet } = require('./http');

function stripHtml(s) {
  return String(s || '')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .trim();
}

function ts(v) {
  const n = typeof v === 'string' ? parseInt(v, 10) : v;
  return Number.isFinite(n) ? n * 1000 : Date.now();
}

// ---------- 各源解析器 ----------
async function srcSina7x24() {
  const r = await httpGet('https://zhibo.sina.com.cn/api/zhibo/feed?page=1&page_size=40&zhibo_id=152&tag_id=0&dire=f&dpc=1',
    { referer: 'https://finance.sina.com.cn/7x24/', gbk: true });
  const j = JSON.parse(r);
  const list = j?.result?.data?.feed?.list || [];
  return list.map((it) => ({
    id: 'sina7_' + it.id,
    title: stripHtml(it.rich_text || it.text || ''),
    time: ts(it.create_time || it.cre_time),
    source: '新浪7×24',
    url: it.docurl || 'https://finance.sina.com.cn/7x24/',
  })).filter((x) => x.title);
}

async function srcSinaRoll() {
  const r = await httpGet('https://feed.mix.sina.com.cn/api/roll/get?pageid=155&lid=1686&num=30&page=1',
    { referer: 'https://finance.sina.com.cn/roll/', gbk: true });
  const j = JSON.parse(r);
  const list = j?.result?.data || [];
  return list.map((it) => ({
    id: 'roll_' + (it.docid || it.url),
    title: stripHtml(it.title),
    summary: stripHtml(it.intro || ''),
    time: ts(it.ctime),
    source: '新浪财经',
    url: it.url || '',
  })).filter((x) => x.title);
}

async function srcTHS() {
  const r = await httpGet('https://news.10jqka.com.cn/tapp/news/push/stock/?page=1&tag=&track=website&pagesize=30',
    { referer: 'https://news.10jqka.com.cn/', gbk: true });
  const j = JSON.parse(r);
  const list = j?.data?.list || [];
  return list.map((it) => ({
    id: 'ths_' + it.seq,
    title: stripHtml(it.title),
    summary: stripHtml(it.digest || ''),
    time: ts(it.ctime || it.rtime),
    source: '同花顺',
    url: it.url || 'https://news.10jqka.com.cn/',
  })).filter((x) => x.title);
}

async function srcEastMoney() {
  const r = await httpGet('https://np-listapi.eastmoney.com/comm/web/getNewsByColumns?client=web&biz=web_news_col&column=350&order=1&needInteractData=0&page_index=1&page_size=30&req_trace=1',
    { referer: 'https://finance.eastmoney.com/' });
  const j = JSON.parse(r);
  const list = j?.data?.list || [];
  return list.map((it) => ({
    id: 'em_' + (it.code || it.url),
    title: stripHtml(it.title || ''),
    summary: stripHtml(it.summary || ''),
    time: ts(it.showTime || it.date),
    source: '东方财富',
    url: it.url || 'https://finance.eastmoney.com/',
  })).filter((x) => x.title);
}

const SOURCES = [
  { name: '新浪7×24', fn: srcSina7x24 },
  { name: '同花顺', fn: srcTHS },
  { name: '东方财富', fn: srcEastMoney },
  { name: '新浪财经', fn: srcSinaRoll },
];

/** 产业链打标：关键词 × 层次匹配 */
function tagItem(item, chain) {
  const text = (item.title + ' ' + (item.summary || ''));
  const hits = [];
  for (const layer of chain.layers) {
    // 中文关键词直接 includes；纯英数关键词要求词边界，避免 "AI" 命中 "SAID"/"河北AI大学" 之类误伤
    const kws = layer.alias.filter((a) => {
      if (/^[一-龥]+$/.test(a)) return text.includes(a);
      const esc = a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return new RegExp('(^|[^A-Za-z0-9])' + esc + '(?![A-Za-z0-9])', 'i').test(text);
    });
    if (kws.length) hits.push({ layerId: layer.id, layerName: layer.name, keywords: kws.slice(0, 6) });
  }
  item.layers = hits;
  item.tagged = hits.length > 0;

  // 分类
  let cat = '宏观';
  if (/央行|货币|降准|降息|LPR|GDP|CPI|PMI|财政|政策|国常会|证监会|汇率|美联储|关税|经济/.test(text)) cat = '宏观政策';
  else if (/芯片|GPU|算力|AI|人工智能|数据中心|光模块|半导体|大模型|存储|机器人|智能体/.test(text)) cat = '科技产业';
  else if (/医药|创新药|生物|制药|新能源|汽车|地产|钢铁|煤炭|有色/.test(text)) cat = '行业';
  else if (/美股|港股|A股|沪指|深指|创业板|恒生|纳斯达克|标普|道指|指数/.test(text)) cat = '市场';
  item.category = cat;

  // 情绪粗判（关键词计数，非严谨NLP，仅供快速筛选）
  const pos = (text.match(/涨停|大涨|新高|增长|突破|利好|上涨|超预期|扩产|量产|获批|中标|签约|创新高|提速|落地|增持|回购/g) || []).length;
  const neg = (text.match(/跌停|大跌|新低|下滑|利空|下跌|不及预期|亏损|减持|退市|风险|警示|处罚|立案|亏损|商誉/g) || []).length;
  item.sentiment = pos > neg ? 'positive' : neg > pos ? 'negative' : 'neutral';
  return item;
}

/** 抓取全部资讯源 */
async function fetchNews(chain) {
  const results = await Promise.allSettled(SOURCES.map((s) => s.fn()));
  const ok = [], failed = [];
  results.forEach((r, i) => {
    if (r.status === 'fulfilled' && r.value && r.value.length) {
      r.value.forEach((x) => ok.push(x));
    } else {
      failed.push({ source: SOURCES[i].name, error: String(r.reason?.message || r.reason) });
    }
  });

  // 去重（按标题前40字）
  const seen = new Set();
  let uniq = [];
  for (const it of ok.sort((a, b) => b.time - a.time)) {
    const k = it.title.slice(0, 40);
    if (seen.has(k)) continue;
    seen.add(k);
    uniq.push(tagItem(it, chain));
  }
  uniq = uniq.slice(0, 120);

  return { news: uniq, failed, updatedAt: Date.now() };
}

module.exports = { fetchNews, tagItem };