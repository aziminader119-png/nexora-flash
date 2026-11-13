import test from 'node:test';
import assert from 'node:assert/strict';
import {parseUnits, formatUnits, toFloat} from '../lib/units.mjs';
import {DEFAULT_SETTINGS, INITIAL_MAX_LOAN, validateSettings, applySettingsUpdate, loadSettings, settingsErrors} from '../lib/settings.mjs';
import {NETWORKS, withEnvProviders, broadcastUrl} from '../lib/networks.mjs';
import {aavePremium, balancerFee, selectProvider, protectedFloorUnits, netProfitUnits, weiToStable, routeGasUnits} from '../lib/profit.mjs';

test('units: exact parse/format round trip', () => {
  assert.equal(parseUnits('1000', 6), 1000_000000n);
  assert.equal(parseUnits('0.000001', 6), 1n);
  assert.equal(parseUnits(1234.5, 18), 1234_500000000000000000n);
  assert.equal(formatUnits(1_500000n, 6), '1.5');
  assert.equal(formatUnits(-25n, 2), '-0.25');
  assert.equal(toFloat(9_500000n, 6), 9.5);
  assert.throws(() => parseUnits('0.0000001', 6), /decimal places/);
  assert.throws(() => parseUnits('-1', 6), /Invalid/);
  assert.throws(() => parseUnits('1e3', 6), /Invalid/);
});

test('settings: defaults valid and initial max loan is $1,000', () => {
  assert.equal(INITIAL_MAX_LOAN, 1000);
  assert.equal(DEFAULT_SETTINGS.maxLoanUSD, 1000);
  assert.equal(validateSettings(structuredClone(DEFAULT_SETTINGS), {}), true);
  assert.deepEqual(DEFAULT_SETTINGS.liveChains, [], 'no network is live by default');
  assert.equal(DEFAULT_SETTINGS.autoExecute, false);
});

test('settings: dashboard can raise max loan up to the server ceiling only', () => {
  const env = {NEXORA_LOAN_CEILING: '5000'};
  const next = applySettingsUpdate(structuredClone(DEFAULT_SETTINGS), {maxLoanUSD: 5000, loanSize: 2500}, env);
  assert.equal(next.maxLoanUSD, 5000);
  assert.throws(() => applySettingsUpdate(structuredClone(DEFAULT_SETTINGS), {maxLoanUSD: 5001}, env), /maxLoanUSD/);
  assert.throws(() => applySettingsUpdate(structuredClone(DEFAULT_SETTINGS), {loanSize: 1500}, env), /loanSize/);
});

test('settings: unknown keys (e.g. pasted private key) rejected', () => {
  assert.throws(() => applySettingsUpdate(structuredClone(DEFAULT_SETTINGS), {privateKey: '0xabc'}), /Unknown setting/);
});

test('settings: live chains must be a subset of scanned chains', () => {
  const e = settingsErrors({...structuredClone(DEFAULT_SETTINGS), enabledChains: [56], liveChains: [8453]}, {});
  assert.ok(e.some((x) => /liveChains/.test(x)));
});

test('settings: v0.9 file migrates safely', () => {
  const s = loadSettings({loanSize: 1000, maxGasGwei: 5, minProfitUSD: 3, maxDailyGasUSD: 5, enabledChains: [56, 8453, 43114], paused: false, walletAddress: '0x1'}, {});
  assert.deepEqual(s.enabledChains, [56, 8453]);
  assert.equal('walletAddress' in s, false);
  assert.deepEqual(loadSettings({loanSize: 'x'}, {}), structuredClone(DEFAULT_SETTINGS));
});

test('profit: Aave premium conservatively rounds upward', () => {
  assert.equal(aavePremium(1000_000000n, 5), 500000n);
  assert.equal(aavePremium(12942639n, 5), 6472n); // verified on Polygon fork
  assert.equal(aavePremium(1n, 5000), 1n); // fractional premium rounds up
  assert.equal(aavePremium(1n, 4999), 1n);
});

test('profit: Balancer fee matches FixedPoint.mulUp', () => {
  assert.equal(balancerFee(1000_000000n, 0n), 0n);
  assert.equal(balancerFee(1000_000000n, 10n ** 14n), 100000n); // 0.01%
  assert.equal(balancerFee(3n, 10n ** 17n), 1n); // 0.3 rounds up
});

test('provider selection: cheapest healthy provider with liquidity, ties to lower gas', () => {
  const infos = [
    {kind: 'AAVE_V3', address: 'a', ok: true, available: 10n ** 12n, feeModel: 'aave-bps', feeParam: 5},
    {kind: 'MORPHO_BLUE', address: 'm', ok: true, available: 10n ** 12n, feeModel: 'zero', feeParam: 0},
    {kind: 'BALANCER_V2', address: 'b', ok: true, available: 10n ** 12n, feeModel: 'balancer-wad', feeParam: 0n},
  ];
  const r = selectProvider(infos, 1000_000000n);
  assert.equal(r.best.kind, 'MORPHO_BLUE', 'zero fee and lowest gas');
  const noMorpho = selectProvider([infos[0], {...infos[1], available: 1n}], 1000_000000n);
  assert.equal(noMorpho.best.kind, 'AAVE_V3', 'illiquid provider skipped');
  assert.equal(noMorpho.rejected[0].reason, 'insufficient liquidity');
  assert.equal(selectProvider([{kind: 'AAVE_V3', ok: false, error: 'reserve paused'}], 1n).best, null);
});

test('profit: net arithmetic and protected on-chain floor', () => {
  const p = netProfitUnits({amount: 1000_000000n, outUnits: 1016_000000n, fee: 500000n, gasStable: 1_000000n});
  assert.equal(p.net, 14_500000n);
  assert.equal(protectedFloorUnits({minNetUnits: 3_000000n, gasStableUnits: 1_000000n}), 4_200000n);
  assert.throws(() => protectedFloorUnits({minNetUnits: 0n, gasStableUnits: 1n}), /positive/);
  assert.throws(() => netProfitUnits({amount: -1n, outUnits: 0n, fee: 0n, gasStable: 0n}));
  assert.equal(weiToStable(5n * 10n ** 14n, 2000_000000n), 1_000000n);
  assert.equal(routeGasUnits('AAVE_V3', [{type: 'v2'}, {type: 'v3'}]), 430000n);
});

test('Balancer V2 is disabled unless explicitly opted in', () => {
  const base = NETWORKS.find((n) => n.id === 8453);
  assert.deepEqual(withEnvProviders(base, {}).providers.map((p) => p.kind), ['AAVE_V3', 'MORPHO_BLUE']);
  assert.ok(withEnvProviders(base, {ENABLE_BALANCER_V2: 'true'}).providers.some((p) => p.kind === 'BALANCER_V2'));
  assert.ok(withEnvProviders(base, {EULER_VAULT_8453: '0x' + '1'.repeat(40)}).providers.some((p) => p.kind === 'EULER_V2'));
});

test('private transaction endpoint only via https PRIVATE_TX_RPC_<chainId>', () => {
  const bnb = NETWORKS.find((n) => n.id === 56);
  assert.equal(broadcastUrl(bnb, {}), null);
  assert.equal(broadcastUrl(bnb, {PRIVATE_TX_RPC_56: 'https://private.example'}), 'https://private.example');
  assert.equal(broadcastUrl(bnb, {PRIVATE_TX_RPC_56: 'http://insecure.example'}), null);
});
