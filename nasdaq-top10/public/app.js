// Frontend: fetches /api/history for the chosen range, renders a comparison
// (or single-stock) chart plus one card with a sparkline per stock.

const state = { range: '1M', data: null, selected: null, reqId: 0 };
let mainChart = null;
const sparkCharts = [];

const PALETTE = ['#2f5bd3', '#e5732f', '#1a9e77', '#c43c8f', '#7a5cd6', '#c9a227', '#2a9bc4', '#d6453d', '#5d8f2e', '#8a6a4f'];
const RANGE_LABEL = { '1M': '1 month', '3M': '3 months', YTD: 'year to date', '1Y': '1 year', '3Y': '3 years', '5Y': '5 years' };

const $ = (sel) => document.querySelector(sel);
const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

function pctChange(points) {
  if (points.length < 2) return null;
  return (points.at(-1).c / points[0].c - 1) * 100;
}
function fmtPct(v) {
  return v == null ? '—' : `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`;
}
function fmtPrice(v, currency = 'USD') {
  return v == null ? '—' : new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(v);
}
const dayKey = (t) => new Date(t).toISOString().slice(0, 10);
function fmtDate(t) {
  const long = ['3Y', '5Y'].includes(state.range);
  return new Date(t).toLocaleDateString('en-US', long ? { month: 'short', year: 'numeric' } : { month: 'short', day: 'numeric' });
}

async function load(range) {
  const id = ++state.reqId;
  state.range = range;
  document.querySelectorAll('#ranges button').forEach((b) => b.classList.toggle('active', b.dataset.range === range));
  if (!state.data) $('#cards').innerHTML = '<div class="skeleton"></div>'.repeat(10);
  try {
    const res = await fetch(`/api/history?range=${encodeURIComponent(range)}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || res.statusText);
    if (id !== state.reqId) return; // a newer range was picked meanwhile
    state.data = data;
    showNotice(data);
    render();
  } catch (err) {
    if (id !== state.reqId) return;
    setNotice(`Could not load data: ${err.message}`);
  }
}

function setNotice(text) {
  const el = $('#notice');
  el.hidden = !text;
  el.innerHTML = '';
  if (text) {
    const span = document.createElement('span');
    span.textContent = text;
    el.append(span);
  }
}
function showNotice(data) {
  const failed = data.series.filter((s) => s.error).map((s) => s.symbol);
  const msgs = [];
  if (data.source === 'demo') msgs.push('Demo mode: prices are simulated, not real market data.');
  if (data.source === 'fallback') msgs.push('Live Nasdaq ranking unavailable — showing a recent top-10 list.');
  if (failed.length) msgs.push(`No price data for ${failed.join(', ')}.`);
  setNotice(msgs.join(' '));
}

function render() {
  renderMainChart();
  renderCards();
}

function renderMainChart() {
  const { series } = state.data;
  const sel = series.find((s) => s.symbol === state.selected);
  const grid = css('--border');
  const muted = css('--muted');
  let datasets, labels, isPct;

  if (sel && sel.points.length) {
    isPct = false;
    const up = (pctChange(sel.points) ?? 0) >= 0;
    const color = up ? css('--up') : css('--down');
    labels = sel.points.map((p) => p.t);
    datasets = [{
      label: sel.symbol,
      data: sel.points.map((p) => p.c),
      borderColor: color,
      backgroundColor: color + '22',
      fill: true,
      borderWidth: 2,
      pointRadius: 0,
      tension: 0.15,
    }];
    $('#chart-title').textContent = `${sel.symbol} · ${sel.name}`;
    $('#chart-sub').innerHTML = `${fmtPrice(sel.price, sel.currency)} <span class="chg ${up ? 'up' : 'down'}">${fmtPct(pctChange(sel.points))}</span> over ${RANGE_LABEL[state.range]}`;
    $('#compare-btn').hidden = false;
  } else {
    isPct = true;
    // Align every series on the longest timeline so the x-axis is shared.
    const base = series.reduce((a, s) => (s.points.length > a.points.length ? s : a), series[0]);
    labels = base.points.map((p) => p.t);
    datasets = series.filter((s) => s.points.length).map((s, i) => {
      const byDay = new Map(s.points.map((p) => [dayKey(p.t), p.c]));
      const first = s.points[0].c;
      return {
        label: s.symbol,
        data: labels.map((t) => (byDay.has(dayKey(t)) ? (byDay.get(dayKey(t)) / first - 1) * 100 : null)),
        borderColor: PALETTE[i % PALETTE.length],
        backgroundColor: PALETTE[i % PALETTE.length],
        borderWidth: 1.75,
        pointRadius: 0,
        tension: 0.15,
        spanGaps: true,
      };
    });
    $('#chart-title').textContent = 'Performance comparison';
    $('#chart-sub').textContent = `% change over ${RANGE_LABEL[state.range]} — click a stock below for its price chart`;
    $('#compare-btn').hidden = true;
  }

  if (mainChart) mainChart.destroy();
  mainChart = new Chart($('#main-chart'), {
    type: 'line',
    data: { labels, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 250 },
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: isPct, position: 'bottom', labels: { color: muted, boxWidth: 10, boxHeight: 10, usePointStyle: true } },
        tooltip: {
          itemSort: (a, b) => b.parsed.y - a.parsed.y,
          callbacks: {
            title: (items) => new Date(labels[items[0].dataIndex]).toLocaleDateString('en-US', { dateStyle: 'medium' }),
            label: (ctx) => ` ${ctx.dataset.label}: ${isPct ? fmtPct(ctx.parsed.y) : fmtPrice(ctx.parsed.y, sel?.currency)}`,
          },
        },
      },
      scales: {
        x: {
          grid: { display: false },
          ticks: { color: muted, maxTicksLimit: 7, maxRotation: 0, callback: (v) => fmtDate(labels[v]) },
        },
        y: {
          position: 'right',
          grid: { color: grid },
          border: { display: false },
          ticks: { color: muted, callback: (v) => (isPct ? `${v}%` : fmtPrice(v, sel?.currency)) },
        },
      },
    },
  });
}

function renderCards() {
  sparkCharts.splice(0).forEach((c) => c.destroy());
  const wrap = $('#cards');
  wrap.innerHTML = '';
  state.data.series.forEach((s, i) => {
    const chg = pctChange(s.points);
    const dir = chg == null ? '' : chg >= 0 ? 'up' : 'down';
    const card = document.createElement('button');
    card.className = `card${s.symbol === state.selected ? ' selected' : ''}`;
    card.innerHTML = `
      <div class="card-top"><span class="sym"></span><span class="rank">#${i + 1}</span></div>
      <div class="name"></div>
      <div class="price">${fmtPrice(s.price, s.currency)}</div>
      <div class="chg ${dir}">${fmtPct(chg)} <span class="sub">· ${state.range}</span></div>
      ${s.points.length ? '<div class="spark"><canvas></canvas></div>' : '<div class="err">Data unavailable</div>'}`;
    card.querySelector('.sym').textContent = s.symbol;
    card.querySelector('.name').textContent = s.name;
    card.title = s.name;
    card.addEventListener('click', () => {
      state.selected = state.selected === s.symbol ? null : s.symbol;
      render();
      if (state.selected) $('.panel').scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
    wrap.append(card);
    if (s.points.length) sparkCharts.push(sparkline(card.querySelector('canvas'), s.points, dir));
  });
}

function sparkline(canvas, points, dir) {
  const color = css(dir === 'down' ? '--down' : '--up');
  return new Chart(canvas, {
    type: 'line',
    data: {
      labels: points.map((p) => p.t),
      datasets: [{ data: points.map((p) => p.c), borderColor: color, backgroundColor: color + '1f', fill: true, borderWidth: 1.5, pointRadius: 0, tension: 0.2 }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      events: [],
      plugins: { legend: { display: false }, tooltip: { enabled: false } },
      scales: { x: { display: false }, y: { display: false } },
    },
  });
}

$('#ranges').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-range]');
  if (btn && btn.dataset.range !== state.range) load(btn.dataset.range);
});
$('#compare-btn').addEventListener('click', () => {
  state.selected = null;
  render();
});
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => state.data && render());

load(state.range);
