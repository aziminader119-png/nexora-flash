# Cyclic 5–10 hop arbitrage: scanner and guarded executor

NEXORA can now **observe** closed on-chain conversion routes with **5–10 swaps** in a single chain, for example:

`USDC → WETH → DAI → cbBTC → USDT → USDC`

Every edge is an explicit token pair and DEX router/quoter, quoted at one block. The scanner estimates lender fees, per-swap gas, and L2 data-gas. By default all long-cycle opportunities are `MULTIHOP_OBSERVE_ONLY`; no wallet is necessary. An independently guarded Solidity executor supports up to ten atomic swaps, but execution is disabled until all explicit gates pass.

## Activation (read-only)

1. Prepare a private JSON configuration on the server, e.g. `/etc/nexora/multihop.json`. The file format is:
```json
{
  "schema": 1,
  "chains": {
    "8453": [
      {
        "pool": {
          "key": "unique-pool-id",
          "name": "Verified DEX pool",
          "type": "v3",
          "router": "0x0123456789abcdef0123456789abcdef01234567",
          "routerKind": 2,
          "quoter": "0x0123456789abcdef0123456789abcdef01234568",
          "fee": 500,
          "forkValidated": false
        },
        "tokenIn": {"address": "0x0123456789abcdef0123456789abcdef01234569", "symbol": "TOKEN_A"},
        "tokenOut": {"address": "0x0123456789abcdef0123456789abcdef01234560", "symbol": "TOKEN_B"}
      }
    ]
  }
}
```
   **All addresses above are fictional formatting examples, not real contracts.** Replace them with verified token and router/quoter addresses, and include a complete, directed route that ends in the network's existing stablecoin. Each pool entry can be added in both directions, with a unique key for the liquidity pool to prevent reusing the same pool in a single route.
2. Set `MULTIHOP_CATALOG_FILE=/etc/nexora/multihop.json` in the private server environment and restart the service. With the variable absent, legacy two-hop scanning is unaffected.
3. Inspect multi-hop observations in Opportunities, marked `MULTIHOP_OBSERVE_ONLY`, and check per-network `multiHopQuotes`, `multiHopCycles`, `multiHopTruncated` and `multiHopError` in `/api/status`.

## Operational limits

- Quotes are capped at 80 requests **per network per scan** by default; 100 candidate cycles, 150 directed edges and 10 hops maximum. A cap hit is reported as `multiHopTruncated=true`. The scanner now eliminates graph branches that cannot return to the base asset within the remaining hop limit before consuming quotes. It rotates the first-hop priority by block number, improving coverage across repeated scans without increasing the quote budget.
- Cycles cannot revisit an intermediate token or reuse the same pool.
- Search runs only for explicitly catalogued networks. It never promotes a new token or router to the on-chain allowlist.
- The upgraded `NexoraFlashExecutor` supports a maximum of 10 legs, but `maxRouteLegs` defaults to **4**. Only the cold owner can raise that cap. This changes deployed bytecode: use a newly validated deployment with a matching codehash gate report.
- The cold owner must separately approve the **route hash**: a chain-bound hash of the exact order of token addresses, router addresses, router kinds, and V3 fee tiers (excluding variable trade amount, deadline, and minimum outputs). Approvals can be revoked through the owner-only contract method.
- Long-cycle paths reject repeated intermediate tokens and reused pools; the off-chain engine enforces on-chain token/router allowlists, owner route approval, quote freshness, gas budget, flash fee, minimum net profit, actual `eth_estimateGas`, and two final `eth_call` simulations.
- For long routes, the configured slippage is a **whole-route budget**, split conservatively across swaps; it is not independently multiplied by every hop. Final minimum-profit protection remains enforced atomically.
- The environment opt-ins `MULTIHOP_EXECUTION_ENABLED=false` and `MULTIHOP_EXECUTION_CHAINS=` both default OFF/empty. For any candidate to be considered executable, a fresh validation gate, the passing network `test_multihop_realVenues_roundTrip` and exact matching to trusted network routers/fee tiers are also required.
- **The fork's five/ten-hop mechanics tests use a REAL Aave lender but MOCK intermediate DEX venues** to verify atomic borrowing/repayment. These have been renamed so they cannot satisfy the genuine `test_multihop_realVenues_roundTrip` gate. This is not proof of live profitability or liquidity for a natural multi-token route. A route-specific fork with real production venues plus independent security review remains required before authorizing funded execution.
- The operator hot key must not be the owner wallet. Never enable funded execution solely on the basis of passing developer tests.
- More swaps imply more gas, more slippage and more stale-quote exposure. A quoted positive net is not executable profit; the route would need two simulations of the final calldata and exact gas estimates before any authorized execution.
- The catalog should contain real **connected** token paths with verified liquidity and token decimals. Avoid fee-on-transfer and rebasing tokens. Creating a catalog does not make it safe for execution.


## Deployment and security acceptance

Before any production long-route trading, independently validate the exact token contracts and real production DEX pools on a recent fork, audit contract and engine changes, verify receipt/reorg/replacement handling, and approve a limited per-chain rollout with a cold-owner route hash. Verify gas and L2 data fees, time-to-live, slippage, expected failure gas, and a small funded pilot only after explicit approval. `LIVE_EXECUTION=false` must remain until that later approval. Current tests are developer tests, not an independent third-party audit.

## Read-only contract authorization probe

After a **separate** deployment has been audited, an operator may check a proposed route without any signer or live transactions:

```bash
node scripts/check-long-route.mjs 8453 0xEXECUTOR_ADDRESS /path/to/candidate.json
```

The command prints contract version, owner, the chain-bound route hash, route-length cap, route approval, token/router allowlists and blockers. It uses only RPC reads. Do not share private keys. A passing probe does not replace fork route validation, gas/MEV analysis, security audit or a separate live-trading authorization.
