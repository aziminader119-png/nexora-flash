# NEXORA Flash v1.2 — Backend scan observability

**Purpose:** Read-only analysis of real quoted 5–10-hop arbitrage cycles, independently of the legacy dashboard's 100-item limit. This is for a dedicated SCAN_ONLY server. No user-interface files, smart-contract methods, transaction signing, or risk thresholds are modified.

## Read-only API (localhost-only by default)

```sh
curl -s http://127.0.0.1:3080/api/multihop/stats | jq .
curl -s 'http://127.0.0.1:3080/api/multihop/cycles?chainId=8453&limit=50&offset=0' | jq .
curl -s 'http://127.0.0.1:3080/api/multihop/cycles?positiveOnly=true&minHops=5&maxHops=10' | jq .
curl -s 'http://127.0.0.1:3080/api/multihop/history?chainId=8453&limit=100' | jq .
```

- `/api/multihop/cycles`: returns the latest complete observed 5–10-hop cycle list per network, up to 100 scanner candidates *per network*; routes are sorted by net estimate. Supports `chainId`, `limit` (1–200), `offset` (0–10000), `minHops` and `maxHops` (5–10), and `positiveOnly=true`. **These results are observational, NOT an execution order book.**
- `/api/multihop/stats`: per-network quote counts, cycle counts, positive indicative net estimates, above-minimum indicative quotes, missing flash providers, unvalidated venues, scan truncation and error information.
- `/api/multihop/history`: bounded chronological scan aggregates, with paging and optional chain ID. Entries are appended to `DATA_DIR/route-scan-history.jsonl` (owner-controlled file, mode 0600). Full token routes are not written to historical logs.
- `/api/status`: existing dashboard-compatible payload remains unchanged. Up to 100 selected top-level opportunities are still returned for the legacy UI. Its `opportunities` count is **not** an exhaustive multi-hop count.

## Accounting limitations and safety

- `profitableQuotes` means *positive quoted estimated net*, not verified funded profit; slippage, liquidity, RPC failures and a missing lender can invalidate apparent profit. Check the candidate's `provider`, `executable`, `blockers`, `gasCost`, `flashFee`, `netEstimate`, quote block and freshness.
- If a network is not scanned or a quote has an error, corresponding cycle results may be absent or stale until the next successful scan. Review `/api/multihop/stats` and `/api/status` before interpreting individual routes.
- Data are kept in bounded memory; history is limited to 50,000 entries and a 32 MiB log file (rotated at the cap). The last 32 MiB of current history are reloaded on restart; a torn final line is ignored. Never share this scan log as proof of execution.
- A network without `MULTIHOP_CATALOG_FILE` (or disconnected catalog edges) correctly reports zero multi-hop cycles.
- Provider eligibility remains tied to the existing validation gate. Neither this API nor scan history changes `LIVE_EXECUTION=false`, `MULTIHOP_EXECUTION_ENABLED=false`, network fork validation or cold-owner approvals.

## Deploy: preserve live scanner and configuration

1. Merge and audit PR #11 → #12 → #13 → #14 → this v1.2 PR in order, or deploy this exact reviewed descendant commit.
2. Check **all CI jobs green** on exact SHA, including Node, Solidity, E2E and forks. `npm test` must include the observation tests.
3. Back up `/etc/nexora/nexora.env`, `/etc/nexora/multihop.json` and `/var/lib/nexora` (root only). Confirm `LIVE_EXECUTION=false` and `MULTIHOP_EXECUTION_ENABLED=false`, and no signer.
4. Check out the reviewed commit in a separate source directory. Run `sudo bash install-ubuntu.sh`. This installer copies backend lib/server files and preserves the private environment and data directory.
5. Use SSH forwarding to inspect the three new endpoints. Confirm that Base multi-hop cycles are accessible even when `/api/status` exposes zero multi-hop opportunities because of its older 100-item limit. Validate history after at least two successful scans.
6. Verify `systemctl status nexora`, no submitted trades, then observe RPC error rates and truncated scans before expanding to other networks.

**No funded trading approved.** Real-venue 5–10-hop fork execution tests are still missing, so long-route execution must stay locked. The new API is observational and must never be used to bypass the executor risk gates.
