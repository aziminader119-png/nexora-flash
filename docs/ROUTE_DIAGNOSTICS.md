# NEXORA v1.2 — read-only per-hop / liquidity diagnostics

The Base scan found actual 5-hop quotes with approximately 50–100% cycle losses. Directly comparing intermediate token base units is **invalid**: 500 USDC units and 500 wei/WETH/cbBTC units are not the same economic value.

This feature adds a quote-scale *price-impact warning* without touching the executor or dashboard.

## API

Use the existing localhost-only SSH tunnel. No admin token is needed for the read-only status endpoints.

```bash
curl -s 'http://127.0.0.1:3080/api/multihop/cycles?chainId=8453&limit=3' |
  jq '.cycles[] | {pair,size,netEstimate,profitQualification,diagnostics}'
curl -s 'http://127.0.0.1:3080/api/multihop/sizes?chainId=8453&limit=200' |
  jq '{total,sizeComparisons}'
```

Each cycle can include `diagnostics.trace[]`: hop number, router/pool, token addresses and symbols, raw input/output integer amounts and (where probed) a **same-pool, same-direction, same-block** quote-scale impact estimate. These are token raw amounts, **not USD prices**.

To compare impact on a single hop, the scanner requests a quote for 10% of the hop's full input from the same pool and block. If the 10× scaled smaller quote exceeds the large-size quote, it records the approximate shortfall as `priceImpactBps`. `liquidityRisk` can be `HIGH` (>=1500 bps), `ELEVATED` (>=300 bps), `NO_LARGE_IMPACT_OBSERVED`, or `UNKNOWN`. This metric is approximate: it does not distinguish market price movements between pools or prove tradable liquidity, precise price impact, or profit.

To avoid overloading RPC, extra impact quotes are **capped at 10 per network scan, for the two top-ranked candidate routes**; all other routes have a raw-amount trace with `impactStatus=NOT_PROBED`. Every extra quote uses the scanner's block number, and quote failures leave impact `UNKNOWN`. The new calls are read-only, and failures never unlock a trade.

The sizes endpoint groups **exact directed pool/token/fee-tier sequences**, not merely displayed pair names. This makes it possible to compare the `size`, `netEstimate`, quoted lender fee and gas estimates of the **same route** at multiple sizes, if they were quoted under the scan cap. A route may have only one quoted size. No artificial execution-price extrapolation occurs.

## Safety

`LIVE_EXECUTION=false` and `MULTIHOP_EXECUTION_ENABLED=false` remain in place for the server pilot. The scanner creates analytics only; it does not change slippage limits, enable venues, approve tokens, sign transactions or make any funded calls. Unknown / unprobed impact is **never interpreted as low risk**. No data from this module can bypass the existing deployment/fork/owner gate.

## Validate and deploy

1. Review this branch against PR #15 and run all CI checks on its exact commit.
2. Deploy the exact tested SHA using `install-ubuntu.sh`, which preserves existing `/etc/nexora/nexora.env`, Base's `/etc/nexora/multihop.json`, and private history.
3. Confirm the new per-hop traces and loan-size groups in the GET endpoints while /api/status still reports `SCAN_ONLY` and `liveExecutionEnabled=false`.
4. Observe RPC latency / scan truncation. If scan times increase, reduce read-only probes before expanding catalogs across additional networks.
