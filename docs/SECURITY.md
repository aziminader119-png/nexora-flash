# NEXORA v1.0 — Security controls and threat model

Not audited by a third party. These controls are tested by `test/NexoraFlashExecutor.t.sol` (Solidity) and
`tests/*.test.mjs` (Node), as noted per row.

## On-chain (NexoraFlashExecutor)

| Threat | Control | Test |
|---|---|---|
| Hot key compromise drains funds | Operator can only `start()`/`pause()`. Profit goes to the owner-set `profitReceiver`. Limits, allow-lists, unpause and rescue are owner-only | `test_OperatorCannotAdminister` |
| Arbitrary call / malicious router | Only allow-listed routers/tokens/providers; no generic call data; approvals exact and reset to 0 | `test_RevertUnlistedProviderRouterToken`, `_assertClean` |
| Router lies about output | Output measured by balance delta; per-leg `minOut` | `test_RevertShortPayingRouter` |
| Forged flash-loan callback | Callback accepted only during `start()`, only from the lender `start()` called, only for that lender's kind, once, with `keccak(params) == planHash` | `test_CallbackOutsideExecutionRejected`, `test_TamperedParamsRejected` |
| Reentrancy via router | status lock + lender authentication | `test_ReentrantRouterRejected` |
| Lender fee change | `fee <= plan.maxFee` | `test_RevertLenderFeeAboveLimit` |
| Unprofitable or stale execution | `balance >= before + amount + fee + minProfit` with `minProfit > 0`; deadline | `test_RevertUnprofitable…`, `test_RevertExpired`, fuzz |
| Oversized loan | per-asset `maxLoan` (owner) | `test_RevertLoanLimit` |
| Pre-existing funds swept as "profit" | profit = balance delta measured around the loan | `test_PreexistingBalanceIsNotCountedAsProfit` |
| Wrong Euler vault | `vault.asset() == plan.asset` | `test_EulerAssetMismatchRejected` |
| Fresh deployment executes before review | deployed paused; only the owner can unpause | `test_DeployedPaused` |

Not supported, and must never be allow-listed: fee-on-transfer, rebasing and ERC-777 tokens.

## Off-chain

| Threat | Control | Test |
|---|---|---|
| Fake or optimistic profit | Profit is never asserted off-chain. The contract enforces a floor = min net + 1.2 × worst-case gas (incl. L1 fee) at max fee price. Realized profit is read from the `Executed` event | engine full-path test |
| Quote drift | Freshness by block and time. Simulation must match the quote within the slippage tolerance. Second simulation with final calldata | `market moved…`, `quote/simulation mismatch…`, `stale quote…` |
| Gas griefing / runaway spend | gas price ceiling, gas-unit cap, per-tx USD cap, daily budget (reservations count until receipts settle), circuit breaker | `gas limit, per-tx…`, `circuit breaker…` |
| Double spend / nonce bugs | fsync'd journal; one in-flight tx per chain; nonce from chain; restart reconciles; rebroadcast; same-nonce cancel | `pending … restart`, `stuck…`, `dropped…` |
| RPC outage | timeouts; nothing is signed unless every read succeeds; receipt polling tolerates outages | `RPC failure…` |
| Untested code goes live | validation gate bound to the on-chain codehash and per-network/provider fork tests | `gate:` tests, `locked when…` tests |
| Key leakage | encrypted keystore, password via systemd credential; env private keys refused; keys never in the dashboard/API; 0600 checks | `signer:` tests |
| Dashboard abuse | bound to 127.0.0.1; ≥24-char admin token compared in constant time; strict settings schema (unknown keys rejected); CSP, nosniff, frame-deny; output HTML-escaped | `server:`, `settings:`, `dashboard:` tests |
| Host compromise blast radius | systemd sandbox (ProtectSystem=strict, NoNewPrivileges, empty capability set, syscall filter); code is root-owned and read-only | installer test |

## Residual risks (accepted or open)

* **MEV / front-running.** BNB Chain has a public mempool and transactions go through the configured RPC. A
  competitor can copy or front-run. The on-chain floor turns that into a reverted transaction (gas lost), not a loss
  of principal. Private submission (for example a builder RPC) is not implemented. Configure a private RPC endpoint.
* **Protocol risk.** Lenders and DEXes are external. Balancer V2 suffered a major exploit in November 2025, so its
  vault liquidity and flash-loan path must be confirmed by the fork test at a recent block before use.
* **No third-party audit.** Treat v1.0 as unaudited code with a small, capped loan size.
