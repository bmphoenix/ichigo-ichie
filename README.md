# Ichigo Ichie

*"Ichigo ichie" (一期一会) is a Japanese phrase meaning "one time, one meeting" — treasure every encounter, because it may never come again. No market ever comes twice either, so this bot uses simple rules built to survive whatever comes next. It is free and open source for everyone I meet.*

日本語版: [README_ja.md](README_ja.md)

## What it is


A long-only trend-following bot (Google Apps Script) that trades BTC and ETH on the Coincheck spot market.
Capital is split 50/50 between BTC and ETH, and each coin trades only within its own budget. Long-only, no leverage.

## Files

| File | Description | Status |
|---|---|---|
| `gc_bot_btc_eth.gs` | GC version (main) | Paper trading |
| `dow_bot.gs` | Dow version (GC rules + Dow theory filter) | Paper trading for comparison |
| `README.md` | This document | |

## Rules

### GC version

For each coin, hold only while both conditions are true; when either breaks, sell and wait in JPY.

1. On the 15-minute chart, EMA50 is above EMA200 (golden cross state)
2. On the 4-hour chart, the close is above EMA200 (uptrend)

### Dow version

Adds one more condition to the GC version:

3. Dow theory uptrend on the 4-hour chart (swing highs/lows confirmed with 3 bars on each side; uptrend when both highs and lows are rising, ends when price closes below the latest swing low)

The Dow version filters out more false signals in choppy markets, but enters later, so it can lag in sharp one-way rallies.

## Backtest

BTC + ETH 50/50, orders filled at the open of the bar after the signal, using spreads measured on Coincheck (BTC 0.015%, ETH 0.1%).

| Period | GC version | Dow version |
|---|---|---|
| Apr 2018 – Sep 2026 | ~58x, max DD -28% | ~38x, max DD -30% |
| 2023 – | +195%, max DD -24% | +280%, max DD -17% |
| Since halving (Apr 2024) | +73%, max DD -25% | +97%, max DD -19% |
| 2025 – | +20%, max DD -25% | +42%, max DD -17% |

### Yearly returns (fresh start each January)

| Year | GC version | Dow version | Hold BTC + ETH 50/50 |
|---|---|---|---|
| 2018 (from Apr) | -2.6% | -16.4% | -56.8% |
| 2019 | +86.9% | +66.6% | +46.4% |
| 2020 | +272.7% | +268.6% | +387.3% |
| 2021 | +179.2% | +97.9% | +231.3% |
| 2022 | +0.6% | -4.0% | -66.0% |
| 2023 | +41.6% | +60.1% | +123.0% |
| 2024 | +76.4% | +71.5% | +83.6% |
| 2025 | +6.9% | +19.8% | -8.6% |
| 2026 (to Sep) | +14.5% | +21.4% | -6.6% |

Annualized: GC version ~61% (since 2018) / ~34% (since 2023); Dow version ~54% (since 2018) / ~43% (since 2023).
The GC version is stronger over the full period, while the Dow version has done better in the choppier markets of recent years. Both are being paper-traded side by side.

Win rate is around 30%, with a longest losing streak of 23 trades (Jan–Apr 2025). Most of the profit comes from a small number of large trends.
Sharpe ratio ~1.45 (buy-and-hold ~0.74). These are backtest results on historical data and do not guarantee future performance. Not investment advice.

## How it works

- Runs every 5 minutes (signals from Kraken public data; orders on Coincheck BTC/JPY and ETH/JPY)
- Sends trade and error notifications by email and Discord (notification is sent before writing records)
- Records to Google Sheets: Summary, Trade history, Log, Spread
- Retries temporary network errors; records that fail to write are queued and written on the next run (orders are never retried, to avoid double orders)
- Tracks and compares bid/ask spreads on Coincheck, bitFlyer, bitbank and GMO Coin

## Setup

1. Create a new Google Sheet → Extensions → Apps Script, paste the contents of the `.gs` file and save
2. Project Settings → Script Properties (optional):
   - `NOTIFY_EMAIL`: email address for notifications
   - `DISCORD_URL`: Discord webhook URL
3. Run `testNotify` to check notifications → run `setup` once (runs automatically every 5 minutes)
4. To go live: add `CC_KEY` and `CC_SECRET` (Coincheck API key, no withdrawal permission) to Script Properties, set `DRY_RUN` to `false`, then run `resetSim`

Run the GC version and the Dow version in separate spreadsheets (putting both in one script will mix their records).
Do not run both live on the same Coincheck account at the same time.

## Notes

- Never write secrets (API keys, webhook URLs, email addresses) directly in the code; use Script Properties
- In Japan, crypto gains are taxed as miscellaneous income
