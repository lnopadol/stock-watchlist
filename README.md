# Stock Watchlist Dashboard

A static, fast, energy-efficient stock watchlist hosted on GitHub Pages.

## Features

- **Sortable table** with verdict, status, risk, P/E, market cap, and **upside-to-target bar**
- **Click any row** for full thesis: what it does, bull/bear, buy-now signal, and **2-3 analyst houses** with cited sources and price targets
- **Weekly snapshots** in `data/snapshots/YYYY-Www.json` with **History view** showing week-over-week verdict and price changes
- **Notes column** saved automatically to your browser
- **Add / remove tickers** in the browser, then **Export** the updated JSON to commit
- **Search** across ticker, company, sector, and verdict
- **Tiny carbon footprint** — pure static files, no servers, no API calls on page load

## Files

```
stock-watchlist/
├── index.html              # Dashboard
├── styles.css
├── app.js
├── REFRESH.md              # ← Weekly refresh prompt (AI-efficient)
├── assets/                 # Favicon (the doggy)
└── data/
    ├── stocks.json         # Current watchlist
    └── snapshots/
        ├── index.json      # List of week labels
        └── 2026-Www.json   # Historical snapshots
```

## Weekly update workflow

See [REFRESH.md](./REFRESH.md). The TL;DR: paste a single prompt into a Computer chat once per week. The prompt is **narrow on purpose** — it only re-researches what changed, saving ~60-70% AI cost vs a full refresh.

## Local preview

Any static server works:

```bash
cd stock-watchlist
python3 -m http.server 8000
# open http://localhost:8000
```

## Why static?

- **Cheaper**: free on GitHub Pages
- **Greener**: each page view is ~50KB of cached static assets — close to zero CO₂ vs an always-on server
- **Faster**: no cold starts, no API rate limits
- **Safer**: no server to hack, no secrets to leak
