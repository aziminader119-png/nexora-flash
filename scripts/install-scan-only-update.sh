#!/usr/bin/env bash
# One-shot NEXORA backend update. Run only on its authorized Ubuntu server.
# Intentionally does NOT install packages, change firewall/DNS, write secrets,
# update runtime settings, or enable trading. Keeps public/ UI intact.
set -Eeuo pipefail
[[ "${EUID}" -eq 0 ]] || { echo "ERROR: run as root" >&2; exit 1; }
REPO=${NEXORA_SOURCE_DIR:-/root/nexora-flash}
DEST=/opt/nexora
ENV_FILE=/etc/nexora/nexora.env
SERVICE=nexora
BACKUPS=/root/nexora-backups
EXPECTED_COMMIT=${EXPECTED_COMMIT:?Set EXPECTED_COMMIT to reviewed SHA}
[[ "${EXPECTED_COMMIT}" =~ ^[0-9a-f]{40}$ ]] || { echo "ERROR: invalid commit" >&2; exit 1; }
cd "${REPO}"
[[ "$(git rev-parse HEAD)" == "${EXPECTED_COMMIT}" ]] || { echo "ERROR: wrong commit" >&2; exit 1; }
[[ -z "$(git status --porcelain)" ]] || { echo "ERROR: dirty source tree" >&2; exit 1; }
[[ -f "${DEST}/server.js" && -d "${DEST}/lib" && -f "${ENV_FILE}" ]] || {
 echo "ERROR: existing NEXORA install not found" >&2; exit 1;
}
grep -qx 'LIVE_EXECUTION=false' "${ENV_FILE}" || { echo "ERROR: LIVE must be disabled" >&2; exit 1; }
grep -qx 'MULTIHOP_EXECUTION_ENABLED=false' "${ENV_FILE}" || {
 echo "ERROR: multi-hop execution must be disabled" >&2; exit 1;
}
# Preserve existing persisted settings; refuse an unsafe auto-trade config.
if [[ -f /var/lib/nexora/settings.json ]]; then
  node --input-type=module -e '
    import fs from "node:fs";
    const s=JSON.parse(fs.readFileSync("/var/lib/nexora/settings.json","utf8"));
    if (s.autoExecute!==false || !Array.isArray(s.liveChains) || s.liveChains.length!==0)
      throw Error("Unsafe persisted trade settings");'
fi
node --check server.js
node --test tests/market-discovery.test.mjs tests/route-intelligence.test.mjs >/dev/null
install -d -m 700 "${BACKUPS}"
BACKUP="$(mktemp -d "${BACKUPS}/nexora-update-XXXXXXXX")"
chmod 700 "${BACKUP}"
cp -a "${DEST}/lib" "${DEST}/server.js" "${BACKUP}/"
echo "BACKUP=${BACKUP}"
stopped=0
rollback() {
  code=$?
  trap - ERR
  if [[ "${stopped}" -eq 1 ]]; then
    echo "UPDATE FAILED: restoring original backend" >&2
    rm -rf "${DEST}/lib"
    cp -a "${BACKUP}/lib" "${DEST}/lib"
    cp -a "${BACKUP}/server.js" "${DEST}/server.js"
    systemctl restart "${SERVICE}" || true
  fi
  exit "${code}"
}
trap rollback ERR
systemctl stop "${SERVICE}"
stopped=1
rm -rf "${DEST}/lib"
cp -a lib "${DEST}/lib"
install -m 644 server.js "${DEST}/server.js"
chown -R root:root "${DEST}/lib"
chmod -R a+rX "${DEST}/lib"
node --check "${DEST}/server.js"
runuser -u nexora -- node --input-type=module -e   "await import('/opt/nexora/lib/market-discovery.mjs'); await import('/opt/nexora/lib/route-intelligence.mjs')"
systemctl start "${SERVICE}"
sleep 5
systemctl is-active --quiet "${SERVICE}"
curl --fail --silent --show-error 'http://127.0.0.1:3080/api/status' |
  jq --exit-status '.mode=="SCAN_ONLY" and .liveExecutionEnabled==false and .longRouteExecutionOptIn==false and .settings.autoExecute==false and (.settings.liveChains|length)==0' >/dev/null
trap - ERR
echo "NEXORA_SCAN_ONLY_UPDATE_OK"
echo "BACKUP=${BACKUP}"
