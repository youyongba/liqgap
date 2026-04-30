'use strict';

/**
 * Liquidity Gap 仪表盘 · 前端控制器
 * (Liquidity Gap dashboard - frontend controller)
 *
 * 职责 (Responsibilities)：
 *   - 每 10 秒轮询后端 /api 接口 (poll /api endpoints every 10s, configurable)
 *   - 在主图绘制 K 线 + VWAP + FVG + 流动性空白
 *     (render main candlestick chart with VWAP, FVG, liquidity voids)
 *   - 副图：成交量直方图 + CVD 累积曲线
 *     (sub charts: volume histogram + CVD line)
 *   - Chart.js 水平条形图绘制订单簿深度
 *     (order book Chart.js horizontal bar chart)
 *   - 右侧信号面板 + 流动性预警
 *     (signal panel + alerts)
 */

(function () {
  const els = {
    symbol: document.getElementById('symbol'),
    market: document.getElementById('market'),
    interval: document.getElementById('interval'),
    refresh: document.getElementById('refresh'),
    auto: document.getElementById('auto'),
    status: document.getElementById('status'),
    mainChart: document.getElementById('main-chart'),
    volumePane: document.getElementById('volume-pane'),
    cvdPane: document.getElementById('cvd-pane'),
    orderbookCanvas: document.getElementById('orderbook-chart'),
    mainMeta: document.getElementById('main-meta'),
    signalBanner: document.getElementById('signal-banner'),
    signalMeta: document.getElementById('signal-meta'),
    kvEntry: document.getElementById('kv-entry'),
    kvSL: document.getElementById('kv-sl'),
    kvRisk: document.getElementById('kv-risk'),
    kvSize: document.getElementById('kv-size'),
    kvNotional: document.getElementById('kv-notional'),
    tpList: document.getElementById('tp-list'),
    longConditions: document.getElementById('long-conditions'),
    shortConditions: document.getElementById('short-conditions'),
    alerts: document.getElementById('alerts'),
    snapshot: document.getElementById('snapshot')
  };

  const POLL_INTERVAL_MS = 10000;
  let pollTimer = null;
  let autoOn = true;

  // ---- 主图 K 线 (Main candlestick chart · Lightweight Charts) ----
  const mainChart = LightweightCharts.createChart(els.mainChart, {
    layout: {
      background: { color: 'transparent' },
      textColor: '#9aa7b8'
    },
    grid: {
      vertLines: { color: '#1f2837' },
      horzLines: { color: '#1f2837' }
    },
    crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
    rightPriceScale: { borderColor: '#1f2837' },
    timeScale: { borderColor: '#1f2837', timeVisible: true, secondsVisible: false }
  });
  const candleSeries = mainChart.addCandlestickSeries({
    upColor: '#4ade80',
    downColor: '#f87171',
    borderUpColor: '#4ade80',
    borderDownColor: '#f87171',
    wickUpColor: '#4ade80',
    wickDownColor: '#f87171'
  });
  const vwapSeries = mainChart.addLineSeries({
    color: '#facc15',
    lineWidth: 2,
    title: 'VWAP'
  });

  // ---- 副图：成交量 (Volume chart · separate Lightweight Charts instance) ----
  const volumeChart = LightweightCharts.createChart(els.volumePane, {
    layout: { background: { color: 'transparent' }, textColor: '#9aa7b8' },
    grid: {
      vertLines: { color: '#1f2837' },
      horzLines: { color: '#1f2837' }
    },
    timeScale: { timeVisible: true, secondsVisible: false, borderColor: '#1f2837' },
    rightPriceScale: { borderColor: '#1f2837' }
  });
  const volumeSeries = volumeChart.addHistogramSeries({
    color: '#60a5fa',
    priceFormat: { type: 'volume' }
  });

  // ---- 副图：CVD 累积曲线 (CVD chart) ----
  const cvdChart = LightweightCharts.createChart(els.cvdPane, {
    layout: { background: { color: 'transparent' }, textColor: '#9aa7b8' },
    grid: {
      vertLines: { color: '#1f2837' },
      horzLines: { color: '#1f2837' }
    },
    timeScale: { timeVisible: true, secondsVisible: false, borderColor: '#1f2837' },
    rightPriceScale: { borderColor: '#1f2837' }
  });
  const cvdSeries = cvdChart.addLineSeries({
    color: '#4ade80',
    lineWidth: 2
  });

  // 窗口尺寸变化重排 (Resize handlers) -------------------------------------
  function fitCharts() {
    mainChart.resize(els.mainChart.clientWidth, els.mainChart.clientHeight);
    volumeChart.resize(els.volumePane.clientWidth, els.volumePane.clientHeight);
    cvdChart.resize(els.cvdPane.clientWidth, els.cvdPane.clientHeight);
  }
  window.addEventListener('resize', fitCharts);

  // ---- 订单簿深度图 (Order book · Chart.js) ----
  let orderbookChart = null;
  function ensureOrderbookChart() {
    if (orderbookChart) return orderbookChart;
    const ctx = els.orderbookCanvas.getContext('2d');
    orderbookChart = new Chart(ctx, {
      type: 'bar',
      data: {
        labels: [],
        datasets: [
          {
            label: '买单累计 / Bids (cum.)',
            data: [],
            backgroundColor: 'rgba(74, 222, 128, 0.5)',
            borderColor: 'rgba(74, 222, 128, 1)',
            borderWidth: 1
          },
          {
            label: '卖单累计 / Asks (cum.)',
            data: [],
            backgroundColor: 'rgba(248, 113, 113, 0.5)',
            borderColor: 'rgba(248, 113, 113, 1)',
            borderWidth: 1
          }
        ]
      },
      options: {
        indexAxis: 'y',
        responsive: true,
        maintainAspectRatio: false,
        // 修复 tooltip 不灵敏：mode:'index' + intersect:false 让光标
        // 在条形图区域任意位置都能触发同价位档的 tooltip。
        // (Make tooltip & hover responsive across the whole bar area.)
        interaction: {
          mode: 'index',
          intersect: false,
          axis: 'y'
        },
        plugins: {
          legend: { labels: { color: '#9aa7b8', boxWidth: 12 } },
          tooltip: {
            mode: 'index',
            intersect: false,
            backgroundColor: '#11161f',
            borderColor: '#1f2837',
            borderWidth: 1,
            titleColor: '#e6edf3',
            bodyColor: '#9aa7b8',
            callbacks: {
              title: (items) => {
                if (!items.length) return '';
                return '价位 / Price: ' + items[0].label;
              },
              label: (item) => {
                const v = Number(item.raw) || 0;
                if (v <= 0) return null;
                return `${item.dataset.label}: ${v.toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
              }
            }
          }
        },
        hover: {
          mode: 'index',
          intersect: false
        },
        scales: {
          x: {
            ticks: { color: '#5e6b7c' },
            grid: { color: '#1f2837' }
          },
          y: {
            ticks: { color: '#9aa7b8', autoSkip: true, maxTicksLimit: 18 },
            grid: { color: '#1f2837' }
          }
        }
      }
    });
    return orderbookChart;
  }

  // ---- 工具函数 (Helpers) ----
  function setStatus(text, isError = false) {
    els.status.textContent = text;
    els.status.classList.toggle('error', !!isError);
  }

  function fmt(n, digits = 2) {
    if (n === null || n === undefined || Number.isNaN(n)) return '-';
    if (Math.abs(n) >= 1000) return Number(n).toLocaleString('en-US', { maximumFractionDigits: digits });
    if (Math.abs(n) < 0.01 && n !== 0) return Number(n).toExponential(2);
    return Number(n).toFixed(digits);
  }

  function fmtPct(n, digits = 2) {
    if (n === null || n === undefined || Number.isNaN(n)) return '-';
    return (Number(n) * 100).toFixed(digits) + '%';
  }

  function toLwSeconds(ms) {
    return Math.floor(Number(ms) / 1000);
  }

  // 普通获取 (Strict): 失败抛错
  async function fetchJson(url) {
    const r = await fetch(url);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const j = await r.json();
    if (!j.success) throw new Error(j.error || 'Unknown error');
    return j.data;
  }

  // 容错获取 (Soft): 失败返回 null + console.warn，不影响其它面板。
  // 把上一轮失败原因暂存到 fetchJsonSoft.lastErrors，方便状态栏展示。
  // (Soft fetch: returns null on failure and stashes the reason on
  //  fetchJsonSoft.lastErrors so the status bar can display it.)
  fetchJsonSoft.lastErrors = {};
  async function fetchJsonSoft(url) {
    try {
      const r = await fetch(url);
      const j = await r.json();
      if (!j.success) {
        // eslint-disable-next-line no-console
        console.warn('soft-fetch failed:', url, j.error);
        fetchJsonSoft.lastErrors[url] = j.error || 'unknown';
        return null;
      }
      delete fetchJsonSoft.lastErrors[url];
      return j.data;
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('soft-fetch threw:', url, err.message);
      fetchJsonSoft.lastErrors[url] = err.message;
      return null;
    }
  }

  // ---- 主图右键菜单 / 复制价格 (Main chart context menu) ----
  // 缓存最近一次渲染的 K 线，便于右键时定位 OHLC
  // (Cache last-rendered candles so context menu can show OHLC for the
  //  bar under the cursor.)
  let lastCandles = [];
  let ctxMenuEl = null;
  let copyToastEl = null;
  let copyToastTimer = null;

  function getMainSymbolMeta() {
    return {
      symbol: (els.symbol.value || '').trim().toUpperCase() || 'BTCUSDT',
      market: els.market.value,
      interval: els.interval.value
    };
  }

  // 自动决定价格小数位：>=1000 取 2 位，>=1 取 4 位，更小取 6 位
  // (Auto-pick price precision so BTC/SOL/小币 都得到合理的显示。)
  function pickPriceDigits(price) {
    if (price == null || !Number.isFinite(price)) return 4;
    const ap = Math.abs(price);
    if (ap >= 1000) return 2;
    if (ap >= 1) return 4;
    if (ap >= 0.01) return 5;
    return 8;
  }
  function fmtPrice(price) {
    if (price == null || !Number.isFinite(price)) return '-';
    return Number(price).toFixed(pickPriceDigits(price));
  }

  async function copyToClipboard(text) {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch (_) { /* fall through */ }
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.left = '-9999px';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return ok;
    } catch (_) {
      return false;
    }
  }

  function showCopyToast(text, isError = false) {
    if (!copyToastEl) {
      copyToastEl = document.createElement('div');
      copyToastEl.className = 'copy-toast';
      document.body.appendChild(copyToastEl);
    }
    copyToastEl.textContent = text;
    copyToastEl.classList.toggle('error', !!isError);
    void copyToastEl.offsetWidth;
    copyToastEl.classList.add('show');
    if (copyToastTimer) clearTimeout(copyToastTimer);
    copyToastTimer = setTimeout(() => {
      if (copyToastEl) copyToastEl.classList.remove('show');
    }, 1400);
  }

  function hideCtxMenu() {
    if (ctxMenuEl && ctxMenuEl.parentNode) {
      ctxMenuEl.parentNode.removeChild(ctxMenuEl);
    }
    ctxMenuEl = null;
  }

  function findCandleByTime(timeSec) {
    if (!Array.isArray(lastCandles) || lastCandles.length === 0 || timeSec == null) {
      return null;
    }
    let best = null;
    let bestDiff = Infinity;
    for (const c of lastCandles) {
      const ts = toLwSeconds(c.openTime);
      const d = Math.abs(ts - timeSec);
      if (d < bestDiff) { bestDiff = d; best = c; }
    }
    return best;
  }

  function buildCtxMenu(items, header) {
    hideCtxMenu();
    const menu = document.createElement('div');
    menu.className = 'ctx-menu';
    if (header) {
      const h = document.createElement('div');
      h.className = 'ctx-header';
      h.textContent = header;
      menu.appendChild(h);
    }
    items.forEach((it, idx) => {
      if (it === 'divider') {
        const d = document.createElement('div');
        d.className = 'ctx-divider';
        menu.appendChild(d);
        return;
      }
      const row = document.createElement('div');
      row.className = 'ctx-item';
      row.innerHTML =
        `<span class="ctx-label">${it.label}</span>` +
        `<span class="ctx-value">${it.display ?? it.value}</span>`;
      row.addEventListener('click', async () => {
        const ok = await copyToClipboard(String(it.value));
        if (ok) showCopyToast(`已复制 / Copied · ${it.label}: ${it.display ?? it.value}`);
        else showCopyToast('复制失败 / Copy failed', true);
        hideCtxMenu();
      });
      menu.appendChild(row);
    });
    return menu;
  }

  function showCtxMenuAt(clientX, clientY, items, header) {
    const menu = buildCtxMenu(items, header);
    menu.style.left = '0px';
    menu.style.top = '0px';
    menu.style.visibility = 'hidden';
    document.body.appendChild(menu);
    ctxMenuEl = menu;
    const rect = menu.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let x = clientX;
    let y = clientY;
    if (x + rect.width + 8 > vw) x = vw - rect.width - 8;
    if (y + rect.height + 8 > vh) y = vh - rect.height - 8;
    if (x < 4) x = 4;
    if (y < 4) y = 4;
    menu.style.left = x + 'px';
    menu.style.top = y + 'px';
    menu.style.visibility = 'visible';
  }

  function onMainChartContextMenu(ev) {
    ev.preventDefault();
    const rect = els.mainChart.getBoundingClientRect();
    const x = ev.clientX - rect.left;
    const y = ev.clientY - rect.top;

    // Y 轴坐标 -> 价格（鼠标位置对应的纵轴价位）
    const cursorPrice = candleSeries.coordinateToPrice(y);
    // X 轴坐标 -> 时间，找到对应 K 线
    const ts = mainChart.timeScale().coordinateToTime(x);
    const candle = findCandleByTime(typeof ts === 'number' ? ts : null);

    const meta = getMainSymbolMeta();
    const items = [];
    if (cursorPrice != null && Number.isFinite(cursorPrice)) {
      const v = Number(cursorPrice).toFixed(pickPriceDigits(cursorPrice));
      items.push({
        label: '光标价 / Cursor Price',
        value: v,
        display: v
      });
    }
    if (candle) {
      items.push('divider');
      items.push({ label: '开 / Open',  value: fmtPrice(candle.open),  display: fmtPrice(candle.open) });
      items.push({ label: '高 / High',  value: fmtPrice(candle.high),  display: fmtPrice(candle.high) });
      items.push({ label: '低 / Low',   value: fmtPrice(candle.low),   display: fmtPrice(candle.low) });
      items.push({ label: '收 / Close', value: fmtPrice(candle.close), display: fmtPrice(candle.close) });
      if (candle.vwap != null && Number.isFinite(candle.vwap)) {
        items.push({ label: 'VWAP', value: fmtPrice(candle.vwap), display: fmtPrice(candle.vwap) });
      }
    }
    if (items.length === 0) {
      // 没有可用价格（比如鼠标在空白区域），仍然给一个提示项
      items.push({ label: '无价格 / No price', value: '', display: '-' });
    }

    let header = `${meta.symbol} · ${meta.market} · ${meta.interval}`;
    if (candle) {
      const t = new Date(candle.openTime);
      header += ` · ${t.toLocaleString('zh-CN', {
        month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'
      })}`;
    }
    showCtxMenuAt(ev.clientX, ev.clientY, items, header);
  }

  els.mainChart.addEventListener('contextmenu', onMainChartContextMenu);
  // 在菜单上右键也阻止默认浏览器菜单（保持自定义菜单一致）
  document.addEventListener('contextmenu', (e) => {
    if (ctxMenuEl && ctxMenuEl.contains(e.target)) e.preventDefault();
  });
  // 任意位置点击 / Esc / 滚动 / 失焦 都关闭菜单
  document.addEventListener('mousedown', (e) => {
    if (ctxMenuEl && !ctxMenuEl.contains(e.target)) hideCtxMenu();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') hideCtxMenu();
  });
  window.addEventListener('blur', hideCtxMenu);
  window.addEventListener('resize', hideCtxMenu);
  els.mainChart.addEventListener('wheel', hideCtxMenu, { passive: true });

  // ---- 各种渲染器 (Renderers) ----
  function renderMain(klinesData) {
    const { candles, fvgs = [], liquidityVoids = [], summary } = klinesData;
    if (!candles.length) return;
    lastCandles = candles;

    const mapped = candles.map((c) => ({
      time: toLwSeconds(c.openTime),
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close
    }));
    candleSeries.setData(mapped);

    const vwapPoints = candles
      .map((c) => ({ time: toLwSeconds(c.openTime), value: c.vwap }))
      .filter((p) => p.value !== null && Number.isFinite(p.value));
    vwapSeries.setData(vwapPoints);

    // 在主 K 线上绘制 FVG / 流动性空白的标记
    // (Markers for FVGs and liquidity voids on the candle series.)
    const markers = [];
    for (const f of fvgs.slice(-15)) {
      const ts = toLwSeconds(f.startTime);
      markers.push({
        time: ts,
        position: f.type === 'bullish' ? 'belowBar' : 'aboveBar',
        color: f.type === 'bullish' ? '#4ade80' : '#f87171',
        shape: f.type === 'bullish' ? 'arrowUp' : 'arrowDown',
        text: 'FVG'
      });
    }
    for (const v of liquidityVoids.slice(-8)) {
      markers.push({
        time: toLwSeconds(v.startTime),
        position: 'inBar',
        color: '#facc15',
        shape: 'circle',
        text: 'VOID'
      });
    }
    candleSeries.setMarkers(markers);

    // 用横向价格线模拟 FVG 区间上下沿
    // (Price lines: outline FVG zones using horizontal price lines on the
    //  candlestick series. lightweight-charts standalone build has no
    //  native rectangle API, so we approximate with price lines.)
    if (renderMain._priceLines) {
      for (const pl of renderMain._priceLines) candleSeries.removePriceLine(pl);
    }
    const priceLines = [];
    for (const f of fvgs.slice(-3)) {
      priceLines.push(candleSeries.createPriceLine({
        price: f.upper,
        color: f.type === 'bullish' ? 'rgba(74, 222, 128, 0.6)' : 'rgba(248, 113, 113, 0.6)',
        lineStyle: LightweightCharts.LineStyle.Dashed,
        lineWidth: 1,
        axisLabelVisible: false,
        title: `FVG ${f.type === 'bullish' ? '↑' : '↓'} top`
      }));
      priceLines.push(candleSeries.createPriceLine({
        price: f.lower,
        color: f.type === 'bullish' ? 'rgba(74, 222, 128, 0.4)' : 'rgba(248, 113, 113, 0.4)',
        lineStyle: LightweightCharts.LineStyle.Dotted,
        lineWidth: 1,
        axisLabelVisible: false,
        title: `FVG ${f.type === 'bullish' ? '↑' : '↓'} bot`
      }));
    }
    renderMain._priceLines = priceLines;

    els.mainMeta.textContent =
      `${summary.symbol} · ${summary.market} · ${summary.interval} · ${summary.count} bars`;

    const volumeData = candles.map((c) => ({
      time: toLwSeconds(c.openTime),
      value: c.volume,
      color: c.close >= c.open ? 'rgba(74, 222, 128, 0.6)' : 'rgba(248, 113, 113, 0.6)'
    }));
    volumeSeries.setData(volumeData);

    mainChart.timeScale().fitContent();
    volumeChart.timeScale().fitContent();
  }

  function renderCvd(tradeData) {
    const points = (tradeData.cvdSeries || [])
      .map((p) => ({ time: toLwSeconds(p.time), value: p.value }))
      .filter((p) => Number.isFinite(p.value));
    // Lightweight-charts 要求时间戳严格递增，需去重
    // (Lightweight-charts requires strictly increasing time; dedupe by time.)
    const dedup = [];
    let lastTs = -Infinity;
    for (const p of points) {
      if (p.time > lastTs) {
        dedup.push(p);
        lastTs = p.time;
      } else if (dedup.length) {
        dedup[dedup.length - 1].value = p.value;
      }
    }
    cvdSeries.setData(dedup);
    cvdChart.timeScale().fitContent();
  }

  function renderOrderBook(book) {
    const chart = ensureOrderbookChart();
    const bids = (book.bids || []).slice(0, 18);
    const asks = (book.asks || []).slice(0, 18);

    // 聚合 (价 -> 名义额) 并按价格升序排列
    // (Aggregate (price -> notional) and arrange bids ASC, asks ASC by price.)
    const bidSorted = [...bids].sort((a, b) => Number(a[0]) - Number(b[0]));
    const askSorted = [...asks].sort((a, b) => Number(a[0]) - Number(b[0]));

    const labels = [
      ...bidSorted.map((l) => Number(l[0]).toFixed(2)),
      ...askSorted.map((l) => Number(l[0]).toFixed(2))
    ];

    const bidValues = [
      ...bidSorted.map((l) => Number(l[0]) * Number(l[1])),
      ...askSorted.map(() => 0)
    ];
    const askValues = [
      ...bidSorted.map(() => 0),
      ...askSorted.map((l) => Number(l[0]) * Number(l[1]))
    ];

    chart.data.labels = labels;
    chart.data.datasets[0].data = bidValues;
    chart.data.datasets[1].data = askValues;
    chart.update('none');
  }

  function renderSignal(sig) {
    const banner = els.signalBanner;
    banner.classList.remove('long', 'short', 'none');
    if (sig.signal === 'LONG') {
      banner.classList.add('long');
      banner.textContent = '🟢 做多 LONG · 入场 / Enter Long';
    } else if (sig.signal === 'SHORT') {
      banner.classList.add('short');
      banner.textContent = '🔴 做空 SHORT · 入场 / Enter Short';
    } else {
      banner.classList.add('none');
      banner.textContent = '⚪ 无信号 NONE · 暂无入场 / No Setup';
    }
    els.signalMeta.textContent = sig.indicatorsSnapshot
      ? `${sig.indicatorsSnapshot.symbol || ''} · ${sig.indicatorsSnapshot.market || ''}`
      : '';

    els.kvEntry.textContent = sig.entryPrice == null ? '-' : fmt(sig.entryPrice, 4);
    els.kvSL.textContent = sig.stopLoss == null ? '-' : fmt(sig.stopLoss, 4);
    els.kvSL.className = 'value ' + (sig.signal === 'LONG' ? 'down' : sig.signal === 'SHORT' ? 'up' : '');
    els.kvRisk.textContent = sig.riskAmount == null ? '-' : fmt(sig.riskAmount, 2);
    els.kvSize.textContent = sig.positionSize == null ? '-' : fmt(sig.positionSize, 6);
    els.kvNotional.textContent = sig.positionSizeQuote == null ? '-' : fmt(sig.positionSizeQuote, 2);

    els.tpList.innerHTML = '';
    if (Array.isArray(sig.takeProfits)) {
      sig.takeProfits.forEach((tp, i) => {
        const row = document.createElement('div');
        row.className = 'tp-item';
        row.innerHTML = `
          <span class="tp-label">止盈 TP${i + 1}</span>
          <span class="tp-price">${fmt(tp.price, 4)}</span>
          <span class="tp-fraction">平仓 / Close ${(tp.closeFraction * 100).toFixed(0)}%</span>
        `;
        els.tpList.appendChild(row);
      });
    }

    const snap = sig.indicatorsSnapshot || {};
    const longConds = snap.longConditions || {};
    const shortConds = snap.shortConditions || {};
    const condLabels = {
      bullishFvg: '看涨 FVG / Bullish FVG',
      depthDominant: '深度比 > 0.6 / depthRatio>0.6',
      cvdPriceUp: 'CVD↑ & 价↑ / CVD up & price up',
      liquidityHealthy: '流动性健康 / Liquidity OK',
      aboveVwap: '价 > VWAP / price>VWAP',
      bearishFvg: '看跌 FVG / Bearish FVG',
      depthDominantSell: '深度比 < -0.6 / depthRatio<-0.6',
      cvdPriceDown: 'CVD↓ & 价↓ / CVD down & price down',
      belowVwap: '价 < VWAP / price<VWAP'
    };
    function paintCond(target, conds) {
      target.innerHTML = '';
      Object.entries(conds).forEach(([k, v]) => {
        const div = document.createElement('div');
        div.className = 'cond ' + (v ? 'ok' : 'bad');
        div.innerHTML = `<span class="dot"></span><span>${condLabels[k] || k}</span>`;
        target.appendChild(div);
      });
    }
    paintCond(els.longConditions, longConds);
    paintCond(els.shortConditions, shortConds);

    els.snapshot.innerHTML = '';
    const kv = (label, value) => {
      els.snapshot.insertAdjacentHTML(
        'beforeend',
        `<div class="label">${label}</div><div class="value">${value}</div>`
      );
    };
    kv('最新价 / Last Price', fmt(snap.latestPrice, 4));
    kv('成交量加权均价 / VWAP', fmt(snap.vwap, 4));
    kv('平均真实波幅 / ATR(14)', fmt(snap.atr, 4));
    kv('深度比 / Depth Ratio', fmt(snap.depthRatio, 3));
    kv('价差 / Spread', fmt(snap.spread, 4));
    kv('累计成交量差值 / CVD', fmt(snap.cvd, 3));
    kv('CVD~价格相关性 / CVD~Price ρ', fmt(snap.cvdPriceCorr, 3));
    kv('最新非流动性 / ILLIQ (latest)', snap.latestIlliq == null ? '-' : Number(snap.latestIlliq).toExponential(2));
    kv('平均非流动性 / ILLIQ (μ)', snap.illiqMean == null ? '-' : Number(snap.illiqMean).toExponential(2));
    kv('多头评分 / Long Score', String(snap.longScore ?? '-'));
    kv('空头评分 / Short Score', String(snap.shortScore ?? '-'));
  }

  function renderAlerts(alertData) {
    const flagLabels = {
      spreadShock: '价差异常 / Spread shock (3σ)',
      illiqShock: '低流动性 / ILLIQ shock (>2x μ)',
      depthImbalance: '深度失衡 / Depth imbalance (>0.8)',
      vwapDeviation: 'VWAP 偏离 / VWAP dev >2%',
      cvdPriceDivergence: 'CVD/价格背离 / CVD-Price divergence'
    };
    els.alerts.innerHTML = '';
    Object.entries(flagLabels).forEach(([k, label]) => {
      const on = !!(alertData.flags && alertData.flags[k]);
      const row = document.createElement('div');
      row.className = 'alert-row ' + (on ? 'on' : 'off');
      row.innerHTML = `<span>${label}</span><span>${on ? '触发 / ALERT' : '-'}</span>`;
      els.alerts.appendChild(row);
    });
    const score = alertData.riskScore || 0;
    const summary = document.createElement('div');
    summary.className = 'alert-row ' + (score > 0 ? 'on' : 'off');
    summary.innerHTML = `<strong>综合风险分数 / Risk Score</strong><strong>${score}/5</strong>`;
    els.alerts.appendChild(summary);
  }

  // ---- 主轮询循环 (Main poll cycle) ----
  let inFlight = false;
  async function poll() {
    if (inFlight) return;
    inFlight = true;
    const symbol = els.symbol.value.trim().toUpperCase() || 'BTCUSDT';
    const market = els.market.value;
    const interval = els.interval.value;
    setStatus('请求数据中… / Fetching…');
    const startedAt = Date.now();
    try {
      // 用 fetchJsonSoft，单一端点失败不会拖垮整个面板
      // (Use soft fetch so a single failed endpoint doesn't blank the dashboard.)
      const [kData, obData, tdData, signal, alerts] = await Promise.all([
        fetchJsonSoft(`/api/klines?symbol=${symbol}&interval=${interval}&limit=200&market=${market}&detectPatterns=true`),
        fetchJsonSoft(`/api/orderbook/indicators?symbol=${symbol}&depth=20&market=${market}`),
        fetchJsonSoft(`/api/trade/indicators?symbol=${symbol}&limit=500&market=${market}`),
        fetchJsonSoft(`/api/trade/signal?symbol=${symbol}&market=${market}`),
        fetchJsonSoft(`/api/alerts/liquidity?symbol=${symbol}&market=${market}`)
      ]);

      const failed = [];
      if (kData) renderMain(kData); else failed.push('klines');
      if (obData) renderOrderBook(obData); else failed.push('orderbook');
      if (tdData) renderCvd(tdData); else failed.push('trades');
      if (signal) renderSignal(signal); else failed.push('signal');
      if (alerts) renderAlerts(alerts); else failed.push('alerts');
      fitCharts();

      const elapsed = Date.now() - startedAt;
      if (failed.length) {
        // 取第一条具体错误信息展示在状态栏（便于一眼看出 403 / ECONNRESET 等）
        // (Surface the first concrete error so 403 / ECONNRESET is visible at a glance.)
        const firstErr = Object.values(fetchJsonSoft.lastErrors)[0] || '';
        const detail = firstErr ? ` — ${firstErr}` : '';
        setStatus(
          `部分失败 / Partial: ${failed.join(',')} · ${new Date().toLocaleTimeString()} (${elapsed}ms)${detail}`,
          true
        );
      } else {
        setStatus(`已更新 / Updated · ${new Date().toLocaleTimeString()} (${elapsed}ms)`);
      }
    } catch (err) {
      setStatus('错误 / Error: ' + err.message, true);
      // eslint-disable-next-line no-console
      console.error(err);
    } finally {
      inFlight = false;
    }
  }

  function startAutoPoll() {
    stopAutoPoll();
    pollTimer = setInterval(poll, POLL_INTERVAL_MS);
  }
  function stopAutoPoll() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  }

  els.refresh.addEventListener('click', poll);
  els.symbol.addEventListener('change', poll);
  els.market.addEventListener('change', poll);
  els.interval.addEventListener('change', poll);
  els.auto.addEventListener('click', () => {
    autoOn = !autoOn;
    els.auto.textContent = autoOn
      ? '自动 10s · 开 / Auto · ON'
      : '自动 10s · 关 / Auto · OFF';
    if (autoOn) startAutoPoll();
    else stopAutoPoll();
  });

  // ============================================================
  // 飞书推送 (Feishu push controls)
  // ============================================================
  const fsEls = {
    push: document.getElementById('fs-push'),
    pushForce: document.getElementById('fs-push-force'),
    test: document.getElementById('fs-test'),
    status: document.getElementById('fs-status')
  };

  function setFsStatus(text, kind) {
    if (!fsEls.status) return;
    fsEls.status.textContent = text;
    fsEls.status.classList.remove('ok', 'error', 'warn');
    if (kind) fsEls.status.classList.add(kind);
  }

  async function refreshFeishuStatus() {
    try {
      const r = await fetch('/api/notify/status');
      const j = await r.json();
      if (!j.success) throw new Error(j.error || 'unknown');
      const d = j.data;
      if (!d.enabled) {
        setFsStatus('飞书未配置 / Webhook not configured (.env)', 'warn');
        if (fsEls.push) fsEls.push.disabled = true;
        if (fsEls.pushForce) fsEls.pushForce.disabled = true;
        if (fsEls.test) fsEls.test.disabled = true;
        return;
      }
      const symKey = `${(els.symbol.value || 'BTCUSDT').toUpperCase()}|${els.market.value}`;
      const last = d.lastNotified[symKey];
      const fvg = d.fvgState && d.fvgState[symKey];
      const cooldownMin = Math.round((d.cooldownMs || 0) / 60000);
      let lastTxt = last
        ? `上次信号 ${last.signal} @ ${new Date(last.ts).toLocaleTimeString()}`
        : '尚未推送信号 / no signals pushed';
      let fvgTxt = '';
      if (fvg) {
        fvgTxt = ` · FVG 已推 ${fvg.count} 条`;
        if (fvg.baseline && fvg.count === 0) fvgTxt += '（baseline）';
      }
      const sig = d.signedRequest ? '签名' : '无签名';
      setFsStatus(`飞书已就绪 / Ready · ${sig} · 冷却 ${cooldownMin}min · ${lastTxt}${fvgTxt}`, 'ok');
    } catch (err) {
      setFsStatus('飞书状态获取失败 / Status err: ' + err.message, 'error');
    }
  }

  async function pushFeishuSignal(force) {
    setFsStatus(force ? '强制推送中… / Forcing…' : '推送中… / Pushing…');
    try {
      const r = await fetch('/api/notify/signal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          symbol: els.symbol.value.trim().toUpperCase() || 'BTCUSDT',
          market: els.market.value,
          force: !!force
        })
      });
      const j = await r.json();
      if (j.success) {
        setFsStatus(`已推送 / Pushed · ${j.data.signal} · ${new Date().toLocaleTimeString()}`, 'ok');
      } else {
        setFsStatus('推送跳过 / Skip: ' + j.error, 'warn');
      }
    } catch (err) {
      setFsStatus('推送失败 / Failed: ' + err.message, 'error');
    } finally {
      // 任何分支后都刷新一下状态以显示最新 lastNotified
      setTimeout(refreshFeishuStatus, 1000);
    }
  }

  async function testFeishuWebhook() {
    setFsStatus('测试中… / Testing…');
    try {
      const r = await fetch('/api/notify/test', { method: 'POST' });
      const j = await r.json();
      if (j.success) setFsStatus('测试消息已送达 / Test delivered ✓', 'ok');
      else setFsStatus('测试失败 / Test failed: ' + j.error, 'error');
    } catch (err) {
      setFsStatus('测试失败 / Test failed: ' + err.message, 'error');
    }
  }

  if (fsEls.push) fsEls.push.addEventListener('click', () => pushFeishuSignal(false));
  if (fsEls.pushForce) fsEls.pushForce.addEventListener('click', () => pushFeishuSignal(true));
  if (fsEls.test) fsEls.test.addEventListener('click', testFeishuWebhook);
  // 启动时拉一下飞书状态；symbol/market 改变时也刷新
  refreshFeishuStatus();
  els.symbol.addEventListener('change', refreshFeishuStatus);
  els.market.addEventListener('change', refreshFeishuStatus);

  // ============================================================
  // 30 天回测面板 (30-day backtest panel)
  // ============================================================
  const btEls = {
    days: document.getElementById('bt-days'),
    capital: document.getElementById('bt-capital'),
    risk: document.getElementById('bt-risk'),
    run: document.getElementById('bt-run'),
    status: document.getElementById('bt-status'),
    final: document.getElementById('bt-final'),
    pnl: document.getElementById('bt-pnl'),
    ret: document.getElementById('bt-return'),
    trades: document.getElementById('bt-trades'),
    winrate: document.getElementById('bt-winrate'),
    payoff: document.getElementById('bt-payoff'),
    pf: document.getElementById('bt-pf'),
    mdd: document.getElementById('bt-mdd'),
    exp: document.getElementById('bt-exp'),
    period: document.getElementById('bt-period'),
    canvas: document.getElementById('bt-equity-chart'),
    notes: document.getElementById('bt-notes'),
    notesBody: document.getElementById('bt-notes-body'),
    skipped: document.getElementById('bt-skipped'),
    skippedBody: document.getElementById('bt-skipped-body'),
    warnings: document.getElementById('bt-warnings'),
    source: document.getElementById('bt-source'),
    tradesWrap: document.getElementById('bt-trades-wrap'),
    tradesBody: document.getElementById('bt-trades-body')
  };
  let equityChart = null;

  function setBtStatus(text, isError = false) {
    btEls.status.textContent = text;
    btEls.status.classList.toggle('error', !!isError);
  }
  function setVal(el, text, cls) {
    el.textContent = text;
    el.classList.remove('up', 'down');
    if (cls) el.classList.add(cls);
  }

  function ensureEquityChart() {
    if (equityChart) return equityChart;
    const ctx = btEls.canvas.getContext('2d');
    equityChart = new Chart(ctx, {
      type: 'line',
      data: { labels: [], datasets: [
        {
          label: '资金曲线 / Equity',
          data: [],
          borderColor: '#60a5fa',
          backgroundColor: 'rgba(96, 165, 250, 0.15)',
          borderWidth: 1.5,
          pointRadius: 0,
          fill: true,
          tension: 0.1
        }
      ] },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false, axis: 'x' },
        plugins: {
          legend: { labels: { color: '#9aa7b8', boxWidth: 12 } },
          tooltip: {
            mode: 'index',
            intersect: false,
            backgroundColor: '#11161f',
            borderColor: '#1f2837',
            borderWidth: 1,
            titleColor: '#e6edf3',
            bodyColor: '#9aa7b8',
            callbacks: {
              title: (items) => items.length ? items[0].label : '',
              label: (item) => `${item.dataset.label}: ${Number(item.raw).toFixed(2)} USDT`
            }
          }
        },
        hover: { mode: 'index', intersect: false },
        scales: {
          x: {
            ticks: { color: '#5e6b7c', maxTicksLimit: 8 },
            grid: { color: '#1f2837' }
          },
          y: {
            ticks: { color: '#9aa7b8' },
            grid: { color: '#1f2837' }
          }
        }
      }
    });
    return equityChart;
  }

  function renderBacktest(data) {
    const s = data.summary || {};
    const initialCapital = s.initialCapital || data.initialBalance || 1000;
    setVal(btEls.final, fmt(s.finalBalance, 2), s.finalBalance >= initialCapital ? 'up' : 'down');
    setVal(btEls.pnl, fmt(s.totalPnl, 2), s.totalPnl >= 0 ? 'up' : 'down');
    setVal(btEls.ret, (Number(s.totalReturnPct || 0) * 100).toFixed(2) + '%', s.totalReturnPct >= 0 ? 'up' : 'down');
    // 用户口径：TP1胜 / SL负 / 其它（time-stop / EOD）未结
    const wins = s.winningTrades || s.wins || 0;
    const lossesN = s.losingTrades || s.losses || 0;
    const openEnded = s.openEndedTrades || 0;
    setVal(btEls.trades, `${s.totalTrades || 0} (TP1胜 ${wins} / SL负 ${lossesN} / 未结 ${openEnded})`);
    setVal(btEls.winrate, ((s.winRate || 0) * 100).toFixed(1) + '%');
    setVal(btEls.payoff, s.payoffRatio == null ? '∞' : fmt(s.payoffRatio, 2));
    setVal(btEls.pf, s.profitFactor == null ? '∞' : fmt(s.profitFactor, 2));
    setVal(btEls.mdd, (s.maxDrawdownPct || 0).toFixed(2) + '%', 'down');
    setVal(btEls.exp, fmt(s.expectancy, 2), s.expectancy >= 0 ? 'up' : 'down');
    setVal(btEls.period, fmt(s.periodDays, 2));

    // 资金曲线 / Equity curve
    const chart = ensureEquityChart();
    const curve = data.equityCurve || [];
    chart.data.labels = curve.map((p) => new Date(p.time).toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' }));
    chart.data.datasets[0].data = curve.map((p) => Number(p.equity));
    chart.update('none');

    // 真实数据声明 / Real-data manifest
    const noteList = Array.isArray(data.noteList) && data.noteList.length
      ? data.noteList
      : (data.notes ? [data.notes] : []);
    if (noteList.length) {
      btEls.notes.style.display = '';
      btEls.notesBody.innerHTML = noteList
        .map((n) => `<div style="margin-top:4px">• ${escapeHtml(n)}</div>`)
        .join('');
    } else {
      btEls.notes.style.display = 'none';
    }

    // 未参与回测的指标 / Skipped indicators
    const skipped = Array.isArray(data.skippedIndicators) ? data.skippedIndicators : [];
    if (skipped.length) {
      btEls.skipped.style.display = '';
      btEls.skippedBody.innerHTML = skipped
        .map((n) => `<div style="margin-top:3px">• ${escapeHtml(n)}</div>`)
        .join('');
    } else {
      btEls.skipped.style.display = 'none';
    }

    // 警告 / Warnings
    const warnings = Array.isArray(data.warnings) ? data.warnings : [];
    if (warnings.length) {
      btEls.warnings.style.display = '';
      btEls.warnings.innerHTML = '⚠ ' + warnings.map(escapeHtml).join(' · ');
    } else {
      btEls.warnings.style.display = 'none';
    }

    // 数据源 / Data sources
    const ds = data.dataSources || {};
    const dsLines = [];
    if (ds.klines) dsLines.push(`K 线: ${ds.klines.endpoint} · ${ds.klines.bars} 根`);
    if (ds.dailyKlines) dsLines.push(`日线 (ILLIQ): ${ds.dailyKlines.bars} 根`);
    if (ds.fundingRate) dsLines.push(`资金费率: /fapi/v1/fundingRate · ${ds.fundingRate.records} 条`);
    if (ds.aggTrades) {
      const cov = ((ds.aggTrades.coverageRatio || 0) * 100).toFixed(1);
      const mb = ((ds.aggTrades.totalBytes || 0) / 1024 / 1024).toFixed(1);
      const succ = ds.aggTrades.daysSucceeded != null ? ds.aggTrades.daysSucceeded : ds.aggTrades.daysDownloaded;
      const miss = ds.aggTrades.daysMissing || 0;
      let line = `真实成交: ${ds.aggTrades.source} · ${succ}/${ds.aggTrades.daysRequested || succ} 天成功`;
      if (miss > 0) line += ` (跳过 ${miss} 天 zip 未上架)`;
      line += ` · ${ds.aggTrades.totalProcessedRows} 笔 · ${mb} MB · 覆盖率 ${cov}%`;
      dsLines.push(line);
      if (Array.isArray(ds.aggTrades.missingDays) && ds.aggTrades.missingDays.length) {
        dsLines.push(`缺失日期 / Missing dates: ${ds.aggTrades.missingDays.join(', ')}`);
      }
    }
    if (dsLines.length) {
      btEls.source.style.display = '';
      btEls.source.innerHTML = '数据源 / Sources: <br>' + dsLines.map(escapeHtml).join('<br>');
    } else {
      btEls.source.style.display = 'none';
    }

    // 交易明细 / Trades table
    const trades = Array.isArray(data.trades) ? data.trades : [];
    if (trades.length === 0) {
      btEls.tradesWrap.style.display = 'none';
      btEls.tradesBody.innerHTML = '';
    } else {
      btEls.tradesWrap.style.display = '';
      btEls.tradesBody.innerHTML = trades.map((t) => {
        const pnl = Number(t.realizedPnl || 0);
        const sideCls = t.side === 'LONG' ? 'side-long' : 'side-short';
        const pnlCls = pnl >= 0 ? 'pnl-up' : 'pnl-down';
        // outcome 标签：胜=绿、负=红、未结=黄
        let ocCls = 'oc-open';
        let ocText = '未结 / OPEN';
        if (t.outcome === 'WIN') { ocCls = 'oc-win'; ocText = '胜 / WIN'; }
        else if (t.outcome === 'LOSS') { ocCls = 'oc-loss'; ocText = '负 / LOSS'; }
        const tp1Mark = t.tp1Hit ? '✓TP1' : '–';
        const slMark = t.slHit ? '✓SL' : '–';
        return `<tr>
          <td>${formatDateTime(t.entryTime)}</td>
          <td class="${sideCls}">${t.side}</td>
          <td class="oc ${ocCls}">${ocText}</td>
          <td>${fmt(t.entryPrice, 4)}</td>
          <td>${fmt(t.stopLoss, 4)}</td>
          <td>${tp1Mark} / ${slMark}</td>
          <td>${fmt(t.exitPrice, 4)}</td>
          <td>${escapeHtml(t.exitReason || '-')}</td>
          <td>${t.barsHeld}</td>
          <td class="${pnlCls}">${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)}</td>
        </tr>`;
      }).join('');
    }
  }

  function formatDateTime(ts) {
    if (!ts) return '-';
    const d = new Date(ts);
    return d.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  }
  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  async function runBacktest() {
    const symbol = els.symbol.value.trim().toUpperCase() || 'BTCUSDT';
    const market = els.market.value;
    const days = Number(btEls.days.value) || 30;
    const capital = Number(btEls.capital.value) || 1000;
    const risk = Number(btEls.risk.value) || 1;
    btEls.run.disabled = true;
    setBtStatus(`下载 ${days} 天真实历史成交并回测中… (Downloading + backtesting, may take several minutes)`);
    const startedAt = Date.now();
    try {
      // interval 锁定 1h，与后端 hard-constraint 对齐
      const data = await fetchJson(
        `/api/backtest/run?symbol=${symbol}&market=${market}` +
        `&days=${days}&initialBalance=${capital}&riskPercent=${risk}`
      );
      renderBacktest(data);
      const took = ((Date.now() - startedAt) / 1000).toFixed(1);
      setBtStatus(
        `完成 / Done · ${data.totalTrades || 0} 笔 · 耗时 ${took}s · ` +
        new Date().toLocaleTimeString()
      );
    } catch (err) {
      setBtStatus('错误 / Error: ' + err.message, true);
      // eslint-disable-next-line no-console
      console.error(err);
    } finally {
      btEls.run.disabled = false;
    }
  }
  btEls.run.addEventListener('click', runBacktest);

  setTimeout(() => {
    fitCharts();
    poll();
    if (autoOn) startAutoPoll();
  }, 100);
})();
