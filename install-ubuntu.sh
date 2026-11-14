#!/usr/bin/env bash
# NEXORA v1.0 production installer for Ubuntu 24.04 LTS.
#   sudo bash install-ubuntu.sh                 # service + dashboard (LIVE_EXECUTION=false)
#   sudo bash install-ubuntu.sh --with-foundry  # also installs forge/anvil to run the validation gate on this host
# Re-running is safe: existing /etc/nexora/nexora.env, keys, settings and journals are preserved.
set -euo pipefail

WITH_FOUNDRY=0
for a in "$@"; do case "$a" in --with-foundry) WITH_FOUNDRY=1 ;; *) echo "unknown option $a" >&2; exit 2 ;; esac; done
[[ $(id -u) -eq 0 ]] || { echo "Run: sudo bash install-ubuntu.sh" >&2; exit 1; }
. /etc/os-release
[[ "${ID}" == "ubuntu" && "${VERSION_ID}" == "24.04" ]] || echo "WARNING: tested for Ubuntu 24.04; found ${PRETTY_NAME}" >&2

SRC=$(cd "$(dirname "$0")" && pwd)
APP=/opt/nexora
DATA=/var/lib/nexora
ETC=/etc/nexora

echo "==> System packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y --no-install-recommends ca-certificates curl xz-utils openssl jq git

echo "==> Node.js 22 LTS (official tarball, SHA-256 verified)"
NEED_NODE=1
if command -v node >/dev/null 2>&1; then
  M=$(node -p 'process.versions.node.split(".")[0]'); [[ "$M" -ge 22 ]] && NEED_NODE=0
  case "$(readlink -f "$(command -v node)")" in /home/*|/root/*|/snap/*) NEED_NODE=1 ;; esac
fi
if [[ $NEED_NODE -eq 1 ]]; then
  ARCH=$(dpkg --print-architecture); case "$ARCH" in amd64) NA=x64 ;; arm64) NA=arm64 ;; *) echo "unsupported arch $ARCH"; exit 1 ;; esac
  TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
  BASE=https://nodejs.org/dist/latest-v22.x
  curl -fsSL "$BASE/SHASUMS256.txt" -o "$TMP/SHASUMS256.txt"
  TARBALL=$(grep -oE "node-v22\.[0-9]+\.[0-9]+-linux-${NA}\.tar\.xz" "$TMP/SHASUMS256.txt" | head -1)
  curl -fsSL "$BASE/$TARBALL" -o "$TMP/$TARBALL"
  (cd "$TMP" && grep " $TARBALL\$" SHASUMS256.txt | sha256sum -c -)
  tar -xJf "$TMP/$TARBALL" -C /usr/local --strip-components=1
fi
NODE_BIN=$(readlink -f "$(command -v node)")
case "$NODE_BIN" in /home/*|/root/*|/snap/*) NODE_BIN=/usr/local/bin/node ;; esac
[[ -x "$NODE_BIN" ]] || { echo "Node.js executable not found" >&2; exit 1; }
node -v; npm -v

if [[ $WITH_FOUNDRY -eq 1 ]]; then
  echo "==> Foundry (forge/anvil) for on-host validation"
  export FOUNDRY_DIR=/opt/foundry
  mkdir -p "$FOUNDRY_DIR"
  curl -fsSL https://foundry.paradigm.xyz -o /tmp/foundryup-install.sh
  FOUNDRY_DIR=$FOUNDRY_DIR bash /tmp/foundryup-install.sh
  FOUNDRY_DIR=$FOUNDRY_DIR "$FOUNDRY_DIR/bin/foundryup"
  ln -sf "$FOUNDRY_DIR/bin/forge" /usr/local/bin/forge; ln -sf "$FOUNDRY_DIR/bin/anvil" /usr/local/bin/anvil; ln -sf "$FOUNDRY_DIR/bin/cast" /usr/local/bin/cast
  forge --version
fi

echo "==> Service user and directories"
id nexora >/dev/null 2>&1 || useradd --system --home "$DATA" --shell /usr/sbin/nologin nexora
install -d -m 0755 -o root -g root "$APP"
install -d -m 0700 -o nexora -g nexora "$DATA" "$DATA/keys"
install -d -m 0750 -o root -g nexora "$ETC"
install -d -m 0700 -o root -g root "$ETC/keys"

echo "==> Application files (root-owned, read-only for the service)"
rm -rf "$APP/lib" "$APP/public" "$APP/scripts"
cp -r "$SRC/server.js" "$SRC/lib" "$SRC/public" "$SRC/scripts" "$SRC/package.json" "$APP/"
[[ -f "$SRC/package-lock.json" ]] && cp "$SRC/package-lock.json" "$APP/"
install -d -m 0755 "$APP/validation"
[[ -f "$SRC/validation/gate-report.json" ]] && install -m 0644 "$SRC/validation/gate-report.json" "$APP/validation/gate-report.json"
cd "$APP"
if [[ -f package-lock.json ]]; then
  npm ci --omit=dev --ignore-scripts --no-audit --no-fund
else
  echo "WARNING: no package-lock.json; versions are not pinned" >&2
  npm install --omit=dev --ignore-scripts --no-audit --no-fund
fi
chown -R root:root "$APP"; chmod -R go-w "$APP"
# npm's file modes can inherit an operator's restrictive umask (e.g. 0077).
# Root can import ethers while the unprivileged systemd user cannot traverse
# node_modules/ethers/lib.esm, resulting in ERR_MODULE_NOT_FOUND. The app
# contains no secrets: private settings and keys live under /etc and /var/lib.
# Grant read+directory traversal, NOT write permissions, to the service.
chmod -R a+rX "$APP/lib" "$APP/public" "$APP/scripts" "$APP/node_modules"
chmod a+r "$APP/server.js" "$APP/package.json"
chmod a+rx "$APP"
# Fail at install time rather than leaving an endlessly restarting service.
runuser -u nexora -- "$NODE_BIN" --input-type=module -e \
  "await import('file://$APP/lib/chain-ethers.mjs'); await import('file://$APP/lib/route-diagnostics.mjs'); console.log('NEXORA_IMPORTS_OK')"

echo "==> Environment"
if [[ ! -f "$ETC/nexora.env" ]]; then
  TOKEN=$(openssl rand -hex 32)
  sed -e "s/^ADMIN_TOKEN=.*/ADMIN_TOKEN=${TOKEN}/" -e "s#^DATA_DIR=.*#DATA_DIR=${DATA}#" -e "s#^GATE_REPORT=.*#GATE_REPORT=${APP}/validation/gate-report.json#" "$SRC/.env.example" > "$ETC/nexora.env"
  chown root:nexora "$ETC/nexora.env"; chmod 0640 "$ETC/nexora.env"
  echo "Admin token generated in $ETC/nexora.env (kept private; not printed)."
fi

echo "==> systemd unit"
cat >/etc/systemd/system/nexora.service <<EOF
[Unit]
Description=NEXORA flash-loan arbitrage scanner/executor
After=network-online.target
Wants=network-online.target
StartLimitIntervalSec=300
StartLimitBurst=10

[Service]
Type=simple
User=nexora
Group=nexora
WorkingDirectory=$APP
EnvironmentFile=$ETC/nexora.env
Environment=NODE_ENV=production
ExecStart=$NODE_BIN $APP/server.js
Restart=always
RestartSec=5
TimeoutStopSec=45
KillSignal=SIGTERM
ReadWritePaths=$DATA
UMask=0077
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
PrivateDevices=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectKernelLogs=true
ProtectControlGroups=true
ProtectClock=true
ProtectHostname=true
RestrictNamespaces=true
RestrictRealtime=true
RestrictSUIDSGID=true
LockPersonality=true
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
SystemCallArchitectures=native
SystemCallFilter=@system-service
CapabilityBoundingSet=
AmbientCapabilities=

[Install]
WantedBy=multi-user.target
EOF

# The signer password is delivered only through systemd credentials, never via environment.
# Create keys with: sudo node $APP/scripts/create-operator-key.mjs (see README "Operator key").
install -d -m 0755 /etc/systemd/system/nexora.service.d
if [[ -f "$ETC/keys/keystore-password" ]]; then
  cat >/etc/systemd/system/nexora.service.d/signer.conf <<EOF
[Service]
LoadCredential=keystore-password:$ETC/keys/keystore-password
EOF
  grep -q '^EXECUTOR_KEYSTORE=' "$ETC/nexora.env" || echo "EXECUTOR_KEYSTORE=$DATA/keys/operator.json" >> "$ETC/nexora.env"
  echo "Signer credential configured."
else
  rm -f /etc/systemd/system/nexora.service.d/signer.conf
  echo "No operator key yet: service runs scan-only."
fi

systemctl daemon-reload
systemctl enable nexora >/dev/null
systemctl restart nexora
PORT_CFG=$(grep -E '^PORT=' "$ETC/nexora.env" | tail -1 | cut -d= -f2); PORT_CFG=${PORT_CFG:-3080}
HEALTHY=0
for _ in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:${PORT_CFG}/api/health" >/dev/null 2>&1; then HEALTHY=1; break; fi
  sleep 1
done
systemctl --no-pager --full status nexora | head -20 || true
[[ $HEALTHY -eq 1 ]] || { echo "ERROR: service did not become healthy; see journalctl -u nexora -n 100" >&2; exit 1; }
MODE=$(curl -fsS "http://127.0.0.1:${PORT_CFG}/api/status" | jq -r .mode)
echo "Service healthy; mode=${MODE}"
if grep -qE '^LIVE_EXECUTION=false$' "$ETC/nexora.env" && [[ "$MODE" != "SCAN_ONLY" ]]; then
  echo "ERROR: LIVE_EXECUTION=false but service reports mode ${MODE}" >&2
  exit 1
fi

cat <<EOF

NEXORA installed. LIVE_EXECUTION=false (scan-only) until you complete docs/OPERATIONS.md:
  1. npm run validate:full   (on a host with forge/anvil + RPCs) -> validation/gate-report.json
  2. deploy executor (scripts/deploy.mjs), set EXECUTOR_<chainId> in $ETC/nexora.env
  3. create operator key, re-run this installer, fund operator with gas only
  4. npm run preflight, then set LIVE_EXECUTION=true and choose live networks in the dashboard
Dashboard (local only): ssh -L 3080:127.0.0.1:3080 USER@SERVER  ->  http://127.0.0.1:3080
EOF
