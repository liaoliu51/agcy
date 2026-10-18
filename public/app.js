'use strict';
/* QuantHub 前端 */

// ---------- 状态 ----------
const S = {
  quotes: [], quotesAt: 0, prevPrice: {},
  news: [], newsAt: 0, failed: [],
  chain: null, report: null,
  watchlist: [], editingList: [], watchlistCache: [],
  directMode: false,
  flashDowngrade: false, timerStarted: Date.now(),
  currentTab: 'market',
  lastReport: 0,
};

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const fmt = (n, d = 2) => (n === null || n === undefined || Number.isNaN(n)) ? '--' : Number(n).toFixed(d);
const sign = (n) => (n === null || n === undefined) ? '' : (n > 0 ? '+' : '');
const cls = (n) => (n === null || n === undefined) ? 'flat' : (n > 0 ? 'up' : n < 0 ? 'down' : 'flat');
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const timeStr = (t) => { const d = new Date(t); return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
const timeOnly = (t) => { const d = new Date(t); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`; };

async function api(p, opt) {
  const r = await fetch(p, opt);
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}

// ---------- Tab ----------
$$('.tab').forEach((b) => b.addEventListener('click', () => {
  $$('.tab').forEach((x) => x.classList.remove('active'));
  $$('.pane').forEach((x) => x.classList.remove('active'));
  b.classList.add('active');
  const t = b.dataset.tab;
  S.currentTab = t;
  $('#pane-' + t).classList.add('active');
  if (t === 'news') { if (!S.news.length) pollNews(); else renderNews(); }
  if (t === 'chain') loadChain();
  if (t === 'report') loadReport();
}));

// ---------- 行情 ----------
function renderHud(session, updatedAt) {
  $('#bjTime').textContent = session ? session.bjTime.slice(11) : '--:--:--';
  const setS = (id, v) => { const e = $(id); e.textContent = v; e.className = 'hud-val ' + (v === '交易中' ? 'open' : 'closed'); };
  if (session) { setS('#sA', session['A股']); setS('#sHK', session['港股']); setS('#sUS', session['美股']); }
  const age = updatedAt ? Math.round((Date.now() - updatedAt) / 1000) : null;
  $('#refreshInfo').textContent = age !== null ? age + 's前' : '--';
}

function flashCell(td, price) {
  const prev = S.prevPrice[td.dataset.code];
  if (prev !== undefined && price !== prev) {
    const up = price > prev;
    td.classList.remove('flash-up', 'flash-down');
    void td.offsetWidth;
    td.classList.add(up ? 'flash-up' : 'flash-down');
  }
  S.prevPrice[td.dataset.code] = price;
}

function renderQuotes() {
  const fltM = $('#fltMarket').value, fltG = $('#fltGroup').value;
  const kw = $('#fltSearch').value.trim().toLowerCase();
  const onlyIdx = $('#onlyIdx').checked;

  let list = S.quotes;
  if (onlyIdx) list = list.filter((x) => x.market.includes('指数'));
  if (fltM) list = list.filter((x) => x.market === fltM);
  if (fltG) list = list.filter((x) => x.group === fltG);
  if (kw) list = list.filter((x) => (x.name || '').toLowerCase().includes(kw) || (x.code || '').toLowerCase().includes(kw));

  const head = `<tr><th>名称</th><th>代码</th><th>最新价</th><th>涨跌额</th><th>涨跌幅</th><th>今开</th><th>最高</th><th>最低</th><th>成交量</th><th>成交额</th><th>换手率</th><th>PE</th><th>PB</th><th>市场</th><th>更新时间</th></tr>`;
  $('#qHead').innerHTML = head;

  if (!list.length) { $('#qBody').innerHTML = '<tr><td colspan="15" style="text-align:center;padding:36px;color:#868d95">暂无数据</td></tr>'; return; }

  // 按板块分组
  const groups = {};
  list.forEach((x) => { const g = x.group || '未分组'; (groups[g] = groups[g] || []).push(x); });
  const order = ['指数', '光模块', '光芯片', '存储', '国产GPU', 'AIDC电力', '液冷', '半导体设备', '半导体材料', '机器人', 'AI安全', 'AI内容', 'AI营销', 'AI制药', 'AI应用/Agent', '算力核心'];
  const keys = Object.keys(groups).sort((a, b) => {
    const ia = order.indexOf(a), ib = order.indexOf(b);
    return (ia === -1 ? 999 : ia) - (ib === -1 ? 999 : ib);
  });

  let html = '';
  for (const g of keys) {
    const arr = groups[g].slice().sort((a, b) => (b.changePct ?? -999) - (a.changePct ?? -999));
    html += `<tr class="grp-row"><td colspan="15">${esc(g)} · ${arr.length}只</td></tr>`;
    for (const x of arr) {
      if (x.error) {
        html += `<tr><td>${esc(x.name)}</td><td><span class="edit-code">${esc(x.code)}</span></td><td colspan="10" class="err">行情获取失败：${esc(x.error)}</td><td>${esc(x.market)}</td><td>--</td></tr>`;
        continue;
      }
      const mkChip = x.market.includes('美股') ? 'chip us' : x.market.includes('港股') ? 'chip hk' : 'chip';
      const fmtVol = (x.volume != null && x.volume >= 1e8) ? (x.volume / 1e8).toFixed(2) + '亿' : x.volume != null ? x.volume : '--';
      const fmtAmt = (x.turnover != null && x.turnover >= 1e8) ? (x.turnover / 1e8).toFixed(2) + '亿' : x.turnover != null ? x.turnover : '--';
      html += `<tr>
        <td><b>${esc(x.name)}</b>${x.delayed ? '<span class="muted" title="美股为延迟行情">ⓓ</span>' : ''}</td>
        <td><span class="edit-code">${esc(x.code)}</span></td>
        <td class="${cls(x.changePct)}" data-code="${esc(x.code)}"><b>${fmt(x.price)}</b></td>
        <td class="${cls(x.change)}">${sign(x.change)}${fmt(x.change)}</td>
        <td class="${cls(x.changePct)}"><b>${sign(x.changePct)}${fmt(x.changePct)}%</b></td>
        <td>${fmt(x.open)}</td><td>${fmt(x.high)}</td><td>${fmt(x.low)}</td>
        <td>${fmtVol}</td><td>${fmtAmt}</td>
        <td>${x.turnoverRate != null ? fmt(x.turnoverRate) + '%' : '--'}</td>
        <td>${fmt(x.pe)}</td><td>${fmt(x.pb)}</td>
        <td><span class="${mkChip}">${esc(x.market)}</span></td>
        <td class="muted">${x.time ? esc(String(x.time).slice(-8)) : '--'}</td>
      </tr>`;
    }
  }
  $('#qBody').innerHTML = html;
  $$('#qBody td[data-code]').forEach((td) => flashCell(td, parseFloat(td.textContent)));

  const okCount = S.quotes.filter((x) => !x.error).length;
  const errCount = S.quotes.length - okCount;
  const n = $('#mktNotice');
  if (errCount) { n.className = 'notice show'; n.innerHTML = `行情源提示：${S.quotes.length} 只中 ${okCount} 只成功，${errCount} 只失败（多为代码格式问题）。可点击「管理自选」核对代码。`; }
  else n.className = 'notice';
}

async function pollQuotes() {
  // 优先走后端（Cloudflare Worker 或本地 Node）。
  // 若后端因境外出口拿不到国内行情（全部 no-data / 请求失败），自动切「浏览器直连」模式。
  if (!S.directMode) {
    try {
      const r = await api('/api/quotes');
      const list = r.data || [];
      const ok = list.filter((x) => !x.error && x.price !== null).length;
      S.quotes = list;
      S.quotesAt = r.updatedAt;
      S.session = r.session;
      if (list.length && ok === 0) { S.directMode = true; S.quotes = []; }
      else { renderHud(r.session, r.updatedAt); if (S.currentTab === 'market') renderQuotes(); return; }
    } catch (e) { S.directMode = true; }
  }
  // 降级路径：浏览器直连腾讯行情（script 注入，绕开 CORS + GBK）
  try {
    const list = await window.QHDirect.fetchQuotes(S.watchlistCache || []);
    if (!list.length) return;
    S.quotes = list;
    S.quotesAt = Date.now();
    renderHud(window.QHSession || null, Date.now());
    if (S.currentTab === 'market') renderQuotes();
  } catch (e) { /* 静默 */ }
}

// ---------- 资讯 ----------
function renderNews() {
  const cat = $('#nCat').value, lay = $('#nLayer').value, taggedOnly = $('#nTagged').checked;
  let list = S.news;
  if (cat) list = list.filter((n) => n.category === cat);
  if (lay) list = list.filter((n) => n.layers.some((l) => l.layerId === lay));
  if (taggedOnly) list = list.filter((n) => n.tagged);

  const tagTotal = S.news.filter((n) => n.tagged).length;
  $('#newsStat').textContent = `共 ${S.news.length} 条｜命中产业链 ${tagTotal} 条｜更新于 ${timeStr(S.newsAt)}`;

  const fn = $('#newsNotice');
  if (S.failed.length) { fn.className = 'notice show'; fn.innerHTML = `资讯源提示：${S.failed.length} 个源抓取失败（${S.failed.map((f) => esc(f.source)).join('、')}），不影响其余源。`; }
  else fn.className = 'notice';

  if (!list.length) { $('#newsList').innerHTML = '<div class="rep-block" style="text-align:center;color:#868d95">暂无符合条件的资讯</div>'; return; }

  $('#newsList').innerHTML = list.map((n) => {
    const title = n.url ? `<a href="${esc(n.url)}" target="_blank" rel="noopener">${esc(n.title)}</a>` : esc(n.title);
    const layers = (n.layers || []).map((l) => `<span class="chip" title="关键词：${esc(l.keywords.join('、'))}">${esc(l.layerName)}</span>`).join('');
    const sentCn = { positive: '偏正面', negative: '偏负面', neutral: '中性' };
    return `<div class="news-item ${n.tagged ? 'tagged' : ''} ${n.sentiment}">
      <div class="news-head">
        <div class="news-title">${title}</div>
        <span class="sent ${n.sentiment}">${sentCn[n.sentiment] || '中性'}</span>
      </div>
      ${n.summary ? `<div class="news-sum">${esc(n.summary.slice(0, 220))}${n.summary.length > 220 ? '…' : ''}</div>` : ''}
      <div class="news-meta">
        <span class="cat">${esc(n.category)}</span>${layers}
        <span>${esc(n.source)}</span><span>${timeStr(n.time)}</span>
      </div>
    </div>`;
  }).join('');
}

async function pollNews() {
  try {
    const r = await api('/api/news');
    S.news = r.data || [];
    S.newsAt = r.updatedAt;
    S.failed = r.failed || [];
    if (S.currentTab === 'news') renderNews();
    if (S.report) renderReport();
  } catch (e) { /* 静默 */ }
}

// ---------- 产业链图谱 ----------
async function loadChain() {
  const box = $('#chainView');
  if (!S.chain) box.innerHTML = '<div class="rep-block" style="text-align:center">加载中…</div>';
  try {
    if (!S.chain) S.chain = await api('/api/chain');
    const c = S.chain;
    let hot = {};
    if (S.report) { (S.report.activeLayers || []).forEach((l) => { hot[l.id] = l; }); }
    const maxScore = Math.max(...(S.report ? (S.report.activeLayers || []).map((l) => l.score) : [1]), 1);

    const layersHtml = c.layers.map((l, i) => {
      const h = hot[l.id];
      const active = !!h;
      const isHot = active && h.hits >= 3;
      const pct = active ? Math.min(100, Math.round((h.score / maxScore) * 100)) : 0;
      const kws = h && h.keywords ? h.keywords.map((k) => `<span>${esc(k.k)} (${k.v})</span>`).join('') : '';
      return `${i > 0 ? '<div class="arrow">▼</div>' : ''}
      <div class="layer-node ${active ? 'active' : ''} ${isHot ? 'hot' : ''}">
        <div class="layer-idx">L${l.idx}</div>
        <div>
          <div class="layer-name">${esc(l.name)}<span class="layer-role">${esc(l.role)}</span>
            <span class="stars">${'★'.repeat(l.star)}${'☆'.repeat(5 - l.star)}</span>
            ${active ? `<span class="chip">资讯命中 ${h.hits} 条</span>` : '<span class="chip">静默</span>'}
            ${active && h.avgChangePct !== null ? `<span class="chip ${cls(h.avgChangePct)}">标的均值 ${sign(h.avgChangePct)}${fmt(h.avgChangePct)}%</span>` : ''}
          </div>
          <div class="layer-meta"><b>硬约束</b>：${esc(l.hardConstraint)}</div>
          <div class="layer-meta"><b>传导逻辑</b>：${esc(l.logic)}</div>
          <div class="layer-meta"><b>框架定性</b>：${esc(l.verdict)}　<b>拥挤度</b>：${esc(l.congestion)}</div>
          ${kws ? `<div class="kw">${kws}</div>` : ''}
          ${active ? `<div class="bar"><span style="width:${pct}%"></span></div>` : ''}
        </div>
      </div>`;
    }).join('');

    const chainsHtml = c.chains.map((ch) => {
      const st = S.report ? (S.report.chains || []).find((x) => x.id === ch.id) : null;
      const on = st && st.active;
      return `<div class="chain-card ${on ? 'on' : ''}">
        <h4>${esc(ch.name)} <span class="stars">${'★'.repeat(ch.star)}</span> ${on ? '<span class="chip">已激活 ' + st.activeHits + ' 条</span>' : '<span class="chip">未激活</span>'}</h4>
        <div class="chain-path">${ch.path.map((p) => `<span>${esc(p)}</span>`).join('→')}</div>
        <div class="layer-meta"><b>状态</b>：${esc(ch.status)}　<b>交易价值</b>：${esc(ch.tradeValue)}</div>
        <div class="layer-meta" style="margin-top:4px"><b>验证证据</b>：${esc(ch.evidence)}</div>
      </div>`;
    }).join('');

    const tagsHtml = `<table class="quote-table" style="min-width:auto">
      <thead><tr><th>科技标签</th><th>所属层</th><th>景气</th><th>拥挤度</th><th>兑现节奏</th><th>关键催化</th><th>框架备注</th></tr></thead>
      <tbody>${c.tags.map((t) => `<tr>
        <td><b>${esc(t.name)}</b></td><td>${esc((c.layers.find((l) => l.id === t.layer) || {}).name || '')}</td>
        <td><span class="stars">${'★'.repeat(t.star)}</span></td><td>${esc(t.congestion)}</td>
        <td>${esc(t.rhythm)}</td><td>${esc(t.catalyst)}</td><td style="text-align:left;color:#4a5158">${esc(t.note)}</td>
      </tr>`).join('')}</tbody></table>`;

    box.innerHTML = `
      <div class="chain-container">
        <div class="chain-title">AI 产业链七层栈式框架</div>
        <div class="chain-desc">能源 → 机房 → 液冷 → 芯片 → <b>互联（当前最大瓶颈）</b> → 存储 → 模型/Agent → 应用。金色=高景气。红色边框=当前资讯高频命中层。热度条基于资讯命中数与情绪加权实时计算。</div>
        <div class="layer-flow">${layersHtml}</div>
      </div>
      <div class="chain-container">
        <div class="chain-title">三条主传导链</div>
        <div class="chain-desc">判断资金该在哪一层找业绩兑现、哪一层找情绪弹性</div>
        <div class="chains-box">${chainsHtml}</div>
      </div>
      <div class="chain-container">
        <div class="chain-title">科技标签矩阵</div>
        <div class="chain-desc">景气度 / 拥挤度 / 兑现节奏三维对照</div>
        ${tagsHtml}
      </div>`;
  } catch (e) {
    box.innerHTML = `<div class="rep-block" style="text-align:center;color:#c62828">产业链框架加载失败：${esc(e.message)}</div>`;
  }
}

// ---------- 投资分析日报 ----------
function renderReport() {
  const r = S.report;
  if (!r) { $('#reportView').innerHTML = '<div class="rep-block" style="text-align:center">加载中…</div>'; return; }
  const q = r.dataQuality;
  const stanceCls = (s) => ({ '强势但注意拥挤度': 's3', '温和走强': 's2', '震荡': 's1', '回调中': 's0', '观察': 's1' }[s] || 's1');
  const lvCls = (l) => l === '高度关注' ? 'lv0' : l === '动态风险' ? 'dyn' : l === '时点提示' ? 'dyn' : 'lv1';

  $('#repStat').textContent = `生成于 ${timeStr(r.generatedAt)}｜资讯 ${q.newsCount} 条（命中 ${q.taggedCount}）｜行情 ${q.quoteCount} 只`;

  const html = `
    <div class="headline">
      <div class="main">${esc(r.headline.main)}</div>
      <div class="sub">${esc(r.headline.sub)}</div>
      <div class="caution">${esc(r.headline.caution)}</div>
    </div>

    <div class="rep-block">
      <div class="rep-h">① 核心现实约束</div>
      ${r.constraints.length ? r.constraints.map((c) => `
        <div class="advice-card">
          <div class="advice-head"><div class="advice-name">${esc(c.layer)}</div></div>
          <ul class="reason-list">
            <li><b>硬约束</b>：${esc(c.constraint)}</li>
            <li><b>传导逻辑</b>：${esc(c.logic)}</li>
          </ul>
          ${c.evidence.length ? `<div class="stock-note"><b>资讯证据</b>：${c.evidence.map((e) => `${esc(e.title)}<span class="muted">（${esc(e.source)} ${timeStr(e.time)}）</span>`).join('；')}</div>` : ''}
        </div>`).join('') : '<div class="muted">当前无资讯命中的产业链层，无法提取现实约束。</div>'}
    </div>

    <div class="rep-block">
      <div class="rep-h">② 市场一致预期（负向情绪线索）</div>
      ${r.marketConsensus.length ? `<ul class="mini-list">${r.marketConsensus.map((n) => `<li><span class="t">${n.url ? `<a href="${esc(n.url)}" target="_blank" rel="noopener">${esc(n.title)}</a>` : esc(n.title)}${n.layers.length ? `<span class="chip">${esc(n.layers.join('/'))}</span>` : ''}</span><span class="muted">${esc(n.source)} ${timeStr(n.time)}</span></li>`).join('')}</ul>`
        : '<div class="muted">当前未抓取到明显负向情绪资讯。</div>'}
    </div>

    <div class="rep-block">
      <div class="rep-h">③ 板块级操作思路（规则引擎推演·可追溯）</div>
      ${r.advice.length ? r.advice.map((a) => `
        <div class="advice-card">
          <div class="advice-head">
            <div class="advice-name">${esc(a.layerName)} <span class="muted" style="font-weight:400">拥挤度：${esc(a.congestion)}</span></div>
            <div><span class="stance ${stanceCls(a.stance)}">${esc(a.stance)}</span></div>
          </div>
          <ul class="reason-list">${a.reasons.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>
          ${a.watchlist.length ? `<div class="stock-grid">${a.watchlist.map((w) => `<div class="stock-item"><span><b>${esc(w.name)}</b><br><span class="muted">${esc(w.group)}</span></span><span class="${cls(w.changePct)}"><b>${fmt(w.price)}</b><br>${sign(w.changePct)}${fmt(w.changePct)}%</span></div>`).join('')}</div>
          <div class="stock-note"><b>说明</b>：以上为产业链映射的关注清单（板块级观察），<b>非买入推荐</b>。命中产业链位置 ≠ 构成投资理由，仍需自行验证基本面、估值、资金面与风险承受能力。</div>` : ''}
        </div>`).join('') : '<div class="muted">当前无激活产业链层，不生成板块建议。</div>'}
    </div>

    <div class="rep-block">
      <div class="rep-h">④ 关键观察指标</div>
      <ul class="reason-list">${r.watchIndicators.map((w) => `<li>${esc(w)}</li>`).join('')}</ul>
    </div>

    <div class="rep-block">
      <div class="rep-h">⑤ 逻辑漏洞与风险清单</div>
      ${r.risks.map((x) => `<div class="risk-item ${lvCls(x.level)}">
        <span class="risk-lv">${esc(x.level)}</span><span class="risk-tx">${esc(x.text)}</span>
        <div class="risk-mt"><b>应对</b>：${esc(x.mitigation)}</div>
      </div>`).join('')}
    </div>

    <div class="disclaimer">${esc(r.disclaimer)}</div>`;
  $('#reportView').innerHTML = html;
}

async function loadReport() {
  $('#reportView').innerHTML = '<div class="rep-block" style="text-align:center">生成中…（首次需抓取资讯，约3-10秒）</div>';
  try {
    S.report = await api('/api/report');
    renderReport();
  } catch (e) {
    $('#reportView').innerHTML = `<div class="rep-block" style="text-align:center;color:#c62828">日报生成失败：${esc(e.message)}</div>`;
  }
}

// ---------- 自选股管理 ----------
function renderEditList() {
  $('#editList').innerHTML = S.editingList.map((x, i) => `<div class="edit-row">
    <span><span class="edit-code">${esc(x.code)}</span>${esc(x.name || '(未命名)')} <span class="chip">${esc(x.market || '')}</span> ${x.group ? `<span class="chip">${esc(x.group)}</span>` : ''}</span>
    <button class="del-btn" data-i="${i}">删除</button>
  </div>`).join('');
  $$('#editList .del-btn').forEach((b) => b.addEventListener('click', () => {
    S.editingList.splice(parseInt(b.dataset.i), 1); renderEditList();
  }));
}

function fillGroups() {
  const gs = [...new Set(S.watchlist.map((x) => x.group).filter(Boolean))].sort();
  const cur = $('#fltGroup').value;
  $('#fltGroup').innerHTML = '<option value="">全部板块</option>' + gs.map((g) => `<option>${esc(g)}</option>`).join('');
  $('#fltGroup').value = cur;
}

$('#btnEdit').addEventListener('click', () => {
  S.editingList = S.watchlist.slice();
  renderEditList();
  $('#modalEdit').classList.add('show');
});
$('#btnCloseModal').addEventListener('click', () => $('#modalEdit').classList.remove('show'));
$('#btnCancelEdit').addEventListener('click', () => $('#modalEdit').classList.remove('show'));
$('#btnAdd').addEventListener('click', () => {
  const code = $('#inCode').value.trim();
  if (!code) return alert('请输入代码');
  if (S.editingList.some((x) => x.code === code)) return alert('该代码已存在');
  S.editingList.push({ code, name: $('#inName').value.trim() || code, market: $('#inMarket').value, group: $('#inGroup').value.trim() || '自定义' });
  $('#inCode').value = ''; $('#inName').value = ''; $('#inGroup').value = '';
  renderEditList();
});
$('#btnSaveWatch').addEventListener('click', async () => {
  try {
    await api('/api/watchlist', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ list: S.editingList }) });
    S.watchlist = S.editingList.slice();
    S.watchlistCache = S.watchlist.slice();
    localStorage.setItem('qh_watchlist', JSON.stringify(S.watchlist));
    $('#modalEdit').classList.remove('show');
    fillGroups();
    await pollQuotes();
    alert('已保存并生效');
  } catch (e) { alert('保存失败：' + e.message); }
});

// ---------- 过滤 ----------
['#fltMarket', '#fltGroup'].forEach((s) => $(s).addEventListener('change', renderQuotes));
$('#fltSearch').addEventListener('input', renderQuotes);
$('#onlyIdx').addEventListener('change', renderQuotes);
['#nCat', '#nLayer'].forEach((s) => $(s).addEventListener('change', renderNews));
$('#nTagged').addEventListener('change', renderNews);
$('#btnRefresh').addEventListener('click', async () => {
  $('#btnRefresh').textContent = '刷新中…';
  try { await api('/api/refresh', { method: 'POST' }); await Promise.all([pollQuotes(), pollNews()]); S.report = null; if (S.currentTab === 'report') loadReport(); }
  finally { $('#btnRefresh').textContent = '立即刷新'; }
});
$('#btnRepRep').addEventListener('click', () => { S.report = null; loadReport(); });

// ---------- 主循环：行情 5s，资讯 60s ----------
async function boot() {
  try {
    const w = await api('/api/watchlist');
    S.watchlist = w.data || [];
    const saved = localStorage.getItem('qh_watchlist');
    if (saved) {
      try { S.watchlist = JSON.parse(saved); } catch (e) { /* ignore */ }
    }
  } catch (e) { /* ignore */ }
  S.watchlistCache = S.watchlist.slice();
  fillGroups();

  try {
    const c = await api('/api/chain');
    S.chain = c;
    $('#nLayer').innerHTML = '<option value="">全部产业链层</option>' + c.layers.map((l) => `<option value="${l.id}">${esc(l.name)}</option>`).join('');
  } catch (e) { /* ignore */ }

  // 后端不可达（如未部署 Worker）→ 直接进入浏览器直连模式
  if (!S.quotes.length) {
    const ok = await window.QHDirect.test();
    S.directMode = true;
    if (!ok) {
      const n = $('#mktNotice');
      n.className = 'notice show';
      n.innerHTML = '行情源不可达：后端未部署，且浏览器直连腾讯行情也失败。请确认网络或部署 Worker。';
      return;
    }
    const n = $('#mktNotice');
    n.className = 'notice show';
    n.innerHTML = '当前为<b>浏览器直连模式</b>：后端 Worker 未能取回国内行情源（境外出口限制），行情由你的浏览器直连腾讯自选股获取，功能完全一致。';
  }

  await pollQuotes();
  pollNews();
  setInterval(() => {
    // 省流保护：页面停留超30分钟，行情降频至15秒
    const elapsed = Date.now() - S.timerStarted;
    if (elapsed > 30 * 60 * 1000) {
      if (!S.flashDowngrade) { S.flashDowngrade = true; $('#refreshInfo').title = '已自动降频至15秒（页面停留超30分钟）'; }
      S._slowTick = (S._slowTick || 0) + 1;
      if (S._slowTick % 3 === 0) pollQuotes();
    } else pollQuotes();
  }, 5000);

  setInterval(pollNews, 60000);
  setInterval(() => { if (S.currentTab === 'chain' && S.report) loadChain(); }, 120000);
}

boot();