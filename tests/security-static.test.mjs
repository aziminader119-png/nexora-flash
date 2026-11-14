import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {loadSigner} from '../lib/keys.mjs';

const read = (p) => fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

test('signer: no key configured => scan-only (null signer)', async () => assert.equal(await loadSigner({}), null));
test('signer: raw private key in environment refused by default', async () => {
  await assert.rejects(loadSigner({EXECUTOR_PRIVATE_KEY: '0x' + '1'.repeat(64)}), /refused/);
});
test('signer: world-readable key file refused', async () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'k-')), 'key');
  fs.writeFileSync(f, '0x' + '1'.repeat(64), {mode: 0o644});
  fs.chmodSync(f, 0o644);
  await assert.rejects(loadSigner({EXECUTOR_KEY_FILE: f}), /chmod 600/);
});
test('signer: malformed key file refused', async () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'k-')), 'key');
  fs.writeFileSync(f, 'not-a-key', {mode: 0o600});
  await assert.rejects(loadSigner({EXECUTOR_KEY_FILE: f}), /32-byte hex/);
});

test('server: no secrets in status, constant-time admin check, CSP, live flag strict', () => {
  const s = read('server.js');
  assert.doesNotMatch(s, /EXECUTOR_PRIVATE_KEY|signer\.key|privateKey/);
  assert.match(s, /timingSafeEqual/);
  assert.match(s, /Content-Security-Policy/);
  assert.match(s, /env\.LIVE_EXECUTION === 'true'/);
  assert.match(s, /BIND_HOST \|\| '127\.0\.0\.1'/);
  assert.match(s, /executor\.reconcile/, 'recovery runs every cycle');
});

test('dashboard: single page with Opportunities, Trades, Logs, Settings and emergency stop', () => {
  const h = read('public/index.html');
  for (const v of ['opps-view', 'trades-view', 'logsv-view', 'settings-view']) assert.ok(h.includes(`id="${v}"`), v);
  for (const id of ['maxLoanUSD', 'loanSize', 'stop', 'resume', 'liveChains', 'token']) assert.ok(h.includes(`id="${id}"`), id);
  assert.ok((h.match(/esc\(/g) || []).length >= 25, 'dynamic values are HTML-escaped');
  assert.doesNotMatch(h, /localStorage|sessionStorage/, 'admin token never persisted');
});

test('env template: live execution off, no secrets', () => {
  const env = read('.env.example');
  assert.match(env, /^LIVE_EXECUTION=false$/m);
  assert.doesNotMatch(env, /^EXECUTOR_PRIVATE_KEY=0x/m);
  assert.doesNotMatch(env, /0x[0-9a-fA-F]{64}/);
  assert.doesNotMatch(env, /^[A-Z_0-9]+=[^\n]*#/m, 'systemd EnvironmentFile does not support inline comments');
});

test('installer: copies runtime, hardened unit, keystore via LoadCredential', () => {
  const i = read('install-ubuntu.sh');
  for (const p of ['server.js', 'lib', 'public', 'package.json']) assert.ok(i.includes(`"$SRC/${p}"`), p);
  assert.match(i, /LoadCredential=keystore-password/);
  assert.match(i, /NoNewPrivileges=true/);
  assert.match(i, /ProtectSystem=strict/);
  assert.match(i, /--omit=dev/);
});

test('contract: critical protections present in source', () => {
  const c = read('contracts/NexoraFlashExecutor.sol');
  for (const s of ['bool public paused = true', 'require(msg.sender == activeProvider', 'require(keccak256(data) == activePlanHash', 'require(fee <= p.maxFee', '"insufficient profit"', 'onlyOperator', 'function unpause() external onlyOwner'])
    assert.ok(c.includes(s), s);
});


test('nonce safety: every JsonRpcProvider disables the ethers request cache', () => {
  for (const f of ['lib/chain-ethers.mjs', 'scripts/e2e-anvil.mjs', 'scripts/deploy.mjs']) {
    const src = read(f);
    const ctors = src.match(/new JsonRpcProvider\([^)]*\)/g) || [];
    assert.ok(ctors.length > 0, f);
    for (const c of ctors) assert.match(c, /cacheTimeout: -1/, `${f}: ${c}`);
  }
  const e2e = read('scripts/e2e-anvil.mjs');
  assert.doesNotMatch(e2e, /for \(const \w+ of \[exe\.\w+\(/);
});

import {hostAllowed} from '../lib/http-guard.mjs';
test('AUDIT M-1: local dashboard rejects DNS rebinding hosts', () => {
  for (const h of ['localhost:3080', '127.0.0.1:3080', 'LOCALHOST', '[::1]:3080']) assert.equal(hostAllowed(h, {}), true, h);
  for (const h of ['attacker.example:3080', '127.0.0.1.attacker.example', '', undefined, 'localhost:3080@evil', 'local host']) assert.equal(hostAllowed(h, {}), false, String(h));
  assert.equal(hostAllowed('nexora.internal:3080', {DASHBOARD_HOSTS: 'nexora.internal'}), true);
  assert.match(read('server.js'), /if \(!hostAllowed\(req\.headers\.host\)\)/);
});

import {MULTIHOP_FORK_GATE_TEST} from '../lib/networks.mjs';
test('AUDIT H-1: mock-venue fork tests are not accepted as long-route execution gates', () => {
  const files = ['test/fork/ForkArbBase.sol', 'test/fork/ForkNetworks.t.sol'];
  for (const file of files) {
    const source = read(file);
    const pos = source.indexOf(`function ${MULTIHOP_FORK_GATE_TEST}(`);
    if (pos < 0) continue;
    let depth = 0, start = source.indexOf('{', pos), end = start;
    for (; end < source.length; end++) {
      if (source[end] === '{') depth++;
      else if (source[end] === '}' && --depth === 0) break;
    }
    const body = source.slice(pos, end + 1);
    assert.doesNotMatch(body, /Mock|_longRouteRoundTrip|new [A-Z]\\w*Router/, `${file}: real-venue gate cannot use mocks`);
  }
  assert.doesNotMatch(read('test/fork/ForkArbBase.sol'), /function test_multihop_roundTrip\\(/);
  for (const file of ['lib/engine.mjs','server.js']) assert.match(read(file), /MULTIHOP_FORK_GATE_TEST/);
});
