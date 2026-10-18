'use strict';
/**
 * 行情模块 —— 腾讯自选股 qt.gtimg.cn 解析
 * 支持：A股 / 港股 / 美股 / 指数
 * 字段索引依据腾讯返回的 v_<code>="..." 分隔格式
 */

const { fetchRaw } = require('./http');

function num(v) {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

/** 判断市场类型 */
function marketOf(code) {
  if (code.startsWith('sh') || code.startsWith('sz') || code.startsWith('bj')) return 'A股';
  if (code.startsWith('hk')) return '港股';
  if (code.startsWith('us')) return '美股';
  return '未知';
}

/** 解析简版指数 (s_ 前缀)：v_s_sh000001="1~上证指数~000001~3716.28~8.80~0.24~..." */
function parseShort(code, body) {
  const m = body.match(new RegExp('v_' + code.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '="([^"]*)"'));
  if (!m) return null;
  const f = m[1].split('~');
  if (f.length < 6) return null;
  return {
    code,
    name: f[1],
    price: num(f[3]),
    change: num(f[4]),
    changePct: num(f[5]),
    time: '',
    market: code.startsWith('r_hk') ? '港股指数' : (code.startsWith('us') ? '美股指数' : 'A股指数'),
    simple: true,
  };
}

/** 解析港股/美股指数 (r_ 前缀) */
function parseRIndex(code, body) {
  const m = body.match(new RegExp('v_' + code.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '="([^"]*)"'));
  if (!m) return null;
  const f = m[1].split('~');
  // r_ 格式：0类型 1名称 2代码 3现价 4昨收 5今开 ...
  return {
    code,
    name: f[1],
    price: num(f[3]),
    prevClose: num(f[4]),
    open: num(f[5]),
    high: num(f[33]),
    low: num(f[34]),
    change: num(f[31]),
    changePct: num(f[32]),
    time: f[30] || '',
    market: code.startsWith('r_hk') ? '港股指数' : '美股指数',
  };
}

/** 解析个股（A股/港股/美股完整格式） */
function parseStock(code, body) {
  const m = body.match(new RegExp('v_' + code.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '="([^"]*)"'));
  if (!m) return null;
  const f = m[1].split('~');
  if (f.length < 32) return null;

  const mk = marketOf(code);
  // 港股字段偏移与A股不同
  if (mk === '港股') {
    return {
      code,
      name: f[1],
      price: num(f[3]),
      prevClose: num(f[4]),
      open: num(f[5]),
      high: num(f[33]),
      low: num(f[34]),
      change: num(f[31]),
      changePct: num(f[32]),
      volume: num(f[36]),
      turnover: num(f[37]),
      pe: num(f[39]),
      pb: num(f[46]),
      turnoverRate: num(f[43]),
      time: f[30] || '',
      market: '港股',
    };
  }

  // 美股字段：腾讯美股 name 位置略有差异，取容错
  if (mk === '美股') {
    const name = (f[1] && f[1] !== '') ? f[1] : (f[0] || code);
    return {
      code,
      name,
      price: num(f[3]),
      prevClose: num(f[26]) ?? num(f[4]),
      open: num(f[5]),
      high: num(f[33]),
      low: num(f[34]),
      change: num(f[31]),
      changePct: num(f[32]),
      volume: num(f[36]),
      turnover: num(f[37]),
      pe: num(f[39]),
      pb: num(f[46]),
      time: f[30] || '',
      market: '美股',
      delayed: true,
    };
  }

  // A股
  return {
    code,
    name: f[1],
    price: num(f[3]),
    prevClose: num(f[4]),
    open: num(f[5]),
    volume: num(f[6]),
    bid: num(f[9]),
    ask: num(f[19]),
    high: num(f[33]),
    low: num(f[34]),
    change: num(f[31]),
    changePct: num(f[32]),
    turnover: num(f[37]),
    pe: num(f[39]),
    pb: num(f[46]),
    turnoverRate: num(f[38]),
    amplitude: num(f[43]),
    mktCap: num(f[45]),
    time: f[30] || '',
    market: 'A股',
  };
}

/**
 * 批量拉取行情
 * @param {Array<{code,name,group,market}>} list
 */
async function fetchQuotes(list) {
  if (!list || !list.length) return [];
  const BATCH = 40;
  const out = [];
  for (let i = 0; i < list.length; i += BATCH) {
    const slice = list.slice(i, i + BATCH);
    const q = slice.map((s) => s.code).join(',');
    const url = `http://qt.gtimg.cn/q=${encodeURIComponent(q)}`;
    let body = '';
    try {
      body = await fetchRaw(url, { referer: 'https://gu.qq.com/', timeout: 12000 });
    } catch (e) {
      slice.forEach((s) => out.push({ ...s, error: String(e.message || e) }));
      continue;
    }
    for (const s of slice) {
      let q = null;
      if (s.code.startsWith('s_')) q = parseShort(s.code, body);
      else if (s.code.startsWith('r_')) q = parseRIndex(s.code, body);
      else q = parseStock(s.code, body);
      if (q && q.price !== null) out.push({ ...s, ...q });
      else out.push({ ...s, error: 'no-data' });
    }
  }
  return out;
}

/** 交易时段判断（统一按北京时间 UTC+8 计算） */
function marketSession(now = new Date()) {
  // now 为绝对时间戳，先加8小时得到北京时间，再用 getUTC* 读取，避免受本机时区影响
  const bj = new Date(now.getTime() + 8 * 3600 * 1000);
  const day = bj.getUTCDay();
  const mins = bj.getUTCHours() * 60 + bj.getUTCMinutes();
  const weekend = day === 0 || day === 6;

  const aOpen = mins >= 570 && mins < 690;    // 09:30-11:30
  const aNoon = mins >= 780 && mins <= 900;    // 13:00-15:00
  // 美股（夏令时 21:30-次日04:00 北京时间）
  const usOpen = mins >= 1290 || mins <= 240;
  const hkOpen = mins >= 570 && mins <= 960;
  const weekday = day >= 1 && day <= 5;

  return {
    bjTime: bj.toISOString().slice(0, 16).replace('T', ' '),
    isWeekend: weekend,
    'A股': weekday && (aOpen || aNoon) ? '交易中' : (weekend ? '休市' : '休市'),
    '港股': weekday && hkOpen ? '交易中' : '休市',
    '美股': (weekday && mins >= 1290) || (!weekend && mins <= 240) ? '交易中' : '休市',
  };
}

module.exports = { fetchQuotes, marketSession, marketOf };