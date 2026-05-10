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
    status: document.getElementById('status'),
    mainChart: document.getElementById('main-chart'),
    volumePane: document.getElementById('volume-pane'),
    cvdPane: document.getElementById('cvd-pane'),
    oiPane: document.getElementById('oi-pane'),
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
    snapshot: document.getElementById('snapshot'),
    volTitle: document.getElementById('vol-title'),
    cvdTitle: document.getElementById('cvd-title'),
    oiTitle: document.getElementById('oi-title'),
    obTitle: document.getElementById('ob-title'),
    obBaseline: document.getElementById('ob-baseline'),
    obBaselineInfo: document.getElementById('ob-baseline-info'),
    heatmapCanvas: document.getElementById('heatmap-canvas'),
    heatmapTooltip: document.getElementById('heatmap-tooltip'),
    heatmapEmpty: document.getElementById('heatmap-empty'),
    heatmapMeta: document.getElementById('heatmap-meta'),
    heatmapWindow: document.getElementById('heatmap-window'),
    heatmapRange: document.getElementById('heatmap-range'),
    liqHeatmapCanvas: document.getElementById('liq-heatmap-canvas'),
    liqHeatmapTooltip: document.getElementById('liq-heatmap-tooltip'),
    liqHeatmapEmpty: document.getElementById('liq-heatmap-empty'),
    liqHeatmapMeta: document.getElementById('liq-heatmap-meta'),
    liqHeatmapWindow: document.getElementById('liq-heatmap-window'),
    liqHeatmapRange: document.getElementById('liq-heatmap-range'),
    liqHeatmapMode: document.getElementById('liq-heatmap-mode'),
    subCard: document.getElementById('sub-card')
  };

  // 当前周期下两个副图的取数策略
  // (Per-interval policy for sub-chart data fetching.)
  //   - CVD 是从 K 线 takerBuyBase 派生，直接跟主图同步，所以这里的"interval"
  //     就是用户在 header 里选的那个；
  //   - 订单簿是即时快照，但不同周期下展示的档位深度不同（短周期看贴盘细盘、
  //     长周期看更深的盘口墙），由 depth 决定。后端会自动把 depth 对齐到
  //     Binance 允许的合法档位 (5/10/20/50/100/500/1000) 再切片返回。
  const INTERVAL_OB_DEPTH = { '15m': 20, '1h': 50, '4h': 100, '1d': 200 };
  function obDepthForInterval(interval) {
    return INTERVAL_OB_DEPTH[interval] || 50;
  }
  function intervalLabel(interval) {
    return ({ '1s': '1 秒', '15m': '15 分钟', '1h': '1 小时', '4h': '4 小时', '1d': '1 天' }[interval]) || interval;
  }

  // Binance OI hist 仅支持 5m/15m/30m/1h/2h/4h/6h/12h/1d，其余 fallback 5m
  // (Mirror of backend mapping; used only for the title hint.)
  const OI_SUPPORTED = new Set(['5m', '15m', '30m', '1h', '2h', '4h', '6h', '12h', '1d']);
  function effectiveOiPeriod(interval) {
    return OI_SUPPORTED.has(interval) ? interval : '5m';
  }

  function refreshSubTitles() {
    const itv = els.interval.value;
    const itvLab = intervalLabel(itv);
    const market = els.market ? els.market.value : 'futures';
    if (els.volTitle) els.volTitle.textContent = `成交量 / Volume · ${itvLab}`;
    if (els.cvdTitle) els.cvdTitle.textContent = `累积主动差 / CVD · ${itvLab}`;
    if (els.obTitle)  els.obTitle.textContent  = `订单簿深度图 / Order Book Depth · 前 ${obDepthForInterval(itv)} 档`;
    if (els.oiTitle) {
      if (market !== 'futures') {
        els.oiTitle.textContent = '持仓量 / Open Interest（仅合约 · 现货无此数据）';
      } else {
        const oiP = effectiveOiPeriod(itv);
        const note = oiP === itv ? '' : `（接口最小 5m，已聚合）`;
        els.oiTitle.textContent = `持仓量 / Open Interest · ${intervalLabel(oiP)}${note}`;
      }
    }
  }

  const POLL_INTERVAL_MS = 10000;
  let pollTimer = null;

  // ===== 东八区时间统一格式化 (Beijing-time formatters · UTC+8) =====
  // 项目要求所有时间显示采用东八区，避免不同终端时区导致解读不一致。
  // (Project mandates Beijing time everywhere to keep readings consistent
  //  regardless of the viewer's local timezone.)
  const BJ_OFFSET_MS = 8 * 60 * 60 * 1000;
  function _bjShift(ms) { return new Date(Number(ms) + BJ_OFFSET_MS); }
  function _pad2(n) { return String(n).padStart(2, '0'); }
  function fmtBJDateTime(ms) {
    if (ms == null || !Number.isFinite(Number(ms))) return '-';
    const d = _bjShift(ms);
    return `${d.getUTCFullYear()}-${_pad2(d.getUTCMonth() + 1)}-${_pad2(d.getUTCDate())} ` +
           `${_pad2(d.getUTCHours())}:${_pad2(d.getUTCMinutes())}`;
  }
  function fmtBJShortDateTime(ms) {
    if (ms == null || !Number.isFinite(Number(ms))) return '-';
    const d = _bjShift(ms);
    return `${_pad2(d.getUTCMonth() + 1)}/${_pad2(d.getUTCDate())} ` +
           `${_pad2(d.getUTCHours())}:${_pad2(d.getUTCMinutes())}`;
  }
  function fmtBJDate(ms) {
    if (ms == null || !Number.isFinite(Number(ms))) return '-';
    const d = _bjShift(ms);
    return `${_pad2(d.getUTCMonth() + 1)}/${_pad2(d.getUTCDate())}`;
  }
  function fmtBJTimeHMS(ms) {
    if (ms == null || !Number.isFinite(Number(ms))) return '-';
    const d = _bjShift(ms);
    return `${_pad2(d.getUTCHours())}:${_pad2(d.getUTCMinutes())}:${_pad2(d.getUTCSeconds())}`;
  }
  // 给状态栏/小时间戳用：HH:mm:ss (BJ)
  function nowBJTimeHMS() { return fmtBJTimeHMS(Date.now()); }

  // lightweight-charts 时间轴 tick 格式化：
  // tickMarkType 枚举 0=Year, 1=Month, 2=DayOfMonth, 3=Time, 4=TimeWithSeconds
  function lwTickFormatter(timeSec, tickMarkType) {
    const ms = Number(timeSec) * 1000;
    const d = _bjShift(ms);
    switch (Number(tickMarkType)) {
      case 0: return String(d.getUTCFullYear());
      case 1: return `${d.getUTCFullYear()}-${_pad2(d.getUTCMonth() + 1)}`;
      case 2: return `${_pad2(d.getUTCMonth() + 1)}-${_pad2(d.getUTCDate())}`;
      case 3: return `${_pad2(d.getUTCHours())}:${_pad2(d.getUTCMinutes())}`;
      case 4:
      default:
        return `${_pad2(d.getUTCHours())}:${_pad2(d.getUTCMinutes())}:${_pad2(d.getUTCSeconds())}`;
    }
  }
  // crosshair 浮窗里的时间 (整段 datetime)
  const lwLocalization = {
    timeFormatter: (timeSec) => fmtBJDateTime(Number(timeSec) * 1000),
    dateFormat: 'yyyy-MM-dd'
  };

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
    timeScale: {
      borderColor: '#1f2837',
      timeVisible: true,
      secondsVisible: false,
      tickMarkFormatter: lwTickFormatter
    },
    localization: lwLocalization
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
    timeScale: {
      timeVisible: true,
      secondsVisible: false,
      borderColor: '#1f2837',
      tickMarkFormatter: lwTickFormatter
    },
    rightPriceScale: { borderColor: '#1f2837' },
    localization: lwLocalization
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
    timeScale: {
      timeVisible: true,
      secondsVisible: false,
      borderColor: '#1f2837',
      tickMarkFormatter: lwTickFormatter
    },
    rightPriceScale: { borderColor: '#1f2837' },
    localization: lwLocalization
  });
  const cvdSeries = cvdChart.addLineSeries({
    color: '#4ade80',
    lineWidth: 2
  });

  // ---- 副图：持仓量曲线 (Open Interest chart, futures only) ----
  // OI 与 CVD 配合判断市场资金方向：
  //   OI ↑ + CVD ↓ → 新空单进场 (short build-up)
  //   OI ↑ + CVD ↑ → 新多单进场 (long build-up)
  //   OI ↓ + CVD ↑ → 空头平仓 (short covering)
  //   OI ↓ + CVD ↓ → 多头平仓 (long unwind)
  const oiChart = LightweightCharts.createChart(els.oiPane, {
    layout: { background: { color: 'transparent' }, textColor: '#9aa7b8' },
    grid: {
      vertLines: { color: '#1f2837' },
      horzLines: { color: '#1f2837' }
    },
    timeScale: {
      timeVisible: true,
      secondsVisible: false,
      borderColor: '#1f2837',
      tickMarkFormatter: lwTickFormatter
    },
    rightPriceScale: { borderColor: '#1f2837' },
    localization: lwLocalization
  });
  // 半透明面积线，颜色与 CVD 区分（橙色），强调"持仓量"金额维度
  const oiSeries = oiChart.addAreaSeries({
    lineColor: '#fbbf24',
    topColor: 'rgba(251, 191, 36, 0.35)',
    bottomColor: 'rgba(251, 191, 36, 0.02)',
    lineWidth: 2,
    priceFormat: { type: 'volume' }
  });

  // 窗口尺寸变化重排 (Resize handlers) -------------------------------------
  function fitCharts() {
    mainChart.resize(els.mainChart.clientWidth, els.mainChart.clientHeight);
    volumeChart.resize(els.volumePane.clientWidth, els.volumePane.clientHeight);
    cvdChart.resize(els.cvdPane.clientWidth, els.cvdPane.clientHeight);
    oiChart.resize(els.oiPane.clientWidth, els.oiPane.clientHeight);
  }
  window.addEventListener('resize', fitCharts);

  // ---- 时间轴联动 (Time-scale sync across main + sub charts) ----
  // 主图拖动 / 缩放 → 三个副图跟随；副图也能反向触发，实现"群联动"。
  // (Keep volume / CVD / OI panes locked to the same visible range as the
  //  main chart so reading three indicators side-by-side is intuitive.)
  //
  // 实现要点：
  //   1) 用 *时间范围* (visible time range) 而非 logical range 同步。
  //      logical range 是各图自己的 bar 索引；副图 bar 数和主图不一定一致
  //      （OI 5m/1h fallback、空数据等场景），用 logical 会错位。
  //      time range 用 UTC 秒，跨图通用。
  //   2) 用 `_syncingTime` 防止 A → B → A 的回环触发。
  //   3) 空数据图（如现货模式下 OI 没数据）setVisibleRange 会抛 / no-op，
  //      用 try/catch 吞掉。
  const allTimeScales = [
    mainChart.timeScale(),
    volumeChart.timeScale(),
    cvdChart.timeScale(),
    oiChart.timeScale()
  ];
  let _syncingTime = false;
  function _broadcastTimeRange(srcScale, range) {
    if (_syncingTime || !range || range.from == null || range.to == null) return;
    _syncingTime = true;
    try {
      for (const ts of allTimeScales) {
        if (ts === srcScale) continue;
        try { ts.setVisibleRange({ from: range.from, to: range.to }); }
        catch (_) { /* 该图为空 / 范围不在数据内 */ }
      }
    } finally {
      _syncingTime = false;
    }
  }
  for (const ts of allTimeScales) {
    ts.subscribeVisibleTimeRangeChange((r) => _broadcastTimeRange(ts, r));
  }

  /**
   * 主动把所有副图拉到主图当前的可见范围。
   * 用于副图 setData 之后（新数据可能让副图自身的"自然范围"改变），
   * 以及渲染流程末尾兜底，避免副图任何隐式 fit 把主图 zoom 也带跑。
   */
  function syncSubChartsToMain() {
    const range = mainChart.timeScale().getVisibleRange();
    if (!range) return;
    _syncingTime = true;
    try {
      for (const ts of [volumeChart.timeScale(), cvdChart.timeScale(), oiChart.timeScale()]) {
        try { ts.setVisibleRange(range); } catch (_) { /* empty data */ }
      }
    } finally {
      _syncingTime = false;
    }
  }

  // ---- 流动性热图 (Liquidity Heatmap) ------------------------------------
  // 设计 (Design):
  //   - X 轴 = 时间桶（与录盘 1min 对齐，可放大到 5/15min）
  //   - Y 轴 = 价格桶（围绕中价的对称窗，自适应 ~200 桶）
  //   - 颜色 = 该 (time,price) 桶内 USDT 名义额峰值，log scale
  //     bid 区域偏绿，ask 区域偏红，更亮 = 更厚的"墙"
  //   - 时间轴跟随主图 visibleTimeRange，主图缩放 / 拖动会触发热图重拉。
  //   - 数据回放窗口由 obRecorder 决定（默认 25h）；超出 / 现货 / 非 BTC
  //     场景下显示"无数据"提示，不影响其它面板。
  // 仅 BTCUSDT futures 录盘 → 其他 symbol/market 隐藏整个 section。
  // -------------------------------------------------------------------------
  const heatmap = (function initHeatmap() {
    const canvas  = els.heatmapCanvas;
    const tooltip = els.heatmapTooltip;
    const empty   = els.heatmapEmpty;
    const meta    = els.heatmapMeta;
    const card    = document.getElementById('heatmap-card');
    if (!canvas || !card) return null;
    const ctx = canvas.getContext('2d');

    function _readPriceRange() {
      const v = els.heatmapRange ? els.heatmapRange.value : 'auto';
      if (v === 'auto' || v === '') return 'auto';
      const n = Number(v);
      return (Number.isFinite(n) && n > 0) ? n : 'auto';
    }

    const state = {
      windowMs: Number((els.heatmapWindow && els.heatmapWindow.value) || 3_600_000),
      priceRange: _readPriceRange(),
      // anchorMs：热图 to 时刻（默认 null = 跟实时 now，主图 hover 时锁定到 hover 时间）
      anchorMs: null,
      data: null,
      pixelRatio: window.devicePixelRatio || 1,
      cssWidth: 0,
      cssHeight: 0,
      lastFetchKey: '',
      lastFetchAt: 0,
      pendingTimer: null,
      plot: { x: 56, y: 6, w: 0, h: 0 },
      hoverCell: null
    };

    /*
     * canvas 尺寸同步：
     * - 用 parentElement 的 clientWidth/Height（不含 border / scrollbar）量纲，
     *   不读 getBoundingClientRect().height（受 transform / sub-pixel 影响）。
     * - 仅在与上次记录的 cssWidth/cssHeight 真的不同时，才触发 canvas 重设
     *   + 重绘，避免 ResizeObserver 与 canvas style 写入 互相触发的死循环
     *   （之前页面会被持续拉长就是这条 loop 的副作用）。
     */
    function _resizeCanvas() {
      const parent = canvas.parentElement;
      if (!parent) return;
      const w = Math.max(20, Math.floor(parent.clientWidth));
      const h = Math.max(20, Math.floor(parent.clientHeight));
      if (w === state.cssWidth && h === state.cssHeight) return;
      state.cssWidth = w;
      state.cssHeight = h;
      const dpr = window.devicePixelRatio || 1;
      state.pixelRatio = dpr;
      canvas.width  = Math.floor(w * dpr);
      canvas.height = Math.floor(h * dpr);
      // 不再写 canvas.style.width/height —— canvas 已经是 absolute inset:0,
      // 100% 跟随 .pane-body，让父容器单向决定尺寸，避免反向反馈。
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      state.plot.x = 64;
      state.plot.y = 8;
      state.plot.w = Math.max(20, w - state.plot.x - 12);
      state.plot.h = Math.max(20, h - state.plot.y - 22);
      _draw();
    }

    function _isApplicable() {
      // 仅 BTCUSDT futures 有录盘，其它情况直接折叠区块
      const sym = els.symbol ? els.symbol.value.toUpperCase() : '';
      const mkt = els.market ? els.market.value : '';
      return sym === 'BTCUSDT' && mkt === 'futures';
    }

    function _setVisibility() {
      card.style.display = _isApplicable() ? '' : 'none';
    }

    function _updateMeta(extra) {
      if (!meta) return;
      const d = state.data;
      if (!d) { meta.textContent = extra || '等待数据… / Loading…'; return; }
      const tFmt = (ms) => fmtBJShortDateTime(ms);
      const cells = (d.times ? d.times.length : 0) * (d.prices ? d.prices.length : 0);
      const rangeTxt = d.autoRange && Number.isFinite(d.priceRange)
        ? `±${(d.priceRange * 100).toFixed(2)}% (auto)`
        : (Number.isFinite(d.priceRange) ? `±${(d.priceRange * 100).toFixed(2)}%` : '-');
      meta.textContent = `${tFmt(d.fromMs)} → ${tFmt(d.toMs)} · 桶 ${(d.bucketMs/60_000).toFixed(0)}m × ${d.priceBucket || '-'} USDT · 范围 ${rangeTxt} · 快照 ${d.snapshotCount || 0}` + (extra ? ` · ${extra}` : '');
    }

    /*
     * 颜色映射 — Viridis colormap (CoinGlass 风格):
     *   - 同一格内 bid+ask 合并取强度，整图统一用 viridis (紫→蓝→青→绿→黄)
     *   - bid/ask 通过 tooltip 区分，不靠颜色（CoinGlass 也是不分方向）
     *   - P95 归一化避免极端墙吃对比度
     */
    function _colorFor(value, normMax /*, _isBid */) {
      return viridisFromValue(value, normMax);
    }

    /** 选好看的价格 tick 步长（1/2/5 ×10^k 系列） */
    function _niceStep(rawStep) {
      if (!(rawStep > 0)) return 1;
      const exp = Math.pow(10, Math.floor(Math.log10(rawStep)));
      const norm = rawStep / exp;
      let factor;
      if (norm < 1.5) factor = 1;
      else if (norm < 3.5) factor = 2;
      else if (norm < 7.5) factor = 5;
      else factor = 10;
      return factor * exp;
    }

    function _draw() {
      if (!ctx) return;
      const W = state.cssWidth, H = state.cssHeight;
      ctx.clearRect(0, 0, W, H);
      // Viridis 起始色 (深紫 #1a0033) 作背景，与色阶最低端衔接自然
      ctx.fillStyle = '#1a0033';
      ctx.fillRect(0, 0, W, H);

      const d = state.data;
      const { x: ox, y: oy, w: pw, h: ph } = state.plot;

      if (!d || !d.times || !d.times.length || !d.prices || !d.prices.length || !(d.maxValue > 0)) {
        if (empty) empty.style.display = 'flex';
        return;
      }
      if (empty) empty.style.display = 'none';

      const T = d.times.length;
      const P = d.prices.length;
      const cellW = pw / T;
      const cellH = ph / P;

      // 色块：合并 bid+ask 取较大值（同价位通常只会有一边有挂单）
      const normMax = (Number.isFinite(d.p95) && d.p95 > 0) ? d.p95 : d.maxValue;
      for (let ti = 0; ti < T; ti += 1) {
        const x = ox + ti * cellW;
        for (let pi = 0; pi < P; pi += 1) {
          const yTop = oy + (P - 1 - pi) * cellH;
          const bidV = d.bidMatrix[ti] ? d.bidMatrix[ti][pi] : 0;
          const askV = d.askMatrix[ti] ? d.askMatrix[ti][pi] : 0;
          const v = Math.max(bidV, askV);
          if (v <= 0) continue;
          const color = _colorFor(v, normMax);
          if (!color) continue;
          ctx.fillStyle = color;
          ctx.fillRect(x, yTop, cellW + 1, cellH + 1);
        }
      }

      // ---- (2) 水平价格 grid（暗色虚线） ---------------------
      const priceSpan = d.priceMax - d.priceMin;
      const targetTicks = Math.max(6, Math.min(12, Math.floor(ph / 36)));
      const step = _niceStep(priceSpan / targetTicks);
      const startTick = Math.ceil(d.priceMin / step) * step;
      ctx.save();
      ctx.strokeStyle = 'rgba(255,255,255,0.05)';
      ctx.lineWidth = 1;
      ctx.setLineDash([2, 4]);
      ctx.beginPath();
      for (let p = startTick; p <= d.priceMax; p += step) {
        const y = oy + ph * (1 - (p - d.priceMin) / priceSpan);
        ctx.moveTo(ox, y);
        ctx.lineTo(ox + pw, y);
      }
      ctx.stroke();
      ctx.restore();

      // ---- (3) 价格刻度 (左侧) -------------------------------
      ctx.fillStyle = 'rgba(220,228,240,0.95)';
      ctx.font = '11px ui-monospace, SFMono-Regular, Menlo, monospace';
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      const priceFmt = (p) => p >= 1000 ? p.toFixed(0) : p.toFixed(2);
      for (let p = startTick; p <= d.priceMax; p += step) {
        const y = oy + ph * (1 - (p - d.priceMin) / priceSpan);
        ctx.fillText(priceFmt(p), ox - 6, y);
      }

      // ---- (4) 中价线 + 中价标签（白色实线 + 价签） --------------
      if (Number.isFinite(d.midPrice)) {
        const yMid = oy + ph * (1 - (d.midPrice - d.priceMin) / priceSpan);
        if (yMid > oy && yMid < oy + ph) {
          ctx.save();
          ctx.strokeStyle = 'rgba(255, 255, 255, 0.55)';
          ctx.lineWidth = 1;
          ctx.setLineDash([6, 4]);
          ctx.beginPath();
          ctx.moveTo(ox, yMid);
          ctx.lineTo(ox + pw, yMid);
          ctx.stroke();
          ctx.setLineDash([]);
          // 中价 tag：右侧
          const tagText = priceFmt(d.midPrice);
          ctx.font = 'bold 11px ui-monospace, SFMono-Regular, Menlo, monospace';
          const tagW = ctx.measureText(tagText).width + 8;
          ctx.fillStyle = 'rgba(255, 255, 255, 0.85)';
          ctx.fillRect(ox + pw - tagW - 2, yMid - 8, tagW, 16);
          ctx.fillStyle = '#0b0e16';
          ctx.textAlign = 'center';
          ctx.fillText(tagText, ox + pw - tagW / 2 - 2, yMid);
          ctx.restore();
        }
      }

      // ---- (5) 时间刻度 (底部) -------------------------------
      ctx.fillStyle = 'rgba(220,228,240,0.95)';
      ctx.font = '11px ui-monospace, SFMono-Regular, Menlo, monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      const timeTicks = Math.max(4, Math.min(10, Math.floor(pw / 90)));
      for (let i = 0; i <= timeTicks; i += 1) {
        const frac = i / timeTicks;
        const t = d.fromMs + (d.toMs - d.fromMs) * frac;
        const x = ox + pw * frac;
        const text = fmtBJTimeHMS(t).slice(0, 5); // HH:mm
        ctx.fillText(text, Math.max(ox + 14, Math.min(ox + pw - 14, x)), oy + ph + 4);
        // 底部小竖线
        ctx.strokeStyle = 'rgba(255,255,255,0.15)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(x + 0.5, oy + ph);
        ctx.lineTo(x + 0.5, oy + ph + 3);
        ctx.stroke();
      }

      // ---- (6) anchor 锁定线（主图 hover 时）-----------------
      if (Number.isFinite(state.anchorMs) && state.anchorMs >= d.fromMs && state.anchorMs <= d.toMs) {
        const xA = ox + pw * ((state.anchorMs - d.fromMs) / (d.toMs - d.fromMs));
        ctx.save();
        ctx.strokeStyle = 'rgba(255, 215, 0, 0.7)';
        ctx.lineWidth = 1;
        ctx.setLineDash([3, 3]);
        ctx.beginPath();
        ctx.moveTo(xA, oy);
        ctx.lineTo(xA, oy + ph);
        ctx.stroke();
        ctx.restore();
      }

      // ---- (7) 边框 + hover 高亮 ------------------------------
      ctx.strokeStyle = 'rgba(255,255,255,0.12)';
      ctx.lineWidth = 1;
      ctx.strokeRect(ox + 0.5, oy + 0.5, pw, ph);

      if (state.hoverCell) {
        const { ti, pi } = state.hoverCell;
        if (ti >= 0 && ti < T && pi >= 0 && pi < P) {
          const x = ox + ti * cellW;
          const y = oy + (P - 1 - pi) * cellH;
          ctx.save();
          ctx.strokeStyle = 'rgba(255,255,255,0.85)';
          ctx.lineWidth = 1.5;
          ctx.strokeRect(x + 0.5, y + 0.5, cellW, cellH);
          ctx.restore();
        }
      }
    }

    function _hitTest(clientX, clientY) {
      const rect = canvas.getBoundingClientRect();
      const cx = clientX - rect.left;
      const cy = clientY - rect.top;
      const { x: ox, y: oy, w: pw, h: ph } = state.plot;
      const d = state.data;
      if (!d || cx < ox || cx > ox + pw || cy < oy || cy > oy + ph) return null;
      const T = d.times.length;
      const P = d.prices.length;
      if (!T || !P) return null;
      const ti = Math.floor((cx - ox) / (pw / T));
      const pi = P - 1 - Math.floor((cy - oy) / (ph / P));
      if (ti < 0 || ti >= T || pi < 0 || pi >= P) return null;
      return { ti, pi, cx, cy };
    }

    canvas.addEventListener('mousemove', (e) => {
      const hit = _hitTest(e.clientX, e.clientY);
      state.hoverCell = hit;
      if (!hit) {
        tooltip.style.display = 'none';
        _draw();
        return;
      }
      const d = state.data;
      const t  = d.times[hit.ti];
      const p  = d.prices[hit.pi];
      const bid = (d.bidMatrix[hit.ti] || [])[hit.pi] || 0;
      const ask = (d.askMatrix[hit.ti] || [])[hit.pi] || 0;
      const fmtMoney = (v) => v >= 1e6
        ? (v / 1e6).toFixed(2) + 'M'
        : v >= 1e3 ? (v / 1e3).toFixed(2) + 'K' : v.toFixed(0);
      tooltip.innerHTML =
        `<div><b>${fmtBJDateTime(t)} (UTC+8)</b></div>` +
        `<div>价格 / Price: <b>${p.toFixed(p >= 1000 ? 1 : 2)}</b></div>` +
        `<div>买墙 / Bid: <span style="color:#5dc863">${fmtMoney(bid)} USDT</span></div>` +
        `<div>卖墙 / Ask: <span style="color:#fde725">${fmtMoney(ask)} USDT</span></div>` +
        `<div style="opacity:0.7;font-size:10px">合计: ${fmtMoney(bid + ask)} USDT</div>`;
      tooltip.style.display = 'block';
      const rect = canvas.parentElement.getBoundingClientRect();
      const ttX = Math.min(rect.width - 220, hit.cx + 10);
      const ttY = Math.max(0, hit.cy + 10);
      tooltip.style.left = ttX + 'px';
      tooltip.style.top  = ttY + 'px';
      _draw();
    });
    canvas.addEventListener('mouseleave', () => {
      state.hoverCell = null;
      tooltip.style.display = 'none';
      _draw();
    });

    /*
     * 取数策略 (Range strategy):
     *   - 用户在 toolbar 选的 windowMs 直接决定窗口长度（15m/1h/4h/24h），
     *     不再被主图 visibleTimeRange 覆盖 —— 这是之前"切窗口没反应"的根因。
     *   - to = anchorMs（主图 hover 锁定的时刻）|| Date.now()。
     *   - bucket 自适应：力求每图约 60~90 个时间桶，可读性最佳。
     */
    function _resolveRange() {
      const toMs = Number.isFinite(state.anchorMs) ? state.anchorMs : Date.now();
      const fromMs = toMs - state.windowMs;
      const span = toMs - fromMs;
      let bucketMs;
      if (span <= 15 * 60_000)        bucketMs = 60_000;          // 15m → 1m × 15
      else if (span <= 60 * 60_000)   bucketMs = 60_000;          // 1h  → 1m × 60
      else if (span <= 4 * 3600_000)  bucketMs = 2 * 60_000;      // 4h  → 2m × 120
      else if (span <= 12 * 3600_000) bucketMs = 10 * 60_000;     // 12h → 10m × 72
      else                            bucketMs = 15 * 60_000;     // 24h → 15m × 96
      return { fromMs, toMs, bucketMs };
    }

    /**
     * 主图 hover 时的锚定回调。hoverMs 为 null 表示恢复到实时 now。
     * 这是热图被主图驱动的"唯一通道"——不会响应主图的缩放/拖动，
     * 因为缩放主图时大家通常想保持热图窗口稳定来对照具体时刻。
     */
    function setHeatmapAnchor(hoverMs) {
      const next = Number.isFinite(hoverMs) ? Math.floor(hoverMs) : null;
      if (next === state.anchorMs) return;
      state.anchorMs = next;
      state.lastFetchKey = '';
      scheduleFetch(next == null ? 0 : 200);
    }

    async function _fetch() {
      if (!_isApplicable()) return;
      const { fromMs, toMs, bucketMs } = _resolveRange();
      const symbol = els.symbol.value.toUpperCase();
      const market = els.market.value;
      const key = `${symbol}|${market}|${fromMs}|${toMs}|${bucketMs}|${state.priceRange === 'auto' ? 'auto' : String(state.priceRange)}`;
      // 同一参数 5s 内不重拉
      const now = Date.now();
      if (key === state.lastFetchKey && now - state.lastFetchAt < 5_000) return;
      state.lastFetchKey = key;
      state.lastFetchAt = now;
      try {
        const params = new URLSearchParams({
          symbol, market,
          from: String(fromMs),
          to: String(toMs),
          bucketMs: String(bucketMs)
        });
        if (state.priceRange === 'auto') {
          params.set('priceRange', 'auto');
        } else {
          params.set('priceRange', String(state.priceRange));
        }
        const url = `/api/orderbook/heatmap?${params.toString()}`;
        const data = await fetchJsonSoft(url);
        if (!data) {
          _updateMeta('拉取失败 / Fetch failed');
          return;
        }
        state.data = data;
        _updateMeta();
        _draw();
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn('[heatmap] fetch err:', err.message);
        _updateMeta('错误 / Error: ' + err.message);
      }
    }

    function scheduleFetch(delay) {
      if (state.pendingTimer) clearTimeout(state.pendingTimer);
      state.pendingTimer = setTimeout(() => {
        state.pendingTimer = null;
        _fetch();
      }, delay != null ? delay : 250);
    }

    // 控件变化 → 立即刷新
    if (els.heatmapWindow) {
      els.heatmapWindow.addEventListener('change', () => {
        state.windowMs = Number(els.heatmapWindow.value) || 3_600_000;
        state.lastFetchKey = ''; // 强制重拉
        scheduleFetch(0);
      });
    }
    if (els.heatmapRange) {
      els.heatmapRange.addEventListener('change', () => {
        state.priceRange = _readPriceRange();
        state.lastFetchKey = '';
        scheduleFetch(0);
      });
    }

    // 容器尺寸跟随：用 ResizeObserver 监控 .pane-body
    // rAF 包一层 + 防重入，避免触发 "ResizeObserver loop limit exceeded" 警告
    // 与可能的页面缓慢拉长副作用。
    let _roPending = false;
    const ro = new ResizeObserver(() => {
      if (_roPending) return;
      _roPending = true;
      requestAnimationFrame(() => {
        _roPending = false;
        _resizeCanvas();
      });
    });
    ro.observe(canvas.parentElement);
    // 兜底：窗口尺寸变化时也校准一次（某些浏览器 RO 触发不稳）
    window.addEventListener('resize', () => {
      if (_roPending) return;
      _roPending = true;
      requestAnimationFrame(() => {
        _roPending = false;
        _resizeCanvas();
      });
    });

    // 周期性自动刷新（每 60s 一次，确保即使主图没动热图也跟最新录盘）
    setInterval(() => scheduleFetch(0), 60_000);

    _setVisibility();
    _resizeCanvas();
    // 首次延迟拉一次（等主图 setData 后 visibleRange 才靠谱）
    scheduleFetch(800);

    return {
      refresh: () => scheduleFetch(0),
      setAnchor: setHeatmapAnchor,
      resize: () => _resizeCanvas(),
      onSymbolMarketChange: () => {
        _setVisibility();
        state.data = null;
        state.lastFetchKey = '';
        state.anchorMs = null;
        _draw();
        if (_isApplicable()) scheduleFetch(300);
      }
    };
  })();

  // ---- 清算热力图 (Liquidation Heatmap) ---------------------------------
  // 数据源 (Data source):
  //   后端 liquidationRecorder 订阅 Binance Futures <symbol>@forceOrder 流，
  //   把每条强平实时录盘；GET /api/liquidations/heatmap 按 (time bucket,
  //   price bucket) 聚合返回 longMatrix / shortMatrix（USDT 累计名义额）。
  // 视觉 (Visual):
  //   - long 被强平 → 红色（与流动性 ask 同色：被卖出止损推低）
  //   - short 被强平 → 绿色（被买入止损推高）
  //   - alpha 用 P95 归一化 + log 拉伸，避免极端事件吃对比度
  // 联动 (Linkage):
  //   主图 hover → 锁定 anchor 时刻；hover 离开 → 实时 now。
  // 仅 BTCUSDT futures 显示。
  // -------------------------------------------------------------------------
  const liqHeatmap = (function initLiqHeatmap() {
    const canvas  = els.liqHeatmapCanvas;
    const tooltip = els.liqHeatmapTooltip;
    const empty   = els.liqHeatmapEmpty;
    const meta    = els.liqHeatmapMeta;
    const card    = document.getElementById('liq-heatmap-card');
    if (!canvas || !card) return null;
    const ctx = canvas.getContext('2d');

    function _readPriceRange() {
      const v = els.liqHeatmapRange ? els.liqHeatmapRange.value : 'auto';
      if (v === 'auto' || v === '') return 'auto';
      const n = Number(v);
      return (Number.isFinite(n) && n > 0) ? n : 'auto';
    }

    const state = {
      windowMs: Number((els.liqHeatmapWindow && els.liqHeatmapWindow.value) || 86_400_000),
      priceRange: _readPriceRange(),
      mode: (els.liqHeatmapMode && els.liqHeatmapMode.value) || 'predicted',
      anchorMs: null,
      data: null,
      cssWidth: 0,
      cssHeight: 0,
      lastFetchKey: '',
      lastFetchAt: 0,
      pendingTimer: null,
      plot: { x: 64, y: 8, w: 0, h: 0 },
      hoverCell: null
    };

    function _resizeCanvas() {
      const parent = canvas.parentElement;
      if (!parent) return;
      const w = Math.max(20, Math.floor(parent.clientWidth));
      const h = Math.max(20, Math.floor(parent.clientHeight));
      if (w === state.cssWidth && h === state.cssHeight) return;
      state.cssWidth = w;
      state.cssHeight = h;
      const dpr = window.devicePixelRatio || 1;
      canvas.width  = Math.floor(w * dpr);
      canvas.height = Math.floor(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      state.plot.x = 64;
      state.plot.y = 8;
      state.plot.w = Math.max(20, w - state.plot.x - 12);
      state.plot.h = Math.max(20, h - state.plot.y - 22);
      _draw();
    }

    function _isApplicable() {
      const sym = els.symbol ? els.symbol.value.toUpperCase() : '';
      const mkt = els.market ? els.market.value : '';
      return sym === 'BTCUSDT' && mkt === 'futures';
    }
    function _setVisibility() {
      card.style.display = _isApplicable() ? '' : 'none';
    }

    const fmtMoney = (v) => v >= 1e6
      ? (v / 1e6).toFixed(2) + 'M'
      : v >= 1e3 ? (v / 1e3).toFixed(2) + 'K' : v.toFixed(0);

    function _updateMeta(extra) {
      if (!meta) return;
      const d = state.data;
      if (!d) { meta.textContent = extra || '等待数据… / Loading…'; return; }
      const tFmt = (ms) => fmtBJShortDateTime(ms);
      const rangeTxt = d.autoRange && Number.isFinite(d.priceRange)
        ? `±${(d.priceRange * 100).toFixed(2)}% (auto)`
        : (Number.isFinite(d.priceRange) ? `±${(d.priceRange * 100).toFixed(2)}%` : '-');
      const totalLong  = fmtMoney(d.totalLong  || 0);
      const totalShort = fmtMoney(d.totalShort || 0);
      const modeTag = state.mode === 'predicted' ? '预测 / Predicted' : '已发生 / Realized';
      const sourceTag = d.sourceInterval ? ` · 源 ${d.sourceInterval}` : '';
      const cntLabel = state.mode === 'predicted' ? 'K线' : '事件';
      const cntVal = state.mode === 'predicted' ? (d.candleCount || 0) : (d.eventCount || 0);
      meta.textContent =
        `${modeTag} · ${tFmt(d.fromMs)} → ${tFmt(d.toMs)} · 桶 ${(d.bucketMs/60_000).toFixed(0)}m × ${d.priceBucket || '-'} USDT · 范围 ${rangeTxt}${sourceTag} · ${cntLabel} ${cntVal} (多 ${totalLong} · 空 ${totalShort} USDT)`
        + (extra ? ` · ${extra}` : '');
    }

    function _colorFor(value, normMax) {
      return viridisFromValue(value, normMax);
    }

    function _niceStep(rawStep) {
      if (!(rawStep > 0)) return 1;
      const exp = Math.pow(10, Math.floor(Math.log10(rawStep)));
      const norm = rawStep / exp;
      let factor;
      if (norm < 1.5) factor = 1;
      else if (norm < 3.5) factor = 2;
      else if (norm < 7.5) factor = 5;
      else factor = 10;
      return factor * exp;
    }

    function _draw() {
      if (!ctx) return;
      const W = state.cssWidth, H = state.cssHeight;
      ctx.clearRect(0, 0, W, H);
      // CoinGlass 风格深紫背景，与 viridis 起始色衔接
      ctx.fillStyle = '#1a0033';
      ctx.fillRect(0, 0, W, H);

      const d = state.data;
      const { x: ox, y: oy, w: pw, h: ph } = state.plot;
      if (!d || !d.times || !d.times.length || !d.prices || !d.prices.length || !(d.maxValue > 0)) {
        if (empty) empty.style.display = 'flex';
        return;
      }
      if (empty) empty.style.display = 'none';

      const T = d.times.length;
      const P = d.prices.length;
      const cellW = pw / T;
      const cellH = ph / P;

      const normMax = (Number.isFinite(d.p95) && d.p95 > 0) ? d.p95 : d.maxValue;
      // 色块：合并 long+short 总强度（与 CoinGlass 一致——颜色不分方向，
      // 方向通过 tooltip 区分）
      for (let ti = 0; ti < T; ti += 1) {
        const x = ox + ti * cellW;
        for (let pi = 0; pi < P; pi += 1) {
          const yTop = oy + (P - 1 - pi) * cellH;
          const lv = d.longMatrix[ti]  ? d.longMatrix[ti][pi]  : 0;
          const sv = d.shortMatrix[ti] ? d.shortMatrix[ti][pi] : 0;
          const v = lv + sv;
          if (v <= 0) continue;
          const color = _colorFor(v, normMax);
          if (!color) continue;
          ctx.fillStyle = color;
          ctx.fillRect(x, yTop, cellW + 1, cellH + 1);
        }
      }

      // 价格 grid
      const priceSpan = d.priceMax - d.priceMin;
      const targetTicks = Math.max(6, Math.min(12, Math.floor(ph / 36)));
      const step = _niceStep(priceSpan / targetTicks);
      const startTick = Math.ceil(d.priceMin / step) * step;
      ctx.save();
      ctx.strokeStyle = 'rgba(255,255,255,0.05)';
      ctx.lineWidth = 1;
      ctx.setLineDash([2, 4]);
      ctx.beginPath();
      for (let p = startTick; p <= d.priceMax; p += step) {
        const y = oy + ph * (1 - (p - d.priceMin) / priceSpan);
        ctx.moveTo(ox, y);
        ctx.lineTo(ox + pw, y);
      }
      ctx.stroke();
      ctx.restore();

      // 价格刻度
      ctx.fillStyle = 'rgba(220,228,240,0.95)';
      ctx.font = '11px ui-monospace, SFMono-Regular, Menlo, monospace';
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      const priceFmt = (p) => p >= 1000 ? p.toFixed(0) : p.toFixed(2);
      for (let p = startTick; p <= d.priceMax; p += step) {
        const y = oy + ph * (1 - (p - d.priceMin) / priceSpan);
        ctx.fillText(priceFmt(p), ox - 6, y);
      }

      // 中价线 + tag
      if (Number.isFinite(d.midPrice)) {
        const yMid = oy + ph * (1 - (d.midPrice - d.priceMin) / priceSpan);
        if (yMid > oy && yMid < oy + ph) {
          ctx.save();
          ctx.strokeStyle = 'rgba(255, 255, 255, 0.55)';
          ctx.lineWidth = 1;
          ctx.setLineDash([6, 4]);
          ctx.beginPath();
          ctx.moveTo(ox, yMid);
          ctx.lineTo(ox + pw, yMid);
          ctx.stroke();
          ctx.setLineDash([]);
          const tagText = priceFmt(d.midPrice);
          ctx.font = 'bold 11px ui-monospace, SFMono-Regular, Menlo, monospace';
          const tagW = ctx.measureText(tagText).width + 8;
          ctx.fillStyle = 'rgba(255, 255, 255, 0.85)';
          ctx.fillRect(ox + pw - tagW - 2, yMid - 8, tagW, 16);
          ctx.fillStyle = '#0b0e16';
          ctx.textAlign = 'center';
          ctx.fillText(tagText, ox + pw - tagW / 2 - 2, yMid);
          ctx.restore();
        }
      }

      // 时间刻度
      ctx.fillStyle = 'rgba(220,228,240,0.95)';
      ctx.font = '11px ui-monospace, SFMono-Regular, Menlo, monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      const timeTicks = Math.max(4, Math.min(10, Math.floor(pw / 90)));
      for (let i = 0; i <= timeTicks; i += 1) {
        const frac = i / timeTicks;
        const t = d.fromMs + (d.toMs - d.fromMs) * frac;
        const x = ox + pw * frac;
        const text = fmtBJTimeHMS(t).slice(0, 5);
        ctx.fillText(text, Math.max(ox + 14, Math.min(ox + pw - 14, x)), oy + ph + 4);
        ctx.strokeStyle = 'rgba(255,255,255,0.15)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(x + 0.5, oy + ph);
        ctx.lineTo(x + 0.5, oy + ph + 3);
        ctx.stroke();
      }

      // anchor 锁定线
      if (Number.isFinite(state.anchorMs) && state.anchorMs >= d.fromMs && state.anchorMs <= d.toMs) {
        const xA = ox + pw * ((state.anchorMs - d.fromMs) / (d.toMs - d.fromMs));
        ctx.save();
        ctx.strokeStyle = 'rgba(255, 215, 0, 0.7)';
        ctx.lineWidth = 1;
        ctx.setLineDash([3, 3]);
        ctx.beginPath();
        ctx.moveTo(xA, oy);
        ctx.lineTo(xA, oy + ph);
        ctx.stroke();
        ctx.restore();
      }

      // 边框
      ctx.strokeStyle = 'rgba(255,255,255,0.12)';
      ctx.lineWidth = 1;
      ctx.strokeRect(ox + 0.5, oy + 0.5, pw, ph);

      // hover 高亮
      if (state.hoverCell) {
        const { ti, pi } = state.hoverCell;
        if (ti >= 0 && ti < T && pi >= 0 && pi < P) {
          const x = ox + ti * cellW;
          const y = oy + (P - 1 - pi) * cellH;
          ctx.save();
          ctx.strokeStyle = 'rgba(255,255,255,0.85)';
          ctx.lineWidth = 1.5;
          ctx.strokeRect(x + 0.5, y + 0.5, cellW, cellH);
          ctx.restore();
        }
      }
    }

    function _hitTest(clientX, clientY) {
      const rect = canvas.getBoundingClientRect();
      const cx = clientX - rect.left;
      const cy = clientY - rect.top;
      const { x: ox, y: oy, w: pw, h: ph } = state.plot;
      const d = state.data;
      if (!d || cx < ox || cx > ox + pw || cy < oy || cy > oy + ph) return null;
      const T = d.times.length;
      const P = d.prices.length;
      if (!T || !P) return null;
      const ti = Math.floor((cx - ox) / (pw / T));
      const pi = P - 1 - Math.floor((cy - oy) / (ph / P));
      if (ti < 0 || ti >= T || pi < 0 || pi >= P) return null;
      return { ti, pi, cx, cy };
    }

    canvas.addEventListener('mousemove', (e) => {
      const hit = _hitTest(e.clientX, e.clientY);
      state.hoverCell = hit;
      if (!hit) {
        tooltip.style.display = 'none';
        _draw();
        return;
      }
      const d = state.data;
      const t  = d.times[hit.ti];
      const p  = d.prices[hit.pi];
      const lv = (d.longMatrix[hit.ti]  || [])[hit.pi] || 0;
      const sv = (d.shortMatrix[hit.ti] || [])[hit.pi] || 0;
      const isPred = state.mode === 'predicted';
      const longLab  = isPred ? '潜在多头清算 / Long liq pot.'  : '多被强平 / Long liq';
      const shortLab = isPred ? '潜在空头清算 / Short liq pot.' : '空被强平 / Short liq';
      tooltip.innerHTML =
        `<div><b>${fmtBJDateTime(t)} (UTC+8)</b></div>` +
        `<div>价格 / Price: <b>${p.toFixed(p >= 1000 ? 1 : 2)}</b></div>` +
        `<div>${longLab}: <span style="color:#fde725">${fmtMoney(lv)} USDT</span></div>` +
        `<div>${shortLab}: <span style="color:#5dc863">${fmtMoney(sv)} USDT</span></div>` +
        `<div style="opacity:0.7;font-size:10px">合计: ${fmtMoney(lv + sv)} USDT</div>`;
      tooltip.style.display = 'block';
      const rect = canvas.parentElement.getBoundingClientRect();
      const ttX = Math.min(rect.width - 230, hit.cx + 10);
      const ttY = Math.max(0, hit.cy + 10);
      tooltip.style.left = ttX + 'px';
      tooltip.style.top  = ttY + 'px';
      _draw();
    });
    canvas.addEventListener('mouseleave', () => {
      state.hoverCell = null;
      tooltip.style.display = 'none';
      _draw();
    });

    function _resolveRange() {
      const toMs = Number.isFinite(state.anchorMs) ? state.anchorMs : Date.now();
      const fromMs = toMs - state.windowMs;
      const span = toMs - fromMs;
      let bucketMs;
      if (span <= 15 * 60_000)        bucketMs = 60_000;
      else if (span <= 60 * 60_000)   bucketMs = 60_000;
      else if (span <= 4 * 3600_000)  bucketMs = 2 * 60_000;
      else if (span <= 12 * 3600_000) bucketMs = 10 * 60_000;
      else                            bucketMs = 15 * 60_000;
      return { fromMs, toMs, bucketMs };
    }

    function setLiqHeatmapAnchor(hoverMs) {
      const next = Number.isFinite(hoverMs) ? Math.floor(hoverMs) : null;
      if (next === state.anchorMs) return;
      state.anchorMs = next;
      state.lastFetchKey = '';
      scheduleFetch(next == null ? 0 : 200);
    }

    async function _fetch() {
      if (!_isApplicable()) return;
      const { fromMs, toMs, bucketMs } = _resolveRange();
      const symbol = els.symbol.value.toUpperCase();
      const market = els.market.value;
      const mode = state.mode;
      const key = `${mode}|${symbol}|${market}|${fromMs}|${toMs}|${bucketMs}|${state.priceRange === 'auto' ? 'auto' : String(state.priceRange)}`;
      const now = Date.now();
      if (key === state.lastFetchKey && now - state.lastFetchAt < 5_000) return;
      state.lastFetchKey = key;
      state.lastFetchAt = now;
      try {
        let url;
        if (mode === 'predicted') {
          // 预测性接口按 windowMs + 实时 now 自己定窗口（不接受 from/to）
          const params = new URLSearchParams({
            symbol, market,
            windowMs: String(state.windowMs)
          });
          if (state.priceRange !== 'auto') params.set('priceRange', String(state.priceRange));
          url = `/api/predictive/liquidations?${params.toString()}`;
        } else {
          const params = new URLSearchParams({
            symbol, market,
            from: String(fromMs),
            to: String(toMs),
            bucketMs: String(bucketMs)
          });
          params.set('priceRange', state.priceRange === 'auto' ? 'auto' : String(state.priceRange));
          url = `/api/liquidations/heatmap?${params.toString()}`;
        }
        const data = await fetchJsonSoft(url);
        if (!data) {
          _updateMeta('拉取失败 / Fetch failed');
          return;
        }
        state.data = data;
        _updateMeta();
        _draw();
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn('[liqHeatmap] fetch err:', err.message);
        _updateMeta('错误 / Error: ' + err.message);
      }
    }

    function scheduleFetch(delay) {
      if (state.pendingTimer) clearTimeout(state.pendingTimer);
      state.pendingTimer = setTimeout(() => {
        state.pendingTimer = null;
        _fetch();
      }, delay != null ? delay : 250);
    }

    if (els.liqHeatmapWindow) {
      els.liqHeatmapWindow.addEventListener('change', () => {
        state.windowMs = Number(els.liqHeatmapWindow.value) || 86_400_000;
        state.lastFetchKey = '';
        scheduleFetch(0);
      });
    }
    if (els.liqHeatmapRange) {
      els.liqHeatmapRange.addEventListener('change', () => {
        state.priceRange = _readPriceRange();
        state.lastFetchKey = '';
        scheduleFetch(0);
      });
    }
    if (els.liqHeatmapMode) {
      els.liqHeatmapMode.addEventListener('change', () => {
        state.mode = els.liqHeatmapMode.value || 'predicted';
        state.data = null;
        state.lastFetchKey = '';
        _draw();
        scheduleFetch(0);
      });
    }

    let _roPending = false;
    const ro = new ResizeObserver(() => {
      if (_roPending) return;
      _roPending = true;
      requestAnimationFrame(() => { _roPending = false; _resizeCanvas(); });
    });
    ro.observe(canvas.parentElement);
    window.addEventListener('resize', () => {
      if (_roPending) return;
      _roPending = true;
      requestAnimationFrame(() => { _roPending = false; _resizeCanvas(); });
    });

    // 周期 30s 自动刷新（清算事件比快照高频，重要事件不容延迟）
    setInterval(() => scheduleFetch(0), 30_000);

    _setVisibility();
    _resizeCanvas();
    scheduleFetch(800);

    return {
      refresh: () => scheduleFetch(0),
      setAnchor: setLiqHeatmapAnchor,
      resize: () => _resizeCanvas(),
      onSymbolMarketChange: () => {
        _setVisibility();
        state.data = null;
        state.lastFetchKey = '';
        state.anchorMs = null;
        _draw();
        if (_isApplicable()) scheduleFetch(300);
      }
    };
  })();

  // ---- 十字准星 (Crosshair) 跨图联动 ----
  // 一个图上 hover → 其他图同位置画一根垂直线，方便对照同一时刻的指标。
  // (Sync crosshair across main / volume / CVD / OI charts so hovering one
  //  shows where you are on the others.)
  //
  // 实现要点：
  //   - subscribeCrosshairMove 在鼠标进入 / 移动时回调 param={time, point, seriesData}
  //   - 鼠标离开图表时 param.time === undefined → 调 clearCrosshairPosition
  //   - setCrosshairPosition(price, time, series) 中的 price 只决定水平线位置，
  //     我们关心的是垂直线（时间线），所以传该图自己 series 上的 price 即可：
  //       * 主图 candleSeries：取 close
  //       * histogram/area/line series：取 value
  //     没数据时退化用 0，不会报错（4.1.x 接受任意数）。
  //   - 用 _syncingCrosshair 防回环
  const _crossPairs = [
    { chart: mainChart,   series: candleSeries },
    { chart: volumeChart, series: volumeSeries },
    { chart: cvdChart,    series: cvdSeries },
    { chart: oiChart,     series: oiSeries }
  ];
  let _syncingCrosshair = false;

  function _seriesPriceAt(pair, param) {
    const sd = param.seriesData;
    if (!sd) return 0;
    // Map 或 plain object 都兼容
    let v;
    if (typeof sd.get === 'function') v = sd.get(pair.series);
    else v = sd[pair.series];
    if (!v) return 0;
    if (Number.isFinite(v.close)) return v.close;
    if (Number.isFinite(v.value)) return v.value;
    return 0;
  }

  for (const src of _crossPairs) {
    src.chart.subscribeCrosshairMove((param) => {
      if (_syncingCrosshair) return;
      _syncingCrosshair = true;
      try {
        // 鼠标离开 → 清掉所有图的准星，并恢复订单簿基线到 now 锚定
        if (!param || param.time == null) {
          for (const t of _crossPairs) {
            if (t === src) continue;
            try { t.chart.clearCrosshairPosition(); } catch (_) { /* noop */ }
          }
          // 仅在主图离开时复位 baseline / heatmap 锚点
          if (src.chart === mainChart) {
            if (typeof setObBaselineHoverAnchor === 'function') setObBaselineHoverAnchor(null);
            if (heatmap && heatmap.setAnchor) heatmap.setAnchor(null);
            if (liqHeatmap && liqHeatmap.setAnchor) liqHeatmap.setAnchor(null);
          }
          return;
        }
        const time = param.time;
        for (const t of _crossPairs) {
          if (t === src) continue;
          // 用源图自己 series 上当前 price 来定位水平线（不影响垂直时间线对齐）
          const price = _seriesPriceAt(src, param);
          try { t.chart.setCrosshairPosition(price, time, t.series); }
          catch (_) { /* 目标图无该时间数据 */ }
        }
        // 主图 hover → 把订单簿基线 + 热图锚点都锁到该时刻
        // time 单位是秒（lightweight-charts UTC seconds），转回毫秒
        if (src.chart === mainChart) {
          const ms = Number(time) * 1000;
          if (typeof setObBaselineHoverAnchor === 'function') setObBaselineHoverAnchor(ms);
          if (heatmap && heatmap.setAnchor) heatmap.setAnchor(ms);
          if (liqHeatmap && liqHeatmap.setAnchor) liqHeatmap.setAnchor(ms);
        }
      } finally {
        _syncingCrosshair = false;
      }
    });
  }

  // ---- 订单簿深度图 (Order book · 累积阶梯深度图 / cumulative depth chart) ----
  // 设计 (Design)：
  //   X 轴 = 价格 (linear scale)，Y 轴 = 从最优档累积的名义额 (USDT)。
  //   两条阶梯曲线：
  //     - bids 从 best bid 出发往低价方向累积，stepped:'before' 渲染为
  //       右高左低的"绿色买墙"。
  //     - asks 从 best ask 出发往高价方向累积，stepped:'after' 渲染为
  //       左低右高的"红色卖墙"。
  //   这种图天然适合展示 100~500+ 档，远比逐档条形图易读。
  // (Replaced the per-level horizontal bar with a classic depth-book curve
  //  so hundreds of levels render cleanly and price scale stays continuous.)
  let orderbookChart = null;
  // mid 价垂直参考线 plugin（订单簿专用）
  // (Vertical mid-price guide line plugin for the order-book chart only.)
  const obMidLinePlugin = {
    id: 'obMidLine',
    afterDatasetsDraw(chart, _args, opts) {
      const mid = opts && opts.mid;
      if (mid == null || !Number.isFinite(mid)) return;
      const xScale = chart.scales.x;
      const yScale = chart.scales.y;
      if (!xScale || !yScale) return;
      const x = xScale.getPixelForValue(mid);
      if (x < xScale.left || x > xScale.right) return;
      const ctx = chart.ctx;
      ctx.save();
      ctx.strokeStyle = 'rgba(250, 204, 21, 0.65)';
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 3]);
      ctx.beginPath();
      ctx.moveTo(x, yScale.top);
      ctx.lineTo(x, yScale.bottom);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = 'rgba(250, 204, 21, 0.85)';
      ctx.font = '10px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('mid ' + Number(mid).toLocaleString('en-US', { maximumFractionDigits: 2 }),
                   x, yScale.top + 10);
      ctx.restore();
    }
  };

  function ensureOrderbookChart() {
    if (orderbookChart) return orderbookChart;
    const ctx = els.orderbookCanvas.getContext('2d');
    orderbookChart = new Chart(ctx, {
      type: 'line',
      data: {
        // 数据集索引（顺序对外保证）：
        //   0: 当前买单累计  (Current bids · 实线 + 半透明绿)
        //   1: 当前卖单累计  (Current asks · 实线 + 半透明红)
        //   2: 基线买单累计  (Baseline bids · 虚线 + 无填充)
        //   3: 基线卖单累计  (Baseline asks · 虚线 + 无填充)
        // 渲染顺序：先画基线在底，再叠加当前 → 当前线高于基线 = 增厚（看墙堆出）
        datasets: [
          {
            label: '当前买单累计 / Bids now (USDT)',
            data: [],
            backgroundColor: 'rgba(74, 222, 128, 0.18)',
            borderColor: 'rgba(74, 222, 128, 0.95)',
            borderWidth: 1.5,
            stepped: 'before',
            fill: 'origin',
            pointRadius: 0,
            pointHoverRadius: 3,
            tension: 0,
            order: 1
          },
          {
            label: '当前卖单累计 / Asks now (USDT)',
            data: [],
            backgroundColor: 'rgba(248, 113, 113, 0.18)',
            borderColor: 'rgba(248, 113, 113, 0.95)',
            borderWidth: 1.5,
            stepped: 'after',
            fill: 'origin',
            pointRadius: 0,
            pointHoverRadius: 3,
            tension: 0,
            order: 1
          },
          {
            label: '基线买单 / Bids baseline',
            data: [],
            borderColor: 'rgba(74, 222, 128, 0.55)',
            borderWidth: 1,
            borderDash: [4, 3],
            stepped: 'before',
            fill: false,
            pointRadius: 0,
            pointHoverRadius: 0,
            tension: 0,
            order: 0,
            hidden: true
          },
          {
            label: '基线卖单 / Asks baseline',
            data: [],
            borderColor: 'rgba(248, 113, 113, 0.55)',
            borderWidth: 1,
            borderDash: [4, 3],
            stepped: 'after',
            fill: false,
            pointRadius: 0,
            pointHoverRadius: 0,
            tension: 0,
            order: 0,
            hidden: true
          }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        parsing: false,
        animation: false,
        normalized: true,
        interaction: { mode: 'nearest', axis: 'x', intersect: false },
        plugins: {
          legend: { labels: { color: '#9aa7b8', boxWidth: 12 } },
          tooltip: {
            mode: 'nearest',
            axis: 'x',
            intersect: false,
            backgroundColor: '#11161f',
            borderColor: '#1f2837',
            borderWidth: 1,
            titleColor: '#e6edf3',
            bodyColor: '#9aa7b8',
            callbacks: {
              title: (items) => items.length
                ? '价位 / Price: ' + Number(items[0].parsed.x)
                    .toLocaleString('en-US', { maximumFractionDigits: 4 })
                : '',
              label: (item) =>
                `${item.dataset.label}: ${Number(item.parsed.y)
                  .toLocaleString('en-US', { maximumFractionDigits: 0 })}`
            }
          },
          obMidLine: { mid: null }
        },
        scales: {
          x: {
            type: 'linear',
            ticks: {
              color: '#5e6b7c',
              maxTicksLimit: 6,
              callback: (v) => Number(v).toLocaleString('en-US', { maximumFractionDigits: 2 })
            },
            grid: { color: '#1f2837' }
          },
          y: {
            type: 'linear',
            beginAtZero: true,
            ticks: {
              color: '#9aa7b8',
              callback: (v) => {
                const n = Number(v);
                if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
                if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
                return n.toFixed(0);
              }
            },
            grid: { color: '#1f2837' }
          }
        }
      },
      plugins: [obMidLinePlugin]
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

  /*
   * Viridis colormap helper —— CoinGlass 风格的"紫→蓝→青→绿→黄"渐变。
   * 输入 t ∈ [0,1]，返回 'rgb(r,g,b)' 字符串。
   * 5 个锚点之间线性插值。Alpha 由调用方决定（背景已是深紫，色块用 1.0）。
   */
  const VIRIDIS_STOPS = [
    [0.00,  68,  1, 84],
    [0.25,  59, 82, 139],
    [0.50,  33, 144, 140],
    [0.75,  93, 200,  99],
    [1.00, 253, 231,  37]
  ];
  function viridisColor(t, alpha) {
    if (!Number.isFinite(t)) return 'rgba(68,1,84,0)';
    const x = Math.max(0, Math.min(1, t));
    let i = 0;
    while (i < VIRIDIS_STOPS.length - 1 && x > VIRIDIS_STOPS[i + 1][0]) i += 1;
    const [t0, r0, g0, b0] = VIRIDIS_STOPS[i];
    const [t1, r1, g1, b1] = VIRIDIS_STOPS[Math.min(i + 1, VIRIDIS_STOPS.length - 1)];
    const span = (t1 - t0) || 1;
    const f = (x - t0) / span;
    const r = Math.round(r0 + (r1 - r0) * f);
    const g = Math.round(g0 + (g1 - g0) * f);
    const b = Math.round(b0 + (b1 - b0) * f);
    if (Number.isFinite(alpha)) return `rgba(${r},${g},${b},${alpha.toFixed(3)})`;
    return `rgb(${r},${g},${b})`;
  }
  /** 把 (value, normMax) 映射成 viridis 色 + log 拉伸 */
  function viridisFromValue(value, normMax) {
    if (!(value > 0) || !(normMax > 0)) return null;
    let t;
    if (value <= normMax) {
      t = Math.log(1 + value) / Math.log(1 + normMax);
      t = 0.05 + 0.85 * t; // 0.05~0.90
    } else {
      const extra = Math.min(1, Math.log(1 + value) / Math.log(1 + normMax) - 1);
      t = Math.min(1, 0.90 + 0.10 * extra);
    }
    return viridisColor(t, 0.95);
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
      header += ` · ${fmtBJShortDateTime(candle.openTime)} (UTC+8)`;
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

  // ============================================================
  // 测量工具 (Measurement tool · drag-to-measure on main chart)
  // ============================================================
  const measureBtn = document.getElementById('measure-toggle');

  // 在主图容器内创建覆盖层 (overlay layer) ----------------------
  // mainChart 容器的 position 已由 lightweight-charts 内部设置成 relative
  const measureLayer = document.createElement('div');
  measureLayer.style.cssText =
    'position:absolute;inset:0;display:none;z-index:5;pointer-events:none;';

  const measureCanvas = document.createElement('canvas');
  measureCanvas.style.cssText =
    'position:absolute;inset:0;width:100%;height:100%;pointer-events:none;';
  measureLayer.appendChild(measureCanvas);

  const measureLabel = document.createElement('div');
  measureLabel.className = 'measure-label';
  measureLabel.style.display = 'none';
  measureLayer.appendChild(measureLabel);

  els.mainChart.appendChild(measureLayer);

  let measureActive = false;
  let measureDrag = null;     // 拖拽中的测量
  let measureResult = null;   // 上一次完成的测量（用于 resize 重绘）

  // 把 K 线周期映射成秒，用于估算"几根 K 线"
  // (Map interval string to seconds so we can compute bar counts.)
  function intervalToSeconds(intervalStr) {
    const m = String(intervalStr || '').match(/^(\d+)([smhdw])$/i);
    if (!m) return 3600;
    const n = Number(m[1]);
    const unit = m[2].toLowerCase();
    const mult = { s: 1, m: 60, h: 3600, d: 86400, w: 604800 }[unit] || 60;
    return n * mult;
  }

  function fmtDuration(seconds) {
    const s = Math.abs(Number(seconds) || 0);
    if (s < 60) return Math.round(s) + ' s';
    if (s < 3600) return (s / 60).toFixed(1) + ' min';
    if (s < 86400) return (s / 3600).toFixed(2) + ' h';
    return (s / 86400).toFixed(2) + ' d';
  }

  function fmtSigned(n, digits) {
    const sign = n >= 0 ? '+' : '';
    return sign + Number(n).toFixed(digits);
  }

  function resizeMeasureCanvas() {
    const w = els.mainChart.clientWidth;
    const h = els.mainChart.clientHeight;
    if (w <= 0 || h <= 0) return;
    const dpr = window.devicePixelRatio || 1;
    measureCanvas.width = Math.round(w * dpr);
    measureCanvas.height = Math.round(h * dpr);
    measureCanvas.style.width = w + 'px';
    measureCanvas.style.height = h + 'px';
    const ctx = measureCanvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function clearMeasureCanvas() {
    const ctx = measureCanvas.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, measureCanvas.width, measureCanvas.height);
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function drawMeasure(start, end) {
    resizeMeasureCanvas();
    const ctx = measureCanvas.getContext('2d');
    const w = els.mainChart.clientWidth;
    const h = els.mainChart.clientHeight;
    ctx.clearRect(0, 0, w, h);

    const x0 = Math.min(start.x, end.x);
    const x1 = Math.max(start.x, end.x);
    const y0 = Math.min(start.y, end.y);
    const y1 = Math.max(start.y, end.y);

    const isUp = end.price >= start.price;
    const fill = isUp ? 'rgba(74, 222, 128, 0.14)' : 'rgba(248, 113, 113, 0.14)';
    const stroke = isUp ? 'rgba(74, 222, 128, 0.85)' : 'rgba(248, 113, 113, 0.85)';

    ctx.fillStyle = fill;
    ctx.fillRect(x0, y0, x1 - x0, y1 - y0);

    ctx.strokeStyle = stroke;
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 3]);
    ctx.strokeRect(x0 + 0.5, y0 + 0.5, x1 - x0, y1 - y0);
    ctx.setLineDash([]);

    // 起点->终点 实线连线
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.moveTo(start.x, start.y);
    ctx.lineTo(end.x, end.y);
    ctx.stroke();

    // 起止圆点
    ctx.fillStyle = stroke;
    [[start.x, start.y], [end.x, end.y]].forEach(([px, py]) => {
      ctx.beginPath();
      ctx.arc(px, py, 3.5, 0, Math.PI * 2);
      ctx.fill();
    });
  }

  function updateMeasureLabel(start, end) {
    const dPrice = end.price - start.price;
    const pct = start.price !== 0 && Number.isFinite(start.price)
      ? (dPrice / start.price) * 100
      : 0;
    const intervalSec = intervalToSeconds(els.interval.value);
    const dTimeSec = (end.time != null && start.time != null)
      ? (end.time - start.time)
      : 0;
    const bars = intervalSec ? Math.round(Math.abs(dTimeSec) / intervalSec) : 0;

    const isUp = dPrice >= 0;
    const arrow = isUp ? '▲' : '▼';
    const color = isUp ? 'var(--accent)' : 'var(--accent-down)';
    const digits = pickPriceDigits(Math.max(Math.abs(start.price || 0), Math.abs(end.price || 0)));

    measureLabel.innerHTML = `
      <div class="ml-headline" style="color:${color}">
        ${arrow} ${fmtSigned(dPrice, digits)} (${fmtSigned(pct, 2)}%)
      </div>
      <div class="ml-row"><span class="ml-k">起 / From</span><span class="ml-v">${fmtPrice(start.price)}</span></div>
      <div class="ml-row"><span class="ml-k">止 / To</span><span class="ml-v">${fmtPrice(end.price)}</span></div>
      <div class="ml-row"><span class="ml-k">时长 / Duration</span><span class="ml-v">${fmtDuration(dTimeSec)}</span></div>
      <div class="ml-row"><span class="ml-k">K 线 / Bars</span><span class="ml-v">${bars}</span></div>
      <div class="ml-hint">Esc 清除 / clear · 再次点击按钮退出</div>
    `;

    // 定位标签：跟随终点，避免越界
    measureLabel.style.display = 'block';
    measureLabel.style.left = '0px';
    measureLabel.style.top = '0px';
    const lr = measureLabel.getBoundingClientRect();
    const cw = els.mainChart.clientWidth;
    const ch = els.mainChart.clientHeight;
    const padX = 12, padY = 12;
    let lx = end.x + padX;
    let ly = end.y + padY;
    if (lx + lr.width > cw - 4) lx = end.x - lr.width - padX;
    if (ly + lr.height > ch - 4) ly = end.y - lr.height - padY;
    if (lx < 4) lx = 4;
    if (ly < 4) ly = 4;
    measureLabel.style.left = lx + 'px';
    measureLabel.style.top = ly + 'px';
  }

  function getMeasurePoint(ev) {
    const rect = els.mainChart.getBoundingClientRect();
    const x = Math.max(0, Math.min(els.mainChart.clientWidth, ev.clientX - rect.left));
    const y = Math.max(0, Math.min(els.mainChart.clientHeight, ev.clientY - rect.top));
    const price = candleSeries.coordinateToPrice(y);
    const t = mainChart.timeScale().coordinateToTime(x);
    return { x, y, price: Number(price), time: typeof t === 'number' ? t : null };
  }

  function setMeasureActive(on) {
    measureActive = !!on;
    if (measureActive) {
      measureBtn.classList.add('active');
      measureBtn.textContent = '📏 测量中 / Measuring';
      measureLayer.style.display = 'block';
      measureLayer.style.pointerEvents = 'auto';
      measureLayer.style.cursor = 'crosshair';
      // 暂停 chart 的拖拽与缩放，避免与测量手势冲突
      mainChart.applyOptions({ handleScroll: false, handleScale: false });
    } else {
      measureBtn.classList.remove('active');
      measureBtn.textContent = '📏 测量 / Measure';
      measureLayer.style.pointerEvents = 'none';
      // 退出时清除残留并隐藏覆盖层
      measureDrag = null;
      measureResult = null;
      clearMeasureCanvas();
      measureLabel.style.display = 'none';
      measureLayer.style.display = 'none';
      mainChart.applyOptions({ handleScroll: true, handleScale: true });
    }
  }

  function clearCurrentMeasure() {
    measureDrag = null;
    measureResult = null;
    clearMeasureCanvas();
    measureLabel.style.display = 'none';
  }

  if (measureBtn) {
    measureBtn.addEventListener('click', () => setMeasureActive(!measureActive));
  }

  measureLayer.addEventListener('mousedown', (ev) => {
    if (!measureActive || ev.button !== 0) return;
    ev.preventDefault();
    resizeMeasureCanvas();
    const start = getMeasurePoint(ev);
    if (!Number.isFinite(start.price)) return;
    measureDrag = { start, end: start };
    measureResult = null;
    drawMeasure(start, start);
    updateMeasureLabel(start, start);
  });

  measureLayer.addEventListener('mousemove', (ev) => {
    if (!measureActive || !measureDrag) return;
    const end = getMeasurePoint(ev);
    if (!Number.isFinite(end.price)) return;
    measureDrag.end = end;
    drawMeasure(measureDrag.start, end);
    updateMeasureLabel(measureDrag.start, end);
  });

  // 在 window 上监听 mouseup，让用户在覆盖层外松开也能完成测量
  window.addEventListener('mouseup', (ev) => {
    if (!measureActive || !measureDrag) return;
    const end = getMeasurePoint(ev);
    if (Number.isFinite(end.price)) {
      measureDrag.end = end;
      drawMeasure(measureDrag.start, end);
      updateMeasureLabel(measureDrag.start, end);
    }
    measureResult = measureDrag;
    measureDrag = null;
  });

  document.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Escape') return;
    if (!measureActive) return;
    if (measureDrag || measureResult) {
      clearCurrentMeasure();
    } else {
      setMeasureActive(false);
    }
  });

  window.addEventListener('resize', () => {
    if (!measureActive) return;
    // resize 后图表坐标系会变，旧测量像素位置已不可信，直接清空。
    clearCurrentMeasure();
    resizeMeasureCanvas();
  });

  // 切换交易对/市场/周期/刷新数据时清空测量结果，避免错位
  if (els.symbol)   els.symbol.addEventListener('change', clearCurrentMeasure);
  if (els.market)   els.market.addEventListener('change', clearCurrentMeasure);
  if (els.interval) els.interval.addEventListener('change', clearCurrentMeasure);
  if (els.refresh)  els.refresh.addEventListener('click', clearCurrentMeasure);

  // 主图是否已经做过初次 fitContent。
  // 切换 symbol/market/interval 或点刷新时 reset，让下次 render 重新 fit；
  // 实时增量更新（SSE 推送）不会 reset，保留用户拖动 / 缩放的位置。
  // (Track whether we've fitted the time scale already; live updates must
  //  not reset the user's drag/zoom state.)
  let chartsFitted = false;
  function markChartsNeedFit() { chartsFitted = false; }

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

    // VWAP 兜底：SSE 推送的 candle 没有 vwap 字段（hub 缓存的是 raw kline），
    // 这里若任何一根 candle 缺 vwap 就本地累积计算一次，并回写到 candle 上，
    // 让 tooltip 里的"VWAP"行也能显示。避免出现"刷新后 VWAP 一闪即消失"。
    // (Re-derive VWAP locally when candles arrive from the SSE stream — the
    //  server-side hub caches raw klines without VWAP enrichment.)
    if (candles.some((c) => !Number.isFinite(c.vwap))) {
      let cumPV = 0;
      let cumVol = 0;
      for (const c of candles) {
        const tp = (Number(c.high) + Number(c.low) + Number(c.close)) / 3;
        const v = Number(c.volume) || 0;
        cumPV += tp * v;
        cumVol += v;
        c.vwap = cumVol > 0 ? cumPV / cumVol : tp;
      }
    }
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

    // CVD 副图与主图 K 线同源派生，随 interval 自动切换
    // (Derive CVD from the same candles so it auto-aligns with the chosen interval.)
    renderCvdFromCandles(candles);

    // OI 副图：主图 K 线变化后用最近一次 OI 响应重新按 openTime 对齐
    // (Realign cached OI samples to the new candle grid.)
    if (_lastOiResp) renderOpenInterest(_lastOiResp, candles);

    // 只在首次渲染或用户主动重置时 fitContent，避免实时刷新打断用户拖动
    // 主图 fit 后立即把所有副图拉到主图当前可见范围（联动同步）
    if (!chartsFitted) {
      mainChart.timeScale().fitContent();
      chartsFitted = true;
    }
    syncSubChartsToMain();
  }

  // ---- OI 副图：把 OI 数据按 K 线 openTime 对齐后渲染 ----
  // (Align OI samples to candle openTimes so OI bar count matches the main
  //  chart and the synced logical range stays accurate.)
  //
  // 当 OI 接口 period 与 K 线 interval 不一致（例如选了 1m K 线，OI 最小 5m）
  // 时，每根 K 线取「该 K 线区间内最后一条 OI 样本」，缺失则向前继承上一个值。
  // value 优先用 sumOpenInterestValue（USDT 名义额，可跨币种比较），缺失退化为
  // sumOpenInterest * close。
  let _lastOiResp = null;
  function renderOpenInterest(resp, candles) {
    _lastOiResp = resp || _lastOiResp;
    if (!resp) return;
    if (!resp.supported) {
      oiSeries.setData([]);
      return;
    }
    const oi = (resp.data || []).slice().sort((a, b) => a.openTime - b.openTime);
    const cands = Array.isArray(candles) && candles.length ? candles : lastCandles;
    if (!oi.length || !cands.length) {
      oiSeries.setData([]);
      return;
    }
    const points = [];
    let oiIdx = 0;
    let lastSample = null;
    for (let i = 0; i < cands.length; i += 1) {
      const c = cands[i];
      // 该 K 线右边界：closeTime；缺失则用下一根 openTime - 1
      const right = c.closeTime
        ? Number(c.closeTime)
        : (cands[i + 1] ? Number(cands[i + 1].openTime) - 1 : Number(c.openTime));
      // 推进 oiIdx 收集所有 ts <= right 的 OI 样本，记最后一个
      while (oiIdx < oi.length && oi[oiIdx].openTime <= right) {
        lastSample = oi[oiIdx];
        oiIdx += 1;
      }
      if (lastSample) {
        const v = Number.isFinite(lastSample.openInterestValue) && lastSample.openInterestValue > 0
          ? lastSample.openInterestValue
          : Number(lastSample.openInterest) * Number(c.close);
        if (Number.isFinite(v) && v > 0) {
          points.push({ time: toLwSeconds(c.openTime), value: v });
        }
      }
    }
    oiSeries.setData(points);
    // OI 副图永远跟随主图，不再 fitContent —— 否则 OI 数据后到时会把主图也拉跑
    syncSubChartsToMain();
  }

  // ---- CVD 副图：从 K 线 takerBuyBase 派生 (Derive CVD from K-line takerBuyBase) ----
  // Binance K 线带有 `takerBuyBase`（主动买的基础币量），
  // 因此每根 K 线的"主动买 - 主动卖" = 2 * takerBuyBase - volume，
  // 累积起来就是与该周期一一对应的 CVD 序列。
  // 这样 CVD 副图就能和主图 K 线时间轴严格对齐，并随 interval 切换。
  // (Derive bar delta = 2*takerBuyBase - volume so the resulting CVD curve
  //  shares the exact bar grid with the main chart for the chosen interval.)
  function renderCvdFromCandles(candles) {
    const points = [];
    let cum = 0;
    let lastTs = -Infinity;
    for (const c of candles || []) {
      const tb = Number(c.takerBuyBase);
      const v = Number(c.volume);
      if (!Number.isFinite(tb) || !Number.isFinite(v)) continue;
      const delta = 2 * tb - v;
      cum += delta;
      const ts = toLwSeconds(c.openTime);
      if (ts > lastTs) {
        points.push({ time: ts, value: cum });
        lastTs = ts;
      } else if (points.length) {
        points[points.length - 1].value = cum;
      }
    }
    cvdSeries.setData(points);
    // CVD 副图永远跟随主图，避免自己 fitContent 反过来影响主图视图
    syncSubChartsToMain();
  }

  /**
   * 把 [price, qty] 数组转成 X 升序的累积曲线点数组。
   * side='bid' → 从 best bid 往低价累，asks 类似。返回 X 升序便于 chart.js 渲染。
   */
  function _accumulateOrderBookSide(rows, side) {
    const filtered = (rows || [])
      .map((l) => [Number(l[0]), Number(l[1])])
      .filter(([p, q]) => Number.isFinite(p) && Number.isFinite(q) && q > 0);
    if (side === 'bid') filtered.sort((a, b) => b[0] - a[0]); // best 优先
    else filtered.sort((a, b) => a[0] - b[0]);
    let cum = 0;
    const pts = [];
    for (const [p, q] of filtered) {
      cum += p * q;
      pts.push({ x: p, y: cum });
    }
    return pts.sort((a, b) => a.x - b.x);
  }

  /**
   * 渲染订单簿主图层（当前盘口的两条实线）。
   * baseline 由 _renderOrderBookBaseline 单独维护，避免互相覆盖。
   */
  // 缓存"当前实时盘口"的最新一份，用于 baseline 切换 / hover 触发重绘时复用
  let _lastObBook = null;
  function renderOrderBook(book) {
    const chart = ensureOrderbookChart();
    _lastObBook = book;

    chart.data.datasets[0].data = _accumulateOrderBookSide(book.bids, 'bid');
    chart.data.datasets[1].data = _accumulateOrderBookSide(book.asks, 'ask');

    // mid 价：优先用后端给的 midPrice，缺失则用 bestBid/bestAsk 中点
    const mid = Number.isFinite(Number(book.midPrice))
      ? Number(book.midPrice)
      : (Number.isFinite(Number(book.bestBid)) && Number.isFinite(Number(book.bestAsk))
        ? (Number(book.bestBid) + Number(book.bestAsk)) / 2
        : null);
    chart.options.plugins.obMidLine.mid = mid;

    chart.update('none');
  }

  // ============================================================
  // 订单簿基线对比 (Order Book baseline rolling-window compare)
  // ============================================================
  // 设计：
  //   - 用户选择 windowMs (15m / 1h / 4h / 24h) 作为对比窗口
  //   - 默认锚点是 now，每 30 秒刷新一次基线（拉 now-windowMs 时刻的快照）
  //   - 主图 hover 任一根 K 线时锚点切到 hoverTime（仍取 anchor-windowMs 的快照）
  //     debounce 200ms 减少请求；离开 hover 后回到 now 锚点
  //   - 对比方式：在订单簿图上叠加两条虚线（基线买/卖墙），与当前实线对比
  //     当前线高于基线 = 该价位挂单"增厚"（新墙堆出）
  //     当前线低于基线 = 该价位挂单"撤离"（被撤单 / 被吃掉）
  //   - 状态文字显示"基线时刻 / 与请求时刻差值"，提醒用户基线的真实时间
  const _obBaselineState = {
    windowMs: 0,        // 0 = 关闭
    anchorMs: null,     // null = 用 now；hover 时为 hover 的毫秒时间
    snapshot: null,
    snapshotAt: null,
    requestedAt: null,
    fetching: false,
    autoTimer: null,
    hoverDebounce: null
  };

  function _obBaselineInfoText() {
    const s = _obBaselineState;
    if (!s.windowMs) return '基线已关闭 / Baseline off';
    if (!s.snapshot) {
      return s.fetching ? '基线加载中… / Loading baseline…'
                        : '尚无基线数据（录盘窗口未覆盖）/ No baseline yet';
    }
    const ageMin = Math.round(Math.max(0, (s.requestedAt || Date.now()) - s.snapshotAt) / 60000);
    const tag = s.anchorMs ? `锚定 hover` : `锚定 now`;
    return `基线: ${fmtBJShortDateTime(s.snapshotAt)} (${tag}, 距请求 ${ageMin} min)`;
  }

  function _renderObBaselineLines() {
    const chart = ensureOrderbookChart();
    const snap = _obBaselineState.snapshot;
    if (!snap) {
      chart.data.datasets[2].data = [];
      chart.data.datasets[3].data = [];
      chart.data.datasets[2].hidden = true;
      chart.data.datasets[3].hidden = true;
    } else {
      chart.data.datasets[2].data = _accumulateOrderBookSide(snap.bids, 'bid');
      chart.data.datasets[3].data = _accumulateOrderBookSide(snap.asks, 'ask');
      chart.data.datasets[2].hidden = false;
      chart.data.datasets[3].hidden = false;
    }
    if (els.obBaselineInfo) els.obBaselineInfo.textContent = _obBaselineInfoText();
    chart.update('none');
  }

  /**
   * 拉一次基线快照。anchorMs 为 null 表示用 now。
   * 防抖：fetching=true 时直接 skip。
   */
  async function _fetchObBaseline() {
    const s = _obBaselineState;
    if (!s.windowMs) {
      s.snapshot = null;
      s.snapshotAt = null;
      s.requestedAt = null;
      _renderObBaselineLines();
      return;
    }
    if (s.fetching) return;
    s.fetching = true;
    if (els.obBaselineInfo) els.obBaselineInfo.textContent = _obBaselineInfoText();
    try {
      const symbol = (els.symbol.value || 'BTCUSDT').toUpperCase();
      const market = els.market ? els.market.value : 'futures';
      // 录盘只对 BTCUSDT futures，所以非该 symbol/market 直接清空
      if (symbol !== 'BTCUSDT' || market !== 'futures') {
        s.snapshot = null; s.snapshotAt = null; s.requestedAt = null;
        if (els.obBaselineInfo) {
          els.obBaselineInfo.textContent = '基线仅支持 BTCUSDT 合约 / Baseline available only for BTCUSDT futures';
        }
        _renderObBaselineLines();
        return;
      }
      const anchor = s.anchorMs || Date.now();
      const at = anchor - s.windowMs;
      s.requestedAt = at;
      const url = `/api/orderbook/snapshot?symbol=${symbol}&market=${market}&at=${at}`;
      const data = await fetchJsonSoft(url);
      if (!data || !data.found) {
        s.snapshot = null;
        s.snapshotAt = null;
      } else {
        s.snapshot = { bids: data.bids, asks: data.asks };
        s.snapshotAt = data.snapshotAt;
      }
      _renderObBaselineLines();
    } finally {
      s.fetching = false;
    }
  }

  function _scheduleObBaselineAuto() {
    const s = _obBaselineState;
    if (s.autoTimer) { clearInterval(s.autoTimer); s.autoTimer = null; }
    if (!s.windowMs) return;
    // 30s 刷新一次"now 锚定"的基线（hover 锚定不会被 timer 触发）
    s.autoTimer = setInterval(() => {
      if (!s.anchorMs) _fetchObBaseline();
    }, 30_000);
  }

  function setObBaselineWindow(windowMs) {
    _obBaselineState.windowMs = Number(windowMs) || 0;
    _obBaselineState.anchorMs = null; // 切窗口时回到 now 锚定
    _scheduleObBaselineAuto();
    _fetchObBaseline();
  }

  /**
   * 主图 hover 时把锚点切到 hoverTime（debounce 200ms 减少请求）。
   * hoverMs 为 null 表示离开 hover → 恢复 now 锚定。
   */
  function setObBaselineHoverAnchor(hoverMs) {
    const s = _obBaselineState;
    if (!s.windowMs) return; // 关闭状态不响应 hover
    if (s.hoverDebounce) clearTimeout(s.hoverDebounce);
    s.hoverDebounce = setTimeout(() => {
      s.anchorMs = (hoverMs && Number.isFinite(hoverMs)) ? hoverMs : null;
      _fetchObBaseline();
    }, 200);
  }

  let currentSignalData = null;
  let currentAlertsData = null;

  function renderSignal(sig) {
    currentSignalData = sig;
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
    currentAlertsData = alertData;
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

  // ============================================================
  // SSE 实时模式 (Server-Sent Events realtime mode)
  // ============================================================
  // 当浏览器支持 EventSource 时，主图 K 线 / 订单簿改由 SSE 驱动，
  // 实时推送（K 线每秒 1-N 次，订单簿 100ms 节流）；
  // 信号 / 报警 / 指标快照仍走 10s 轮询（10s 内变化对决策不敏感）。
  // SSE 异常会自动 fallback：状态栏标红 + 继续依赖 10s 轮询数据。
  // ============================================================
  const SSE_RENDER_THROTTLE_MS = 200;
  // K 线静默超过此阈值 → 主动重连 SSE（而非降级到 10s 轮询）
  // 选择 30s 是因为 1m / 15m / 1h K 线在该时间内必有更新
  const KLINE_STALE_MS = 30_000;
  // watchdog 检查频率
  const WATCHDOG_INTERVAL_MS = 5_000;
  // 建立连接后多久内必须收到 snapshot；超时即视为初始化失败重连
  const SSE_INIT_TIMEOUT_MS = 8_000;

  const sseState = {
    supported: typeof EventSource !== 'undefined',
    es: null,
    active: false,
    ready: false,           // 当前是否处于推送中
    everReady: false,       // 是否至少 ready 过一次（用于决定 poll 是否还需要做主图 seed）
    candles: [],            // 由 SSE 推送维护的 K 线序列
    summary: null,
    patterns: { fvgs: [], liquidityVoids: [] }, // 由 10s poll 维护
    renderTimer: null,
    lastBookAt: 0,
    lastKlineAt: 0,
    lastErrorAt: 0,
    reconnectTimer: null,
    watchdogTimer: null,
    initTimer: null,
    backoffMs: 1000,
    // 调试可观察
    klineEventCount: 0,
    bookEventCount: 0,
    snapshotCount: 0,
    openedAt: 0
  };

  // 主图当前是否由 SSE 实时驱动；用于 poll 内决定是否跳过订单簿请求
  function isSSEDriving() {
    return sseState.active && sseState.ready;
  }
  // 主图是否已经由 SSE 接管渲染（即便 SSE 此刻断线，K 线也不再让 poll 周期性跳动）
  function sseOwnsMainChart() {
    return sseState.everReady;
  }

  // 浏览器侧直连 Binance WS（旧的 directKlineWS）已被移除：
  // 改由服务端 binanceStream + /api/stream/sse 统一推送 K 线 / 订单簿，
  // 让用户本地网络抖动时也不影响数据流（仅依赖到本服务的 SSE 长连接）。
  //
  // 之前路径错（@kline 在升级后只走 /market/ws/）导致 K 线一直收不到，
  // 现已修复 services/binanceStream.js 的 FUTURES_WS_BASE 走 /market/stream，
  // 服务端 ws hub 的 'kline' 事件会通过 SSE 'kline' event 推送到浏览器。

  function buildSSEUrl() {
    const symbol = (els.symbol.value || '').trim().toUpperCase() || 'BTCUSDT';
    const market = els.market.value;
    const interval = els.interval.value;
    const depth = obDepthForInterval(interval);
    const params = new URLSearchParams({
      symbol,
      market,
      interval,
      limit: '200',
      depth: String(depth),
      aggLimit: '200'
    });
    return `/api/stream/sse?${params.toString()}`;
  }

  function scheduleSSERender() {
    if (sseState.renderTimer) return;
    sseState.renderTimer = setTimeout(() => {
      sseState.renderTimer = null;
      if (!isSSEDriving()) return;
      renderMain({
        candles: sseState.candles,
        summary: sseState.summary || { symbol: '', market: '', interval: '', count: sseState.candles.length },
        fvgs: sseState.patterns.fvgs,
        liquidityVoids: sseState.patterns.liquidityVoids
      });
    }, SSE_RENDER_THROTTLE_MS);
  }

  // 把 SSE book 推送的纯档位数据转换成 renderOrderBook 期望的形状
  function renderOrderBookFromSSE(book) {
    if (!book || !book.bids || !book.asks) return;
    const topBid = book.bids[0];
    const topAsk = book.asks[0];
    const bestBid = topBid ? Number(topBid[0]) : null;
    const bestAsk = topAsk ? Number(topAsk[0]) : null;
    const mid = (Number.isFinite(bestBid) && Number.isFinite(bestAsk))
      ? (bestBid + bestAsk) / 2
      : null;
    renderOrderBook({
      bids: book.bids,
      asks: book.asks,
      bestBid,
      bestAsk,
      midPrice: mid
    });
  }

  function setSSELiveStatus(extra = '') {
    const cnt = sseState.klineEventCount;
    const tag = cnt > 0 ? ` · K线 ${cnt} 条` : '';
    setStatus(`实时 / Live · ${nowBJTimeHMS()} (UTC+8) · 服务端推送${tag}${extra}`);
  }

  function startSSE() {
    if (!sseState.supported) return false;
    stopSSE();
    sseState.active = true;
    sseState.ready = false;
    sseState.candles = [];
    sseState.summary = null;
    sseState.klineEventCount = 0;
    sseState.bookEventCount = 0;
    sseState.snapshotCount = 0;
    sseState.openedAt = Date.now();
    setStatus('建立实时连接… / Connecting SSE…');

    const url = buildSSEUrl();
    // eslint-disable-next-line no-console
    console.info('[sse] connecting', url);

    let es;
    try {
      es = new EventSource(url);
    } catch (err) {
      sseState.active = false;
      setStatus('SSE 不可用，使用轮询 / SSE unavailable, falling back', true);
      return false;
    }
    sseState.es = es;

    sseState.initTimer = setTimeout(() => {
      sseState.initTimer = null;
      if (sseState.snapshotCount === 0 && sseState.active) {
        // eslint-disable-next-line no-console
        console.warn(`[sse] init timeout (${SSE_INIT_TIMEOUT_MS}ms) — no snapshot received, force reconnect`);
        setStatus('实时连接超时，重连中… / SSE init timeout, retrying', true);
        restartSSE();
      }
    }, SSE_INIT_TIMEOUT_MS);

    es.addEventListener('open', () => {
      // eslint-disable-next-line no-console
      console.info(`[sse] open · readyState=${es.readyState} latency=${Date.now() - sseState.openedAt}ms`);
    });

    es.addEventListener('snapshot', (ev) => {
      try {
        const d = JSON.parse(ev.data);
        sseState.candles = Array.isArray(d.klines) ? d.klines.slice() : [];
        sseState.summary = {
          symbol: d.symbol, market: d.market, interval: d.interval,
          count: sseState.candles.length
        };
        sseState.ready = true;
        sseState.everReady = true;
        sseState.snapshotCount += 1;
        sseState.lastKlineAt = Date.now(); // snapshot 视为一次 fresh K 线
        sseState.backoffMs = 1000;
        if (sseState.initTimer) {
          clearTimeout(sseState.initTimer);
          sseState.initTimer = null;
        }
        startWatchdog();
        renderMain({
          candles: sseState.candles,
          summary: sseState.summary,
          fvgs: sseState.patterns.fvgs,
          liquidityVoids: sseState.patterns.liquidityVoids
        });
        renderOrderBookFromSSE(d.book);
        setSSELiveStatus(' · snapshot OK');
        // eslint-disable-next-line no-console
        console.info(
          `[sse] snapshot received · symbol=${d.symbol} market=${d.market}`
          + ` interval=${d.interval} klines=${sseState.candles.length}`
        );
        // 主图 K 线增量完全交由本 SSE 连接的 'kline' event 推送，
        // 不再启动浏览器侧直连 binance ws（避免本地网络抖动 / 区域限制）
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn('[sse] snapshot parse error', err);
      }
    });

    es.addEventListener('kline', (ev) => {
      try {
        const d = JSON.parse(ev.data);
        const c = d.candle;
        if (!c || !sseState.summary) return;
        if (d.interval !== sseState.summary.interval) return; // 不同周期忽略
        const idx = sseState.candles.findIndex((x) => x.openTime === c.openTime);
        if (idx >= 0) sseState.candles[idx] = c;
        else sseState.candles.push(c);
        if (sseState.candles.length > 1500) {
          sseState.candles.splice(0, sseState.candles.length - 1500);
        }
        sseState.lastKlineAt = Date.now();
        sseState.klineEventCount += 1;
        if (sseState.klineEventCount === 1) {
          // eslint-disable-next-line no-console
          console.info(`[sse] first kline arrived after ${Date.now() - sseState.openedAt}ms`);
        }
        scheduleSSERender();
      } catch (_) { /* swallow */ }
    });

    es.addEventListener('book', (ev) => {
      try {
        const d = JSON.parse(ev.data);
        renderOrderBookFromSSE(d);
        sseState.lastBookAt = Date.now();
        sseState.bookEventCount += 1;
      } catch (_) { /* swallow */ }
    });

    es.addEventListener('error', (ev) => {
      // 任何 error 都立刻 ready=false，停掉 pending 渲染。
      // 主图不再降级到 poll —— 等 EventSource 自动重连成功后 snapshot 会再来。
      sseState.ready = false;
      if (sseState.renderTimer) {
        clearTimeout(sseState.renderTimer);
        sseState.renderTimer = null;
      }
      // 服务端通过 `event: error\ndata: ...` 主动报错（init 失败之类）
      // 这种事件 ev.data 会有内容；普通连接错误 data 为空。
      const serverErr = ev && ev.data ? (() => {
        try { return JSON.parse(ev.data); } catch (_) { return ev.data; }
      })() : null;
      // eslint-disable-next-line no-console
      console.warn(
        '[sse] error · readyState=' + (es && es.readyState),
        'serverErr=', serverErr,
        'klineEvents=', sseState.klineEventCount,
        'bookEvents=', sseState.bookEventCount
      );
      // 状态文本节流，避免每秒刷屏
      const nowMs = Date.now();
      if (nowMs - sseState.lastErrorAt < 3000) return;
      sseState.lastErrorAt = nowMs;
      if (es.readyState === EventSource.CLOSED) {
        sseState.active = false;
        setStatus('实时连接断开，重连中… / SSE disconnected, reconnecting', true);
        scheduleSSEReconnect();
      } else {
        setStatus('实时连接抖动，自动重连中 / SSE blip, auto-retry', true);
      }
    });
    return true;
  }

  function stopSSE() {
    if (sseState.es) {
      try { sseState.es.close(); } catch (_) { /* noop */ }
    }
    sseState.es = null;
    sseState.active = false;
    sseState.ready = false;
    if (sseState.renderTimer) {
      clearTimeout(sseState.renderTimer);
      sseState.renderTimer = null;
    }
    if (sseState.reconnectTimer) {
      clearTimeout(sseState.reconnectTimer);
      sseState.reconnectTimer = null;
    }
    if (sseState.initTimer) {
      clearTimeout(sseState.initTimer);
      sseState.initTimer = null;
    }
    stopWatchdog();
  }

  // ---- Watchdog：监控 K 线推送活性，必要时主动重连 ------------------
  // 主图完全由 SSE 驱动；如果 SSE 仍 active+ready 但 K 线静默 > 30s，
  // 视为推送中断（路径阻塞 / Binance 限流 / 反代 buffer 等），
  // 直接 close + 重新建立连接，而不是降级到 10s 轮询。
  // (Main chart is SSE-driven only. If SSE looks alive but no kline arrived
  //  for 30s, force a reconnect instead of falling back to polling.)
  function startWatchdog() {
    stopWatchdog();
    sseState.watchdogTimer = setInterval(() => {
      if (!sseState.active || !sseState.ready) return;
      const idle = Date.now() - (sseState.lastKlineAt || 0);
      if (idle > KLINE_STALE_MS) {
        // eslint-disable-next-line no-console
        console.warn(`[sse] watchdog: K-line idle ${idle}ms, forcing reconnect`);
        setStatus(`实时静默 ${Math.round(idle / 1000)}s，强制重连 / SSE idle, force reconnect`, true);
        restartSSE();
      }
    }, WATCHDOG_INTERVAL_MS);
  }
  function stopWatchdog() {
    if (sseState.watchdogTimer) {
      clearInterval(sseState.watchdogTimer);
      sseState.watchdogTimer = null;
    }
  }

  // SSE 自动重连：使用退避避免请求风暴
  function scheduleSSEReconnect() {
    if (sseState.reconnectTimer) return;
    const delay = Math.min(sseState.backoffMs, 30_000);
    sseState.reconnectTimer = setTimeout(() => {
      sseState.reconnectTimer = null;
      sseState.backoffMs = Math.min(sseState.backoffMs * 2, 30_000);
      startSSE();
    }, delay);
  }

  // 用户主动 restart（切换 symbol/market/interval / 点刷新）
  function restartSSE() {
    if (!sseState.supported) return;
    stopSSE();
    sseState.backoffMs = 1000;
    startSSE();
  }

  // ---- 主轮询循环 (Main poll cycle) ----
  let inFlight = false;
  async function poll() {
    if (inFlight) return;
    inFlight = true;
    const symbol = els.symbol.value.trim().toUpperCase() || 'BTCUSDT';
    const market = els.market.value;
    const interval = els.interval.value;
    // 仅在 SSE 还没接管的"首屏 / 降级"模式下显示 fetching 提示，
    // 避免在实时模式下每 10s 把"实时 / Live"覆盖成"请求数据中"。
    if (!sseOwnsMainChart()) {
      setStatus('请求数据中… / Fetching…');
    }
    const startedAt = Date.now();
    try {
      // 用 fetchJsonSoft，单一端点失败不会拖垮整个面板
      // (Use soft fetch so a single failed endpoint doesn't blank the dashboard.)
      // 订单簿深度档位随 interval 自适应（短周期看细盘 / 长周期看深盘）
      // (Order-book depth scales with interval so longer timeframes show
      //  more levels and shorter ones zoom in on the touch.)
      const obDepth = obDepthForInterval(interval);
      // 主图归 SSE 管：一旦 SSE 成功过一次，就不再拉订单簿（避免 10s 跳动 + 节省请求）
      // (Once SSE has succeeded at least once, the main chart and order book
      //  are owned by SSE; poll skips fetching them entirely.)
      const sseOwns = sseOwnsMainChart();
      const obFetch = sseOwns
        ? Promise.resolve(null)
        : fetchJsonSoft(`/api/orderbook/indicators?symbol=${symbol}&depth=${obDepth}&market=${market}&interval=${interval}`);
      // OI 仅合约支持；现货时直接传 spot，后端会回 supported:false，前端清空
      const oiFetch = fetchJsonSoft(
        `/api/openInterest?symbol=${symbol}&market=${market}&interval=${interval}&limit=200`
      );
      const [kData, obData, oiData, signal, alerts] = await Promise.all([
        fetchJsonSoft(`/api/klines?symbol=${symbol}&interval=${interval}&limit=200&market=${market}&detectPatterns=true`),
        obFetch,
        oiFetch,
        fetchJsonSoft(`/api/trade/signal?symbol=${symbol}&market=${market}`),
        fetchJsonSoft(`/api/alerts/liquidity?symbol=${symbol}&market=${market}`)
      ]);

      const failed = [];
      if (kData) {
        if (sseOwns) {
          // SSE 接管 K 线渲染：这里只更新 FVG / Liquidity Voids
          // 当 SSE 此刻仍在推送时触发一次重绘把新 patterns 叠上去；
          // SSE 断线期间不重绘，等重连后由 SSE 自己恢复。
          sseState.patterns = {
            fvgs: kData.fvgs || [],
            liquidityVoids: kData.liquidityVoids || []
          };
          if (isSSEDriving()) scheduleSSERender();
        } else {
          // 启动后首屏：SSE 还没成功过，poll 负责一次性把主图 seed 出来
          renderMain(kData);
        }
      } else failed.push('klines');

      if (!sseOwns) {
        if (obData) renderOrderBook(obData);
        else failed.push('orderbook');
      }
      // OI：拿到响应就用最新 lastCandles 对齐渲染；失败不阻塞，标 partial
      if (oiData) renderOpenInterest(oiData, lastCandles);
      else failed.push('openInterest');
      if (signal) renderSignal(signal); else failed.push('signal');
      if (alerts) renderAlerts(alerts); else failed.push('alerts');
      fitCharts();

      const elapsed = Date.now() - startedAt;
      if (failed.length) {
        const firstErr = Object.values(fetchJsonSoft.lastErrors)[0] || '';
        const detail = firstErr ? ` — ${firstErr}` : '';
        setStatus(
          `部分失败 / Partial: ${failed.join(',')} · ${nowBJTimeHMS()} (UTC+8) (${elapsed}ms)${detail}`,
          true
        );
      } else if (isSSEDriving()) {
        // SSE 在线时刷新一次"实时 / Live"标签里的时间戳，让用户能看到面板还活着
        setSSELiveStatus();
      } else if (!sseOwns) {
        setStatus(`已更新 / Updated · ${nowBJTimeHMS()} (UTC+8) (${elapsed}ms)`);
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

  /**
   * Binance USDⓈ-M Futures 不支持 1 秒 K 线（最小 1m），现货才有 1s。
   * 用户切 market / interval 时，自动调整另一项保持组合合法。
   * source 标识哪个控件是用户主动改的，从而决定回退哪一边：
   *   - 'interval'：用户刚选了 1s → 把 market 改到 spot
   *   - 'market':   用户刚改了 market → 把 interval 改回 15m
   * (Keep market+interval pair compatible; futures has no 1s klines.)
   */
  function enforceIntervalMarketCompat(source) {
    const market = els.market.value;
    const interval = els.interval.value;
    if (interval !== '1s' || market !== 'futures') return false;
    if (source === 'interval') {
      els.market.value = 'spot';
      setStatus('合约不支持 1 秒 K 线，已切换到现货 / Futures has no 1s kline, switched to Spot', true);
    } else {
      els.interval.value = '15m';
      setStatus('合约不支持 1 秒 K 线，周期已切回 15m / Futures has no 1s kline, interval reset to 15m', true);
    }
    return true;
  }

  els.refresh.addEventListener('click', () => { markChartsNeedFit(); poll(); restartSSE(); });

  // ---- 统一全屏机制 (Unified fullscreen toggle) -------------------------
  // 任何元素加上 .is-fullscreen → 占满视口；同时只允许一个元素处于全屏。
  // 触发方式：
  //   1) 点击 .fs-btn[data-fs-target="<id>"]
  //   2) ESC 退出当前全屏
  // 退出 bug 关键：lightweight-charts / Chart.js / Canvas 都缓存了上次容器尺寸，
  // 浏览器 grid 重排可能在双 rAF 后仍未完成 → 必须用 rAF×2 + setTimeout 多重
  // 兜底，强制按真实 clientWidth/Height 重新 resize，否则会"看起来没回到原位置"。
  function _resizeAllAfterFullscreen() {
    const doResize = () => {
      try { fitCharts(); } catch (_) { /* noop */ }
      try { syncSubChartsToMain(); } catch (_) { /* noop */ }
      try { if (typeof orderbookChart !== 'undefined' && orderbookChart) orderbookChart.resize(); } catch (_) { /* noop */ }
      try { if (heatmap && typeof heatmap.resize === 'function') heatmap.resize(); } catch (_) { /* noop */ }
      try { if (typeof liqHeatmap !== 'undefined' && liqHeatmap && typeof liqHeatmap.resize === 'function') liqHeatmap.resize(); } catch (_) { /* noop */ }
    };
    // 双 rAF：等 layout 提交
    requestAnimationFrame(() => requestAnimationFrame(doResize));
    // 兜底 1：grid 重排有时比双 rAF 还慢（特别是 fixed → grid 回流）
    setTimeout(doResize, 120);
    // 兜底 2：极端情况（屏幕重绘 + 字体变化等）
    setTimeout(doResize, 350);
  }

  function toggleFullscreen(target, btn, force) {
    if (!target) return;
    const next = typeof force === 'boolean' ? force : !target.classList.contains('is-fullscreen');
    // 互斥：进入新全屏前，先把所有 .is-fullscreen 退出（包括 .card 与 .sub-pane）
    if (next) {
      document.querySelectorAll('.is-fullscreen').forEach((el) => {
        if (el !== target) {
          el.classList.remove('is-fullscreen');
          const b = el.querySelector(':scope > .card-header .fs-btn, :scope > .sub-pane-header .fs-btn');
          if (b) { b.textContent = '⛶'; b.classList.remove('active'); b.title = b.dataset.fsTitleNormal || '全屏 / Fullscreen'; }
        }
      });
    }
    target.classList.toggle('is-fullscreen', next);
    if (btn) {
      if (!btn.dataset.fsTitleNormal) btn.dataset.fsTitleNormal = btn.title || '全屏 / Fullscreen';
      btn.textContent = next ? '⤢' : '⛶';
      btn.classList.toggle('active', next);
      btn.title = next ? '退出全屏 / Exit fullscreen (Esc)' : btn.dataset.fsTitleNormal;
    }
    _resizeAllAfterFullscreen();
  }

  document.addEventListener('click', (e) => {
    const btn = e.target && e.target.closest && e.target.closest('.fs-btn[data-fs-target]');
    if (!btn) return;
    const target = document.getElementById(btn.dataset.fsTarget);
    if (!target) return;
    e.preventDefault();
    toggleFullscreen(target, btn);
  });

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    // 退出最近一次进入全屏的元素：sub-pane 优先于 card（pane 通常嵌在 card 里）
    const fsPane = document.querySelector('.sub-pane.is-fullscreen');
    if (fsPane) {
      const btn = fsPane.querySelector(':scope > .sub-pane-header .fs-btn');
      toggleFullscreen(fsPane, btn, false);
      return;
    }
    const fsCard = document.querySelector('.card.is-fullscreen');
    if (fsCard) {
      const btn = fsCard.querySelector(':scope > .card-header .fs-btn');
      toggleFullscreen(fsCard, btn, false);
    }
  });
  els.symbol.addEventListener('change', () => {
    // 换 symbol 时也要清空 OI 缓存，下一次 poll 才会拉新值
    _lastOiResp = null;
    oiSeries.setData([]);
    // 订单簿基线只对 BTCUSDT futures 录盘；切到其他 symbol 时清空基线
    setObBaselineWindow(_obBaselineState.windowMs);
    if (heatmap) heatmap.onSymbolMarketChange();
    if (liqHeatmap) liqHeatmap.onSymbolMarketChange();
    markChartsNeedFit();
    poll();
    restartSSE();
  });
  els.market.addEventListener('change', () => {
    enforceIntervalMarketCompat('market');
    refreshSubTitles();
    // 切到现货时立刻清空 OI 旧数据，避免显示"上一个 symbol/market"的曲线
    _lastOiResp = null;
    oiSeries.setData([]);
    setObBaselineWindow(_obBaselineState.windowMs);
    if (heatmap) heatmap.onSymbolMarketChange();
    if (liqHeatmap) liqHeatmap.onSymbolMarketChange();
    markChartsNeedFit();
    poll();
    restartSSE();
  });
  els.interval.addEventListener('change', () => {
    enforceIntervalMarketCompat('interval');
    refreshSubTitles();
    markChartsNeedFit();
    poll();
    restartSSE();
  });
  // 订单簿基线选择 → 切窗口 / 关闭
  if (els.obBaseline) {
    els.obBaseline.addEventListener('change', () => {
      setObBaselineWindow(Number(els.obBaseline.value) || 0);
    });
  }
  // 页面加载时先把副图标题渲染成当前 interval，并按 dropdown 默认值初始化基线
  refreshSubTitles();
  if (els.obBaseline) {
    setObBaselineWindow(Number(els.obBaseline.value) || 0);
  }

  // ============================================================
  // 飞书推送 (Feishu push controls)
  // ============================================================
  const fsEls = {
    push: document.getElementById('fs-push'),
    pushForce: document.getElementById('fs-push-force'),
    test: document.getElementById('fs-test'),
    copy: document.getElementById('btn-copy-signal'),
    btnAiAnalyze: document.getElementById('btn-ai-analyze'),
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
        ? `上次信号 ${last.signal} @ ${fmtBJTimeHMS(last.ts)} (UTC+8)`
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
        setFsStatus(`已推送 / Pushed · ${j.data.signal} · ${nowBJTimeHMS()} (UTC+8)`, 'ok');
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

  if (fsEls.copy) {
    fsEls.copy.addEventListener('click', () => {
      // 只要有任何数据 (信号、快照、或者预警)，都可以复制
      if (!currentSignalData && !currentAlertsData) {
        alert('暂无数据 / No data yet');
        return;
      }
      
      const sig = currentSignalData || { signal: 'NONE' };
      const snap = sig.indicatorsSnapshot || {};
      const alerts = currentAlertsData || { flags: {}, riskScore: 0 };
      
      // 如果没有指标快照，尝试从页面元素中抓取部分信息作为后备
      const symbolInfo = snap.symbol 
        ? `${snap.symbol} · ${snap.market}` 
        : `${els.symbol.value.toUpperCase()} · ${els.market.value}`;
        
      const sideStr = sig.signal === 'LONG' ? '🟢 做多 LONG' : (sig.signal === 'SHORT' ? '🔴 做空 SHORT' : '⚪ 无信号 NONE');
      
      const tps = Array.isArray(sig.takeProfits) 
        ? sig.takeProfits.map((tp, i) => `TP${i+1}: ${fmt(tp.price, 4)} (平仓 ${(tp.closeFraction * 100).toFixed(0)}%)`).join('\n')
        : '无 / None';

      // 组装条件评估字符串
      const condLabels = {
        bullishFvg: '看涨 FVG', depthDominant: '深度比 > 0.6', cvdPriceUp: 'CVD↑ & 价↑',
        liquidityHealthy: '流动性健康', aboveVwap: '价 > VWAP',
        bearishFvg: '看跌 FVG', depthDominantSell: '深度比 < -0.6', cvdPriceDown: 'CVD↓ & 价↓',
        belowVwap: '价 < VWAP'
      };
      
      const longConds = snap.longConditions || {};
      const shortConds = snap.shortConditions || {};
      
      const longStr = Object.keys(longConds).length > 0
        ? Object.entries(longConds).map(([k, v]) => `${v ? '✅' : '❌'} ${condLabels[k] || k}`).join('\n')
        : '无数据';
      const shortStr = Object.keys(shortConds).length > 0
        ? Object.entries(shortConds).map(([k, v]) => `${v ? '✅' : '❌'} ${condLabels[k] || k}`).join('\n')
        : '无数据';

      // 组装预警字符串
      const flagLabels = {
        spreadShock: '价差异常', illiqShock: '低流动性', depthImbalance: '深度失衡',
        vwapDeviation: 'VWAP 偏离', cvdPriceDivergence: 'CVD/价格背离'
      };
      const alertStr = Object.entries(flagLabels).map(([k, label]) => {
        const on = !!(alerts.flags && alerts.flags[k]);
        return `${on ? '⚠️ 触发' : '➖ 正常'} : ${label}`;
      }).join('\n');

      
      const text = `【交易信号 / Trade Signal】
交易对: ${symbolInfo}
方向: ${sideStr}

入场价 (Entry): ${sig.entryPrice == null ? '-' : fmt(sig.entryPrice, 4)}
止损价 (SL): ${sig.stopLoss == null ? '-' : fmt(sig.stopLoss, 4)}
风险金额 (Risk): ${sig.riskAmount == null ? '-' : fmt(sig.riskAmount, 2)}
仓位大小 (Size): ${sig.positionSize == null ? '-' : fmt(sig.positionSize, 6)}
名义本金 (Notional): ${sig.positionSizeQuote == null ? '-' : fmt(sig.positionSizeQuote, 2)}

【止盈目标 / Take-Profits】
${tps}

【条件评估 / Condition Check】
[多头 / LONG]
${longStr}

[空头 / SHORT]
${shortStr}

【流动性预警 / Liquidity Alerts】
${alertStr}
综合风险分数: ${alerts.riskScore || 0}/5

【指标快照 / Indicators Snapshot】
最新价 (Last Price): ${snap.latestPrice != null ? fmt(snap.latestPrice, 4) : '-'}
VWAP: ${snap.vwap != null ? fmt(snap.vwap, 4) : '-'}
ATR(14): ${snap.atr != null ? fmt(snap.atr, 4) : '-'}
深度比 (Depth Ratio): ${snap.depthRatio != null ? fmt(snap.depthRatio, 3) : '-'}
价差 (Spread): ${snap.spread != null ? fmt(snap.spread, 4) : '-'}
CVD: ${snap.cvd != null ? fmt(snap.cvd, 3) : '-'}
CVD-Price ρ: ${snap.cvdPriceCorr != null ? fmt(snap.cvdPriceCorr, 3) : '-'}
ILLIQ: ${snap.latestIlliq != null ? Number(snap.latestIlliq).toExponential(2) : '-'} (μ: ${snap.illiqMean != null ? Number(snap.illiqMean).toExponential(2) : '-'})
多头评分: ${snap.longScore ?? '-'} / 空头评分: ${snap.shortScore ?? '-'}
`;

      navigator.clipboard.writeText(text).then(() => {
        const origText = fsEls.copy.textContent;
        fsEls.copy.textContent = '已复制 / Copied!';
        setTimeout(() => { fsEls.copy.textContent = origText; }, 2000);
      }).catch(err => {
        alert('复制失败 / Copy failed: ' + err.message);
      });
    });
  }

  if (fsEls.btnAiAnalyze) {
    fsEls.btnAiAnalyze.addEventListener('click', async () => {
      console.log('[AI Analyze] Button clicked');
      if (!currentSignalData && !currentAlertsData) {
        console.warn('[AI Analyze] No data available');
        alert('暂无数据 / No data yet');
        return;
      }
      
      const btn = fsEls.btnAiAnalyze;
      const origText = btn.textContent;
      btn.textContent = '分析中... / Analyzing...';
      btn.disabled = true;
      
      try {
        const sig = currentSignalData || { signal: 'NONE' };
        const snap = sig.indicatorsSnapshot || {};
        const alerts = currentAlertsData || { flags: {}, riskScore: 0 };
        
        const symbol = snap.symbol || els.symbol.value.toUpperCase();
        const direction = sig.signal === 'NONE' ? null : sig.signal;
        
        console.log('[AI Analyze] Preparing payload for symbol:', symbol);
        
        const condLabels = {
          bullishFvg: '看涨 FVG', depthDominant: '深度比 > 0.6', cvdPriceUp: 'CVD↑ & 价↑',
          lliqLow: '流动性较好', riskLow: '综合风险 ≤2', vwapSupport: '价 > VWAP',
          bearishFvg: '看跌 FVG', depthWeak: '深度比 < 0.4', cvdPriceDown: 'CVD↓ & 价↓',
          vwapResist: '价 < VWAP'
        };
        const alertLabels = {
          highSpread: '价差过大', lowDepth: '盘口深度薄弱', highIlliq: 'ILLIQ异常高',
          cvdDivergence: 'CVD背离', flashCrashRisk: '闪崩风险', squeezeRisk: '逼空风险'
        };

        const longConditions = snap.longConditions 
          ? Object.keys(snap.longConditions).filter(k => snap.longConditions[k]).map(k => condLabels[k] || k) 
          : [];
        const shortConditions = snap.shortConditions 
          ? Object.keys(snap.shortConditions).filter(k => snap.shortConditions[k]).map(k => condLabels[k] || k) 
          : [];
        const liquidityAlerts = Object.keys(alerts.flags || {})
          .filter(k => alerts.flags[k])
          .map(k => alertLabels[k] || k);

        const payload = {
          symbol,
          direction,
          entry_price: sig.entryPrice,
          stop_loss: sig.stopLoss,
          take_profits: sig.takeProfits ? JSON.stringify(sig.takeProfits.map(tp => tp.price)) : undefined,
          risk_amount: sig.riskAmount,
          position_size: sig.positionSize,
          notional: sig.positionSizeQuote,
          long_conditions: longConditions.length ? JSON.stringify(longConditions) : undefined,
          short_conditions: shortConditions.length ? JSON.stringify(shortConditions) : undefined,
          liquidity_alerts: liquidityAlerts.length ? JSON.stringify(liquidityAlerts) : undefined,
          risk_score: alerts.riskScore,
          long_score: snap.longScore,
          short_score: snap.shortScore,
          last_price: snap.latestPrice,
          vwap: snap.vwap,
          atr14: snap.atr,
          depth_ratio: snap.depthRatio,
          spread: snap.spread,
          cvd: snap.cvd,
          cvd_price_corr: snap.cvdPriceCorr,
          illiq: snap.latestIlliq
        };

        Object.keys(payload).forEach(key => payload[key] === undefined && delete payload[key]);
        console.log('[AI Analyze] Payload ready:', payload);

        // 1. 发送信号到 AI 代理
        console.log('[AI Analyze] Sending POST /api/ai/signals');
        let res = await fetch('/api/ai/signals', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
        
        if (!res.ok) {
           const errText = await res.text();
           console.error('[AI Analyze] Submit failed:', res.status, errText);
           throw new Error('提交失败: ' + res.status + ' ' + res.statusText);
        }
        
        const created = await res.json();
        console.log('[AI Analyze] Signal created:', created);
        const signalId = created.id;
        
        if (!signalId) throw new Error('未返回信号 ID');

        // 2. 获取 AI 报告
        const reportEl = document.getElementById('ai-report-content');
        if (reportEl) reportEl.textContent = '等待分析报告... / Waiting for report...';
        
        console.log('[AI Analyze] Polling for reports, signalId:', signalId);
        // 简单重试机制获取报告
        let detail;
        for (let i = 0; i < 3; i++) {
          console.log(`[AI Analyze] Polling attempt ${i+1}/3...`);
          await new Promise(r => setTimeout(r, 2000));
          res = await fetch(`/api/ai/signals/${signalId}`);
          if (res.ok) {
            detail = await res.json();
            if (detail.reports && detail.reports.length > 0) {
               console.log('[AI Analyze] Report received');
               break;
            }
          } else {
             console.warn(`[AI Analyze] Polling failed:`, res.status);
          }
        }

        if (reportEl && detail && detail.reports && detail.reports.length > 0) {
          const report = detail.reports[detail.reports.length - 1];
          reportEl.textContent = report.content;
        } else if (reportEl) {
          console.warn('[AI Analyze] Timeout or no report returned');
          reportEl.textContent = '报告未生成或已超时 / No report returned or timeout';
        }
        
        btn.textContent = '分析完成 / Done!';
      } catch (err) {
        console.error('[AI Analyze] Error caught:', err);
        alert('AI 分析出错 / AI Analyze error: ' + err.message);
        btn.textContent = '出错 / Error';
      } finally {
        setTimeout(() => {
          btn.textContent = origText;
          btn.disabled = false;
        }, 3000);
      }
    });
  }

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
    chart.data.labels = curve.map((p) => fmtBJDate(p.time));
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
    return fmtBJShortDateTime(ts);
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
        nowBJTimeHMS() + ' (UTC+8)'
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
    startAutoPoll(); // 10s 轮询常开（信号 / 警报 / FVG 仍需要它）
    // 启动 SSE 实时通道：浏览器不支持时静默 fallback 到 10s 轮询
    if (sseState.supported) startSSE();
  }, 100);
})();
