# NEXORA adaptive route ranking (scan-only)

**Goal:** choose the best *economic* route, not the route with the most swaps. A 2-hop route with higher quoted net return wins against a 10-hop route with a lower quoted return. Nobody should turn quotes into executable trades without fresh fork simulation and the existing security gates.

## Observation endpoints

```bash
curl -s http://127.0.0.1:3080/api/routes/ranked |
  jq '{total,bestObserved,recommendedForFurtherReview,topObserved}'
curl -s http://127.0.0.1:3080/api/status |
  jq '[.networks[]|{name,multiHopQuotes,multiHopRootsExplored,multiHopRootsEligible,multiHopTruncated}]'
```

The ranking covers **current dashboard candidates** (2-leg, and catalog-sourced 5–10-leg). It does not claim to have enumerated 3–4 leg routes; those need additional discovery work. All results are **read-only**, marked `executable:false`. Negative routes may appear in `bestObserved` for transparency but are never `recommendedForFurtherReview`. Positive short routes lacking independent size-impact probes are labelled `IMPACT_UNVERIFIED` and are not review-qualified. The existing funded execution gates are unchanged.

The bounded 5–10-leg scanner divides quote calls **first by loan size, then by eligible first-hop branch**. It guarantees each selected branch a minimum-hop-depth quote allocation and rotates root branches each scan. A route that can never reach the stable loan asset is pruned before any network calls. A quote failure leaves a route unqualified; budget truncation remains explicitly visible. This is improved **coverage**, not proof of market profitability.

For the live Base catalog of Nov 14, on observed 50/100/250/500 USDC inputs, all sampled 5-hop routes returned negative net quotes. The best among losses is **not a good route**. The next actual economic improvement would be adding *verified* alternative venues and pool edges, with additional fee-tier, liquidity, route identity and real-venue fork checks; simply adding hops does not create price dislocations.

## Deployment safety

Do not deploy a new branch before its exact SHA passes GitHub CI and independent review. Do not change the NEXORA dashboard, contract permissions or live flags. On the current server, continue `SCAN_ONLY`, `LIVE_EXECUTION=false`, `MULTIHOP_EXECUTION_ENABLED=false`. No signer needs to be configured. This feature does not route or execute funded trades.
