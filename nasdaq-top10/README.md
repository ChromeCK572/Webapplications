# Nasdaq Top 10

A small web app that shows the 10 largest Nasdaq-listed companies by market cap and their price trends over **1M, 3M, YTD, 1Y, 3Y and 5Y**.

- **Comparison chart**: % change of all 10 stocks over the selected period
- **Stock cards**: latest price, % change for the period, and a sparkline. Click a card for its full price chart
- Light/dark theme follows your system setting; works on phones

## Run it

Requires Node.js 18 or newer. There is nothing to install.

```bash
cd nasdaq-top10
npm start          # live data at http://localhost:3000
npm run demo       # simulated data, no internet needed
```

Set `PORT` to use a different port, e.g. `PORT=8080 npm start`.

## How it works

`server.js` is a dependency-free Node server. It serves `public/` and proxies market data, because browsers can't call these APIs directly (CORS):

| Endpoint | Source | Cache |
|---|---|---|
| `GET /api/top10` | Nasdaq stock screener, sorted by market cap. Share classes of one company (GOOGL/GOOG) count once | 1 hour |
| `GET /api/history?range=1M\|3M\|YTD\|1Y\|3Y\|5Y` | Yahoo Finance chart API: daily closes up to 1Y, weekly for 3Y/5Y | 10 min |

If the Nasdaq screener can't be reached, the app falls back to a built-in top-10 list and shows a notice. If prices for a stock can't be fetched, its card shows "Data unavailable".

The frontend (`public/app.js`) uses [Chart.js](https://www.chartjs.org/) from cdnjs.

Data comes from unofficial public endpoints and may be delayed. It is not investment advice.
