'use strict';
/**
 * 投资分析引擎（规则引擎，非黑盒）
 * 逻辑：资讯命中 → 产业链层激活 → 映射标的 → 热度排序 → 生成可解释结论
 * 严格遵循：题材逻辑 + 产业链传导 + 板块级建议（不给个股买卖点/目标价）
 */

const { marketSession } = require('./quotes');

/** 计算层热度：命中资讯条数 × 权重 × 情绪修正 */
function layerHeat(news, chain) {
  const heat = {};
  for (const L of chain.layers) {
    heat[L.id] = {
      id: L.id, name: L.name, idx: L.idx, role: L.role,
      base: L.star * 20,
      hits: 0, pos: 0, neg: 0,
      keywords: new Map(),
      items: [],
      congestion: L.congestion,
      verdict: L.verdict,
      hardConstraint: L.hardConstraint,
      logic: L.logic,
    };
  }
  for (const it of news) {
    if (!it.tagged) continue;
    for (const h of it.layers) {
      const e = heat[h.layerId];
      if (!e) continue;
      e.hits++;
      if (it.sentiment === 'positive') e.pos++;
      else if (it.sentiment === 'negative') e.neg++;
      h.keywords.forEach((k) => e.keywords.set(k, (e.keywords.get(k) || 0) + 1));
      e.items.push({ id: it.id, title: it.title, time: it.time, sentiment: it.sentiment, source: it.source, url: it.url });
    }
  }
  Object.values(heat).forEach((e) => {
    e.score = Math.round(e.base + e.hits * 8 + (e.pos - e.neg) * 3);
    e.keywords = [...e.keywords.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, v]) => ({ k, v }));
    e.items = e.items.sort((a, b) => b.time - a.time).slice(0, 8);
    delete e.pos; delete e.neg;
  });
  return heat;
}

/** 传导链激活判定 */
function chainStatus(chains, heat) {
  return chains.map((c) => {
    const linked = c.path.map((p) => {
      for (const [lid, e] of Object.entries(heat)) {
        if (e.keywords.some((x) => p.includes(x.k) || x.k.includes(p) || p.includes(x.k))) return e;
      }
      return null;
    }).filter(Boolean);
    const totalHits = linked.reduce((s, e) => s + e.hits, 0);
    return {
      ...c,
      active: totalHits > 0,
      activeHits: totalHits,
      relatedLayers: linked.map((e) => ({ id: e.id, name: e.name, hits: e.hits })),
    };
  });
}

/** 依据实时行情，为层的标的计算表现 */
function layerPerformance(heat, mapping, quotes) {
  const qmap = {};
  quotes.forEach((q) => { qmap[q.code] = q; });
  const stockInfo = {};
  mapping.defaultWatchlist.forEach((s) => { stockInfo[s.code] = s; });

  for (const [lid, e] of Object.entries(heat)) {
    const codes = mapping.layerStocks[lid] || [];
    const rows = [];
    for (const c of codes) {
      const q = qmap[c];
      const meta = stockInfo[c];
      if (!meta) continue;
      rows.push({
        code: c, name: meta.name, group: meta.group, market: meta.market,
        price: q ? q.price : null,
        changePct: q ? q.changePct : null,
        note: mapping.starStockNotes[c] || '',
      });
    }
    rows.sort((a, b) => (b.changePct ?? -999) - (a.changePct ?? -999));
    e.stocks = rows;
    const valid = rows.filter((r) => r.changePct !== null);
    if (valid.length) {
      e.avgChangePct = Math.round((valid.reduce((s, r) => s + r.changePct, 0) / valid.length) * 100) / 100;
      const up = valid.filter((r) => r.changePct > 0).length;
      const down = valid.filter((r) => r.changePct < 0).length;
      e.breadth = { up, down, flat: valid.length - up - down, total: valid.length };
    } else {
      e.avgChangePct = null;
      e.breadth = null;
    }
  }
}

/** 生成投资分析日报（板块级，不含个股买卖点） */
function buildReport(news, chain, mapping, quotes) {
  const heat = layerHeat(news, chain);
  const chains = chainStatus(chain.chains, heat);
  layerPerformance(heat, mapping, quotes);

  const session = marketSession();
  const now = new Date();

  // 排序：有资讯命中的优先，其次按基准分
  const ranked = Object.values(heat).sort((a, b) => b.score - a.score);
  const activeLayers = ranked.filter((e) => e.hits > 0);
  const dormantLayers = ranked.filter((e) => e.hits === 0);

  // —— 核心现实约束 ——
  const constraint = activeLayers.slice(0, 3).map((e) => ({
    layer: e.name,
    constraint: e.hardConstraint,
    logic: e.logic,
    evidence: e.items.slice(0, 3).map((i) => ({ title: i.title, source: i.source, time: i.time, url: i.url })),
  }));

  // —— 市场一致预期（从负向资讯提取）——
  const negNews = news.filter((n) => n.sentiment === 'negative').slice(0, 8)
    .map((n) => ({ title: n.title, source: n.source, time: n.time, url: n.url, layers: n.layers.map((l) => l.layerName) }));

  // —— 板块级建议（三段式）——
  const advice = activeLayers.slice(0, 5).map((e) => {
    const layerDef = chain.layers.find((L) => L.id === e.id);
    const stance = e.avgChangePct === null ? '观察'
      : e.avgChangePct > 1.5 ? '强势但注意拥挤度'
      : e.avgChangePct > 0.2 ? '温和走强'
      : e.avgChangePct > -0.2 ? '震荡'
      : '回调中';
    const reasons = [];
    reasons.push(`产业链定位：${layerDef.role}｜${layerDef.logic}`);
    reasons.push(`今日资讯命中 ${e.hits} 条${e.keywords.length ? '，高频关键词：' + e.keywords.slice(0, 5).map((k) => k.k).join('、') : ''}`);
    if (e.avgChangePct !== null) {
      const b = e.breadth;
      reasons.push(`映射标的均涨跌 ${e.avgChangePct > 0 ? '+' : ''}${e.avgChangePct}%（${b.up}涨/${b.down}跌/${b.flat}平，共${b.total}只）`);
    }
    reasons.push(`拥挤度${e.congestion}｜框架定性：${layerDef.verdict}`);
    const linkedChain = chains.find((c) => c.active && c.relatedLayers.some((r) => r.id === e.id));
    if (linkedChain) reasons.push(`所属传导链【${linkedChain.name}】当前激活（${linkedChain.activeHits}条命中）`);

    return {
      layerId: e.id,
      layerName: e.name,
      score: e.score,
      stance,
      congestion: e.congestion,
      watchlist: (e.stocks || []).slice(0, 8),
      avgChangePct: e.avgChangePct,
      reasons,
      traceable: true,
    };
  });

  // —— 风险提示（框架静态风险 + 动态负向资讯）——
  const risks = chain.risks.map((r) => ({ ...r, dynamic: false }));
  if (negNews.length) {
    risks.unshift({
      level: '动态风险',
      text: `当前抓取到 ${negNews.length} 条负向情绪资讯，市场风险偏好可能走弱`,
      mitigation: '详见下方负向资讯清单，优先观察是否扩散至你关注的产业链层',
      dynamic: true,
    });
  }
  if (session.isWeekend) {
    risks.unshift({
      level: '时点提示',
      text: `当前为周末（北京时间 ${session.bjTime}），A股/港股休市，无实时盘中数据`,
      mitigation: '所有建议为盘前准备稿，须以开盘后实际盘面验证；技术位与量能判断可能失效',
      dynamic: true,
    });
  }

  // —— 观察指标 ——
  const watchIndicators = [
    '本轮最强传导链是否持续获得资讯催化（链A互联/链B能源/链C应用）',
    activeLayers.length
      ? `当前激活层：${activeLayers.map((e) => e.name).join('、')}——关注其是否向上下游传导`
      : '暂无资讯命中产业链层，框架处于静默期',
    '映射标的的涨跌广度（up/down 比）是否与资讯热度背离（背离=预期透支）',
  ];

  const dominance = chains.filter((c) => c.active).sort((a, b) => b.activeHits - a.activeHits)[0];

  return {
    generatedAt: now.getTime(),
    dateStr: now.toISOString().slice(0, 10),
    session,
    dataQuality: {
      newsCount: news.length,
      taggedCount: news.filter((n) => n.tagged).length,
      quoteCount: quotes.filter((q) => !q.error).length,
      quoteError: quotes.filter((q) => q.error).length,
      sourceFailure: news.__failed || [],
    },
    headline: {
      main: dominance
        ? `当前最强传导链【${dominance.name}】激活，命中 ${dominance.activeHits} 条资讯`
        : '当前无明显产业链催化，框架处于静默期，建议降低事件驱动仓位',
      sub: `激活层 ${activeLayers.length} / ${chain.layers.length} 个｜资讯 ${news.length} 条（命中 ${news.filter((n) => n.tagged).length} 条）｜行情 ${quotes.filter((q) => !q.error).length} 只`,
      caution: session.isWeekend ? '周末休市·盘前准备稿' : `A股${session['A股']}｜港股${session['港股']}｜美股${session['美股']}`,
    },
    constraints: constraint,
    marketConsensus: negNews,
    activeLayers,
    dormantLayers,
    chains,
    advice,
    risks,
    watchIndicators,
    disclaimer: '本报告为规则引擎基于公开资讯与产业链框架的自动推演，仅代表板块级方向观察，不构成投资建议，不含个股买卖点与目标价。所有结论可追溯至具体资讯与产业链层位置，但资讯源本身可能存在偏差。股市有风险，投资需谨慎。',
  };
}

module.exports = { buildReport };