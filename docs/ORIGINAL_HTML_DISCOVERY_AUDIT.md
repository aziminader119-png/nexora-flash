# Discovery parity with original NEXORA HTML (read-only)

The original `nexora_flash_scanner.html` was recovered and inspected.
It used public `DEX Screener` token-pair data and compared
`priceUsd` across pools. Its original default input was **$10,000**,
swap fee **0.30% per leg**, slippage **0.15% per leg**, flash fee **0.05%**,
and gas **$2**. Its formula was:

```text
net = amount * ((sell.priceUsd / buy.priceUsd)
                 * (1-(swap+slippage)/100)^2
                 - 1 - flashFee/100) - gasUSD
```

This is a *price-screening estimate*: it does not check exact pool swap
output for the chosen input size, pool ticks or reserves, dynamic fees,
block synchronization, gas estimation or atomic flash-loan repayment.
It is mathematically unsuitable for declaring executable returns.

The new `lib/market-discovery.mjs` + `GET /api/discovery/spreads?chain=base`
reintroduces **market opportunity discovery**, not paper profit.
It compares published `priceNative` **only for exactly matching ordered
base/quote token contract addresses on the same chain**. Oppositely
oriented pairs cannot be compared without inversion and are excluded.
Pool identity is deduped by exact pair address. Minimum metadata
requirements are $50k reported liquidity, $5k 24-hour volume, and a
maximum published spread of 30% to suppress obvious outliers.
All thresholds are discovery heuristics, not executable liquidity checks.
The upstream calls only use two hardcoded token-pairs endpoints per
network, are capped to 600 fetched pool records in total, use a
7-second abort, a 60-second cache and a single in-flight refresh.

**Critical security boundaries:**
- Every signal has `qualification:'PUBLISHED_SPREAD_ONLY'`,
  `actionable:false`, and `executable:false`.
- The endpoint does **not** mutate the signed/executable opportunity list,
  route catalog, trusted venue registry, signer, or on-chain execution gates.
- `/api/routes/ranked` remains based on independent on-chain, block-pinned
  quotes. Discovery signals must not be mixed into its net-profit ranking.
- No automated pool allowlisting exists; discovered pairs require on-chain
  contract, token identity, router, fee and fork validation before promotion.
- No front-end changes or secrets; no new packages.

Sample requests after approved deployment:

```bash
curl -fsS http://127.0.0.1:3080/api/discovery/spreads?chain=base | jq '{mode,observedPools,totalSignals,signals:(.signals[:5])}'
curl -fsS http://127.0.0.1:3080/api/routes/ranked | jq '{bestObserved,recommendedForFurtherReview}'
```

Do not compare published spread `spreadBps` directly to amount-size
`netEstimate`: they measure different things. This change is only the
first step toward **independently verifying and safely importing more
pools into a scan-only catalog**. It does not solve 3–4-hop network
coverage, quote economics or execution safety by itself.
Keep `LIVE_EXECUTION=false` and
`MULTIHOP_EXECUTION_ENABLED=false` throughout acceptance.
