// Nasdaq Top 10 — tiny dependency-free Node server.
// Serves the static frontend and proxies market data (browsers can't call
// Yahoo/Nasdaq directly because of CORS).

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const DEMO = process.env.DEMO === '1';
const PUBLIC_DIR = path.join(__dirname, 'public');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

// Used when the live Nasdaq screener can't be reached.
const FALLBACK_TOP10 = [
  { symbol: 'NVDA', name: 'NVIDIA Corporation' },
  { symbol: 'MSFT', name: 'Microsoft Corporation' },
  { symbol: 'AAPL', name: 'Apple Inc.' },
  { symbol: 'GOOGL', name: 'Alphabet Inc.' },
  { symbol: 'AMZN', name: 'Amazon.com, Inc.' },
  { symbol: 'META', name: 'Meta Platforms, Inc.' },
  { symbol: 'AVGO', name: 'Broadcom Inc.' },
  { symbol: 'TSLA', name: 'Tesla, Inc.' },
  { symbol: 'NFLX', name: 'Netflix, Inc.' },
  { symbol: 'COST', name: 'Costco Wholesale Corporation' },
];

const RANGES = {
  '1M': { months: 1, interval: '1d' },
  '3M': { months: 3, interval: '1d' },
  'YTD': { ytd: true, interval: '1d' },
  '1Y': { months: 12, interval: '1d' },
  '3Y': { months: 36, interval: '1wk' },
  '5Y': { months: 60, interval: '1wk' },
};

const cache = new Map();
async function cached(key, ttlMs, fn) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.value;
  const value = await fn();
  cache.set(key, { at: Date.now(), value });
  return value;
}

async function fetchJson(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, Accept: 'application/json' },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`${res.status} from ${new URL(url).host}`);
  return res.json();
}

function parseMarketCap(v) {
  const n = Number(String(v || '').replace(/[^0-9.]/g, ''));
  return Number.isFinite(n) ? n : 0;
}

// Top 10 Nasdaq-listed companies by market cap. Share classes of the same
// company (e.g. GOOGL/GOOG) are collapsed so each company appears once.
async function getTop10() {
  if (DEMO) return { stocks: FALLBACK_TOP10, source: 'demo' };
  try {
    const data = await fetchJson(
      'https://api.nasdaq.com/api/screener/stocks?tableonly=true&exchange=nasdaq&limit=25&sortcolumn=marketCap&sortorder=desc'
    );
    const rows = (data?.data?.table?.rows || data?.data?.rows || [])
      .map((r) => ({
        symbol: String(r.symbol).trim().replace('/', '-'),
        name: String(r.name).replace(/\s+(Class [A-Z]|Common Stock|Ordinary Shares|American Depositary Shares).*$/i, '').trim(),
        marketCap: parseMarketCap(r.marketCap),
      }))
      .sort((a, b) => b.marketCap - a.marketCap);
    const seen = new Set();
    const stocks = [];
    for (const r of rows) {
      const key = r.name.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      stocks.push(r);
      if (stocks.length === 10) break;
    }
    if (stocks.length < 10) throw new Error('screener returned too few rows');
    return { stocks, source: 'live' };
  } catch (err) {
    console.warn(`Nasdaq screener unavailable (${err.message}); using fallback list`);
    return { stocks: FALLBACK_TOP10, source: 'fallback' };
  }
}

function rangeStart(range) {
  const cfg = RANGES[range];
  const d = new Date();
  if (cfg.ytd) return new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  d.setUTCMonth(d.getUTCMonth() - cfg.months);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

async function getHistory(symbol, range) {
  const { interval } = RANGES[range];
  const period1 = Math.floor(rangeStart(range).getTime() / 1000);
  const period2 = Math.floor(Date.now() / 1000);
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}` +
    `?period1=${period1}&period2=${period2}&interval=${interval}&includePrePost=false`;
  const data = await fetchJson(url);
  const result = data?.chart?.result?.[0];
  if (!result) throw new Error(data?.chart?.error?.description || 'no chart data');
  const closes = result.indicators?.quote?.[0]?.close || [];
  const points = (result.timestamp || [])
    .map((t, i) => ({ t: t * 1000, c: closes[i] }))
    .filter((p) => p.c != null);
  return {
    symbol,
    currency: result.meta?.currency || 'USD',
    price: result.meta?.regularMarketPrice ?? points.at(-1)?.c,
    points,
  };
}

// Deterministic random walk so demo mode looks the same on every reload.
function demoHistory(symbol, range) {
  let seed = [...symbol].reduce((s, ch) => s * 31 + ch.charCodeAt(0), 7) >>> 0;
  const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  const stepDays = RANGES[range].interval === '1wk' ? 7 : 1;
  const start = rangeStart(range).getTime();
  const points = [];
  let price = 50 + rand() * 450;
  for (let t = start; t <= Date.now(); t += stepDays * 86400000) {
    const day = new Date(t).getUTCDay();
    if (stepDays === 1 && (day === 0 || day === 6)) continue;
    price *= 1 + (rand() - 0.48) * 0.04 * Math.sqrt(stepDays);
    points.push({ t, c: Math.round(price * 100) / 100 });
  }
  return { symbol, currency: 'USD', price: points.at(-1).c, points };
}

async function handleApi(url, res) {
  if (url.pathname === '/api/top10') {
    const top = await cached('top10', 60 * 60 * 1000, getTop10);
    return sendJson(res, 200, top);
  }
  if (url.pathname === '/api/history') {
    const range = url.searchParams.get('range') || '1M';
    if (!RANGES[range]) return sendJson(res, 400, { error: `range must be one of ${Object.keys(RANGES).join(', ')}` });
    const top = await cached('top10', 60 * 60 * 1000, getTop10);
    const series = await Promise.all(
      top.stocks.map(async (s) => {
        if (DEMO) return { ...demoHistory(s.symbol, range), name: s.name, demo: true };
        try {
          const h = await cached(`h:${s.symbol}:${range}`, 10 * 60 * 1000, () => getHistory(s.symbol, range));
          return { ...h, name: s.name };
        } catch (err) {
          console.warn(`History for ${s.symbol} unavailable (${err.message})`);
          return { symbol: s.symbol, name: s.name, error: err.message, points: [] };
        }
      })
    );
    return sendJson(res, 200, { range, source: top.source, series });
  }
  sendJson(res, 404, { error: 'not found' });
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };

function serveStatic(url, res) {
  const rel = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403);
    return res.end();
  }
  fs.readFile(file, (err, buf) => {
    if (err) {
      res.writeHead(404);
      return res.end('Not found');
    }
    res.writeHead(200, { 'Content-Type': `${MIME[path.extname(file)] || 'application/octet-stream'}; charset=utf-8` });
    res.end(buf);
  });
}

http
  .createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    try {
      if (url.pathname.startsWith('/api/')) return await handleApi(url, res);
      serveStatic(url, res);
    } catch (err) {
      console.error(err);
      sendJson(res, 500, { error: err.message });
    }
  })
  .listen(PORT, () => {
    console.log(`Nasdaq Top 10 running at http://localhost:${PORT}${DEMO ? ' (demo data)' : ''}`);
  });
