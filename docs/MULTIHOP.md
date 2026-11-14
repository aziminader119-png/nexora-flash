# Cyclic multi-hop arbitrage observation

NEXORA can now **observe** closed on-chain conversion routes with **5–10 swaps** in a single chain, for example:

`USDC → WETH → DAI → cbBTC → USDT → USDC`

Every edge is an explicit token pair and DEX router/quoter, evaluated against the real on-chain quote at one block. The scanner sums lender fees, a per-swap gas estimate and L2 data-gas estimate. Results are labeled `MULTIHOP_OBSERVE_ONLY`, and **executable is always false**. No wallet or transaction needed.

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

- Quotes are capped at 80 requests **per network per scan** by default; 100 candidate cycles, 150 directed edges and 10 hops maximum. A cap hit is reported as `multiHopTruncated=true`.
- Cycles cannot revisit an intermediate token or reuse the same pool.
- Search runs only for explicitly catalogued networks. It never promotes a new token or router to the on-chain allowlist.
- Quotes are *not* executable: the current `NexoraFlashExecutor` has `MAX_LEGS=4` and `buildPlan()` also limits legs to four. Both need carefully validated upgrades, new fork tests and a separate security review for any funded 5–10-hop execution.
- More swaps imply more gas, more slippage and more stale-quote exposure. A quoted positive net is not executable profit; the route would need two simulations of the final calldata and exact gas estimates before any authorized execution.
- The catalog should contain real **connected** token paths with verified liquidity and token decimals. Avoid fee-on-transfer and rebasing tokens. Creating a catalog does not make it safe for execution.
