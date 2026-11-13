# NEXORA v1.0 — Operations runbook (Ubuntu 24.04)

Funded execution needs all of the following. Each is enforced in code, not just written down here.

| # | Gate | Enforced by |
|---|---|---|
| 1 | `LIVE_EXECUTION=true` in `/etc/nexora/nexora.env` | `Executor.liveBlockers` |
| 2 | `validation/gate-report.json` < 14 days old; node-unit, forge-build, forge-unit and e2e-local all exit 0 | `globalGateBlockers` |
| 3 | On-chain executor codehash == codehash of the validated build | `networkGateBlockers` |
| 4 | Fork round-trip **and** fork revert test passed for that network **and** that flash provider | `networkGateBlockers` |
| 5 | Signer == contract `operator`; contract unpaused; provider/routers/tokens allow-listed; on-chain cap ≥ loan | engine pre-checks |
| 6 | Network in dashboard `liveChains`; `autoExecute` on (for unattended mode) | settings |
| 7 | Venue is fork-validated (`forkValidated: true` in `lib/networks.mjs`) | scanner `executable` flag |

## 1. Install

```bash
git clone <repo> nexora && cd nexora
sudo bash install-ubuntu.sh --with-foundry
```
This installs Node 22 (SHA-256 verified), optionally Foundry, a `nexora` system user, `/opt/nexora` (read-only code),
`/var/lib/nexora` (data, 0700), `/etc/nexora/nexora.env` (0640, random `ADMIN_TOKEN`) and a hardened systemd unit.
The service starts in scan-only mode.

Dashboard: `ssh -L 3080:127.0.0.1:3080 user@server`, then open http://127.0.0.1:3080. The admin token is in
`/etc/nexora/nexora.env`.

## 2. Validate (on the server or in CI)

```bash
export BASE_RPC_URL=... BSC_RPC_URL=... ARBITRUM_RPC_URL=... OPTIMISM_RPC_URL=... POLYGON_RPC_URL=...
npm install && npm run validate:full
sudo install -m 0644 validation/gate-report.json /opt/nexora/validation/gate-report.json
```
Use archive-capable private RPCs. Public endpoints often rate-limit fork tests. You can also take the
`nexora-gate-report` artifact from a green CI run. Read `validation/validation-log.md` and the fork matrix: a provider
whose round-trip test failed (for example, no liquidity at the fork block) stays locked on that network.

## 3. Owner key and deployment

The **owner** is a cold wallet. It sets allow-lists and caps, chooses the profit receiver, unpauses and rescues.
The **operator** is the bot's hot key. It can only call `start()` and `pause()`.

```bash
sudo node /opt/nexora/scripts/create-operator-key.mjs \
  --out /var/lib/nexora/keys/operator.json --password-file /etc/nexora/keys/keystore-password
sudo chown nexora:nexora /var/lib/nexora/keys/operator.json
# deploy from an admin workstation that holds the owner keystore (and the forge build output)
DEPLOYER_KEYSTORE=~/owner.json RPC_8453=https://... node scripts/deploy.mjs --chain 8453 --operator 0xOPERATOR --receiver 0xTREASURY --max-loan 1000
```
`deploy.mjs` checks that every configured address has code, deploys the contract **paused**, verifies that the runtime
code matches the build artifact, allow-lists the providers and fork-validated venues, and sets the on-chain cap
(1,000 stable units by default). Put `EXECUTOR_<chainId>=0x...` in `/etc/nexora/nexora.env`, then re-run the
installer so it picks up the signer credential.

Fund the operator with a small amount of native gas only. Profit never accumulates in the operator wallet.

## 4. Preflight and enable

```bash
cd /opt/nexora && sudo EXECUTOR_KEYSTORE_PASSWORD_FILE=/etc/nexora/keys/keystore-password \
  node --env-file=/etc/nexora/nexora.env scripts/preflight.mjs
```
Every live network must show PASS. Then:
1. Unpause each executor from the owner wallet (`unpause()`).
2. Set `LIVE_EXECUTION=true` and run `sudo systemctl restart nexora`.
3. In the dashboard Settings tab, pick the live networks, keep the $1,000 maximum, then switch on automatic execution.

Start with one network, a small daily gas budget and a high minimum profit. Watch the Trades tab and the
`/var/lib/nexora/*.jsonl` files.

## Daily operations

* **Emergency stop**: the dashboard button, or `curl -XPOST -H "x-admin-token: $T" 127.0.0.1:3080/api/emergency-stop`.
  It pauses locally and sends `pause()` on-chain. To resume, use the dashboard *Resume* button, plus the owner's `unpause()` if the contract was paused.
* **Circuit breaker**: after `maxConsecutiveFailures` failed executions the service pauses itself. Investigate, then Resume.
* **Restarts**: `systemctl restart nexora` is safe. Pending transactions are reconciled from the journal before anything new is sent.
* **Logs**: `/var/lib/nexora/nexora.log.jsonl` (rotates at 10 MB), `/var/lib/nexora/execution-journal.jsonl` (append-only, fsync'd), `journalctl -u nexora`.
* **Raising the loan size**: change the dashboard maximum (bounded by `NEXORA_LOAN_CEILING`) **and** the owner's `setMaxLoan` on-chain.
* **Re-validate** after any code, compiler or network-config change. The codehash gate blocks a contract that was redeployed without re-validation.
