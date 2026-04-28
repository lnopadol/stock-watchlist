# Weekly Refresh — How it works

This file explains how to update the dashboard each week with **minimum AI cost** and **minimum energy use**.

## The energy-efficient design

- **Static site, no backend** → GitHub Pages serves plain HTML/CSS/JSON. Near-zero compute.
- **No live API calls on page load** → the dashboard reads one cached `data/stocks.json` file. Loading the dashboard 100×/week costs nothing.
- **AI runs only on refresh** → research happens once per week, in parallel, in a single prompt below.
- **Notes saved locally** → no server round-trips while you work.

## Weekly refresh — copy/paste this into a Computer chat

> Refresh the stock watchlist. Read the current tickers from `stock-watchlist/data/stocks.json`, then for each ticker, do a **lightweight refresh** (do NOT redo the full research):
>
> 1. Get latest **price**, **market cap**, and **P/E ratio**.
> 2. Check whether any of the listed analyst houses have **changed their rating or target** in the past 7 days. If so, update their entry; otherwise leave it.
> 3. Re-evaluate **verdict** (Attractively / Reasonably / Premium Priced) and **buy_now_signal** if price moved >5% or a target changed.
> 4. Leave `what_it_does`, `is_good_bet`, `key_catalysts`, `key_risks`, and `notes` UNCHANGED unless there's been major news (M&A, profit warning, regulator action).
> 5. Save the updated file to `stock-watchlist/data/stocks.json` AND copy it to `stock-watchlist/data/snapshots/YYYY-Www.json` (use ISO week of today).
> 6. Append the new week label to `stock-watchlist/data/snapshots/index.json`.
> 7. Commit and push to GitHub with message "Weekly refresh: <date>".

This prompt is **deliberately narrow** — it tells the AI not to re-research stocks that haven't changed. That cuts cost and energy by ~60-70% vs a full re-research.

## Full re-research (only when needed)

Run this 1-2× per quarter, or after major macro events:

> Do a full research refresh of every ticker in `stock-watchlist/data/stocks.json` using the original research schema. Cross-reference 2-3 analyst houses per stock with cited sources.

## Adding tickers without a refresh

Use the **+ Add ticker** button on the dashboard. The new ticker appears immediately with placeholder text and `Under Review` status. It will be filled in on the next refresh.

## Removing tickers

Click the **×** in the row's last column. Click **Export** to download the updated `stocks.json` and commit it to GitHub.

## How history works

Every refresh writes a snapshot to `data/snapshots/YYYY-Www.json` (ISO week). The **History** button in the dashboard compares snapshots and shows:
- New / removed tickers
- Verdict changes
- Price moves ≥3% week-over-week

You can also browse old snapshots manually on GitHub.
