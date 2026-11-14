# NEXORA Flash — Scan-only server acceptance

This checklist is for an isolated pilot on a new server. It does **not** approve funded execution.

## Before installation

- Install on a dedicated Ubuntu 24.04 host, not a shared trading bot server.
- Check out the exact reviewed and CI-passing commit; never deploy an unreviewed moving branch.
- Keep the dashboard listening at `127.0.0.1:3080`. Reach it through an SSH tunnel instead of publishing the port.
- Generate a new admin token on the server. Never store it in GitHub or upload `/etc/nexora/nexora.env`.
- Do not copy any owner private keys or operator signer into the scan-only instance.
- Review the RPC URLs and any multi-hop token/venue catalog for accuracy and privacy.

## Host hardening (before install)

```bash
sudo apt-get update && sudo apt-get -y upgrade
sudo apt-get install -y unattended-upgrades ufw
sudo ufw default deny incoming && sudo ufw default allow outgoing
# Confirm the actual SSH port before enabling UFW; keep console access for recovery.
sudo ufw allow OpenSSH
sudo ufw --force enable
```

Configure SSH keys and disable password authentication only after confirming key-based login works. Do not expose port 3080.

## Install

```bash
git clone https://github.com/aziminader119-png/nexora-flash.git
cd nexora-flash
git fetch origin
git checkout <EXACT_REVIEWED_COMMIT_SHA>
sudo bash install-ubuntu.sh
```

The installer manages the `nexora` service and persists environment configuration under `/etc/nexora/nexora.env`. Review the existing `docs/OPERATIONS.md` before changing it.

## Mandatory environment controls

```ini
LIVE_EXECUTION=false
MULTIHOP_EXECUTION_ENABLED=false
MULTIHOP_EXECUTION_CHAINS=
BIND_HOST=127.0.0.1
```

Do not populate an operator keystore, unpause a deployed executor, or set `autoExecute=true` for this pilot. Set `MULTIHOP_CATALOG_FILE` only to a reviewed configuration that references real, correctly deployed token/pool contracts. Without a valid connected catalog, 5–10-hop scanner results will correctly be empty.

## Acceptance — scan without transactions

```bash
sudo systemctl status nexora --no-pager
curl --fail http://127.0.0.1:3080/api/health
curl --fail http://127.0.0.1:3080/api/status
sudo journalctl -u nexora -n 100 --no-pager
```

Verify the status reports `liveExecutionEnabled: false`, `longRouteExecutionOptIn: false`, no active signer, and no newly submitted trades. Confirm chain IDs, quote blocks, RPC latency, gas quote, route blockers and quote-budget truncation. A positive quoted profit is not realized profit.

## Rollback

```bash
sudo systemctl stop nexora
cd nexora-flash && git fetch origin && git checkout <PREVIOUS_REVIEWED_COMMIT_SHA>
sudo bash install-ubuntu.sh
curl --fail http://127.0.0.1:3080/api/status
```

Keep the journal and logs for diagnostics. Roll back only to a reviewed commit; do not delete or reinterpret outstanding nonce state if any execution history exists. Change environment configuration only with an operator-controlled approval.

## Production blockers

A scan-only pilot is **not** equivalent to real-money deployment. 5–10-hop funded execution requires genuine production-venue tests on a recent fork for each chain, a complete green validation report tied to the exact runtime bytecode, independent code audit, per-route cold-owner approval, explicit limits, and separate user authorization. Mock-only fork tests must never satisfy `test_multihop_realVenues_roundTrip`.
