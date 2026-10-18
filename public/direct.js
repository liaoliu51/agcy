/**
 * 直连降级层 —— 当后端（Cloudflare Worker 境外出口）无法访问腾讯行情时启用
 *
 * 原理：qt.gtimg.cn 返回形如 v_sh600519="..."; 的脚本，会在 window 上定义 v_xxx 全局变量。
 * 通过 <script charset="gbk"> 注入即可绕过 CORS与 GBK 解码问题（由浏览器原生处理）。
 */
(function () {
  window.QHDirect = { enabled: false, test: null, lastErr: null };

  function inject(url) {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.charset = 'gbk';
      s.src = url;
      s.onload = () => { s.remove(); resolve(); };
      s.onerror = () => { s.remove(); reject(new Error('script load failed')); };
      document.head.appendChild(s);
    });
  }

  const num = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : null; };
  const marketOf = (c) =>
    /^(sh|sz|bj)/.test(c) ? 'A股' : /^hk/.test(c) ? '港股' : /^us/.test(c) ? '美股' : '未知';

  function pick(code) {
    for (const k of Object.keys(window)) {
      if (k.length > 2 && k[0] === 'v' && k[1] === '_' && /^[\d.]+$/.test(k.slice(2))) {
        if (k.slice(2) === code) return window[k];
      }
    }
    return null;
  }

  function parse(code, meta) {
    const v = pick(code);
    if (!v) return null;
    delete window['v_' + code];
    const f = String(v).split('~');
    if (f.length < 32) return null;
    const mk = marketOf(code);
    const base = {
      code, name: (f[1] && f[1] !== '') ? f[1] : code,
      price: num(f[3]), prevClose: num(f[4]), open: num(f[5]),
      high: num(f[33]), low: num(f[34]),
      change: num(f[31]), changePct: num(f[32]), time: f[30] || '',
      market: mk === '美股' ? '美股' : mk,
    };
    if (mk === 'A股') {
      return { ...base, volume: num(f[6]), turnover: num(f[37]), pe: num(f[39]),
        pb: num(f[46]), turnoverRate: num(f[38]), amplitude: num(f[43]), mktCap: num(f[45]) };
    }
    return { ...base, volume: num(f[36]), turnover: num(f[37]), pe: num(f[39]), pb: num(f[46]),
      delayed: mk === '美股' };
  }

  async function fetchQuotes(list) {
    const BATCH = 40;
    const out = [];
    for (let i = 0; i < list.length; i += BATCH) {
      const slice = list.slice(i, i + BATCH);
      const codes = slice.map((s) => s.code);
      const url = 'https://qt.gtimg.cn/q=' + encodeURIComponent(codes.join(','));
      try {
        await inject(url);
      } catch (e) {
        window.QHDirect.lastErr = String(e.message || e);
        slice.forEach((s) => out.push({ ...s, error: 'direct-failed' }));
        continue;
      }
      for (const s of slice) {
        const q = parse(s.code, s);
        if (q && q.price !== null) out.push({ ...s, ...q });
        else out.push({ ...s, error: 'no-data' });
      }
    }
    return out;
  }

  /** 探测直连是否可用（浏览器不受地域出口限制，通常必通） */
  async function test() {
    try {
      await inject('https://qt.gtimg.cn/q=sh600519');
      const v = pick('sh600519');
      if (v) delete window.v_sh600519;
      window.QHDirect.test = !!v;
      return window.QHDirect.test;
    } catch (e) {
      window.QHDirect.test = false;
      window.QHDirect.lastErr = String(e.message || e);
      return false;
    }
  }

  window.QHDirect.fetchQuotes = fetchQuotes;
  window.QHDirect.test = test;
})();