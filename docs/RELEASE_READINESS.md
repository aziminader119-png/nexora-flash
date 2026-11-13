# NEXORA release readiness — Scan Only

Snapshot: 2026-11-14, baseline commit `a72577d2267a857fce748b59d4fc011355823afb`.

## Completed and verified
- GitHub Actions full CI on main: https://github.com/aziminader119-png/nexora-flash/actions/runs/43528679171 — **success**.
- 63 Node tests, 31 Solidity unit/security tests, five mainnet-fork test suites, local E2E, Base fork E2E, and full validation gate passed.
- Read-only real market snapshot: https://github.com/aziminader119-png/nexora-flash/actions/runs/43525194826 — five networks quoted successfully; 260 routes, zero routes above minimum net profit in that snapshot. No real transactions.
- Scanner refuses unvalidated lenders and retains high-gas quotes as non-executable.
- Ambiguous nonce/broadcast RPC failure retains pending journal state; no same-nonce speculative second trade.
- `LIVE_EXECUTION=false` in the documented default. No user wallet/owner keys in the repository.

## NOT yet verified / external dependencies
- Dedicated user VPS: new IP and host access have not been supplied. **No deployment or 72-hour on-host soak has taken place.**
- An independent third-party security audit **has not occurred**. CI and author-led review are not an independent audit.
- No real-funds end-to-end mainnet execution has been performed or authorized. Do not infer real-world profitability from fork tests with deliberately manipulated pools.
- No evidence of sustainable arbitrage profits: the latest observed live market snapshot had no eligible profitable route.
- Owner cold-wallet signing, deployed contracts, allow-lists, RPC reliability, native gas funding, and incident response must be configured and verified before any live activation. This release does not authorize that activation.

## Scan-only server acceptance gates
1. Confirm **NEW dedicated NEXORA VPS** IP and Ubuntu 24.04; do not touch old multi-project VPS instances.
2. Provision with `LIVE_EXECUTION=false`, localhost-only dashboard, no operator wallet loaded, private permissions, and a systemd service. Never paste passwords, private keys or seed phrases in chat or GitHub.
3. Verify `/api/health`, `/api/status`, dashboard access through SSH tunnel, journal persistence, and restart recovery.
4. Run `node scripts/observe-market.mjs --minutes 4320 --interval 30` on the server for 72 h (read-only; preferably supervised through systemd/tmux). Collect the generated JSONL/Markdown reports.
5. Analyze success rate, stalled scan cycles, all-chain availability, latency, high-gas blockers, candidate count, and quote-to-simulation accuracy where an executor and operator sender exist. Zero opportunities is a valid finding.
6. Keep `LIVE_EXECUTION=false` throughout the soak. Require separate owner approval, independent security audit, and a risk-controlled rollout before funding/execution.

## Official operating instructions
- [docs/OPERATIONS.md](OPERATIONS.md)
- [docs/SECURITY.md](SECURITY.md)
- [docs/NETWORKS.md](NETWORKS.md)
