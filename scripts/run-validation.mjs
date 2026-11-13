#!/usr/bin/env node
// Runs every validation gate and writes validation/gate-report.json (consumed by the executor) plus a human log.
//   node scripts/run-validation.mjs                 # local gates; fork suites run when RPC env vars are set
//   node scripts/run-validation.mjs --require-fork  # every fork suite + e2e fork are critical (CI / pre-live)
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseForgeJson} from '../lib/gates.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const requireFork = process.argv.includes('--require-fork');
const FORK = [
  {suite: 'ForkBaseTest', env: 'BASE_RPC_URL'},
  {suite: 'ForkBNBTest', env: 'BSC_RPC_URL'},
  {suite: 'ForkArbitrumTest', env: 'ARBITRUM_RPC_URL'},
  {suite: 'ForkOptimismTest', env: 'OPTIMISM_RPC_URL'},
  {suite: 'ForkPolygonTest', env: 'POLYGON_RPC_URL'},
];

function run(cmd, args, {timeoutMs = 30 * 60000} = {}) {
  const started = Date.now();
  const r = spawnSync(cmd, args, {cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, timeout: timeoutMs, env: process.env});
  return {command: [cmd, ...args].join(' '), exitCode: r.status ?? (r.error ? 127 : 1), stdout: r.stdout || '', stderr: (r.stderr || '') + (r.error ? `\n${r.error.message}` : ''), durationMs: Date.now() - started};
}
const tail = (s, n = 60) => s.split('\n').slice(-n).join('\n');
const version = (cmd, args) => { const r = run(cmd, args, {timeoutMs: 20000}); return r.exitCode === 0 ? r.stdout.trim().split('\n')[0] : 'not installed'; };

const report = {
  schema: 1, generatedAt: null, host: os.hostname(), requireFork,
  git: version('git', ['rev-parse', 'HEAD']),
  toolchain: {node: process.version, forge: version('forge', ['--version']), anvil: version('anvil', ['--version'])},
  executor: {runtimeCodehash: null, artifact: 'out/NexoraFlashExecutor.sol/NexoraFlashExecutor.json'},
  steps: [], forge: {unit: [], fork: []},
};
const md = [`# NEXORA validation log`, ``, `Host: ${report.host}  Node: ${process.version}  forge: ${report.toolchain.forge}  git: ${report.git}`, ``];

function step(id, critical, cmd, args, opts) {
  console.log(`\n=== ${id}: ${cmd} ${args.join(' ')}`);
  const r = run(cmd, args, opts);
  const out = tail(`${r.stdout}\n${r.stderr}`.trim());
  console.log(out);
  report.steps.push({id, critical, command: r.command, exitCode: r.exitCode, durationMs: r.durationMs, startedAt: new Date(Date.now() - r.durationMs).toISOString(), outputTail: out});
  md.push(`## ${id} ${r.exitCode === 0 ? 'PASS' : 'FAIL'}${critical ? ' (critical)' : ''}`, '', '```', `$ ${r.command}`, out, `exit=${r.exitCode} (${(r.durationMs / 1000).toFixed(1)}s)`, '```', '');
  return r;
}

const nodeTests = fs.readdirSync(path.join(root, 'tests')).filter((f) => f.endsWith('.test.mjs')).map((f) => path.join('tests', f));
step('node-unit', true, process.execPath, ['--test', ...nodeTests]);
const build = step('forge-build', true, 'forge', ['build', '--sizes']);
const unit = step('forge-unit', true, 'forge', ['test', '--no-match-path', 'test/fork/*', '--json']);
report.forge.unit = parseForgeJson(unit.stdout);
if (unit.exitCode === 0 && report.forge.unit.length === 0) { report.steps.at(-1).exitCode = 1; report.steps.at(-1).outputTail += '\nNo forge unit results parsed'; }

if (build.exitCode === 0) {
  try {
    const {keccak256} = await import('ethers');
    const a = JSON.parse(fs.readFileSync(path.join(root, report.executor.artifact), 'utf8'));
    report.executor.runtimeCodehash = keccak256(a.deployedBytecode.object);
  } catch (e) { console.error(`codehash: ${e.message}`); }
}

step('e2e-local', true, process.execPath, ['scripts/e2e-anvil.mjs', 'local']);

for (const f of FORK) {
  if (!process.env[f.env] && !requireFork) { report.steps.push({id: `fork-${f.suite}`, critical: false, exitCode: null, skipped: `${f.env} not set`}); md.push(`## fork-${f.suite} SKIPPED (${f.env} not set)`, ''); continue; }
  // Pin a recent block (latest - 5) so the run is reproducible, and record it.
  let forkBlock = 0;
  try { const {JsonRpcProvider} = await import('ethers'); const p = new JsonRpcProvider(process.env[f.env]); forkBlock = (await p.getBlockNumber()) - 5; p.destroy(); }
  catch (e) { console.error(`fork block lookup failed for ${f.suite}: ${e.message}`); }
  process.env.FORK_BLOCK = String(forkBlock > 0 ? forkBlock : 0);
  const r = step(`fork-${f.suite}`, requireFork, 'forge', ['test', '--match-contract', `^${f.suite}$`, '--json']);
  report.steps.at(-1).forkBlock = forkBlock || 'latest';
  report.forge.fork.push(...parseForgeJson(r.stdout).map((t) => ({...t, forkBlock: forkBlock || 'latest'})));
  delete process.env.FORK_BLOCK;
}
if (process.env.BASE_RPC_URL || requireFork) step('e2e-fork-base', requireFork, process.execPath, ['scripts/e2e-anvil.mjs', 'fork']);

report.generatedAt = new Date().toISOString();
const failed = report.steps.filter((s) => s.critical && s.exitCode !== 0);
report.summary = {criticalPassed: failed.length === 0, failed: failed.map((s) => s.id),
  forkPassed: report.forge.fork.filter((t) => /success/i.test(t.status)).length, forkFailed: report.forge.fork.filter((t) => !/success/i.test(t.status)).length};
fs.mkdirSync(path.join(root, 'validation'), {recursive: true});
fs.writeFileSync(path.join(root, 'validation', 'gate-report.json'), JSON.stringify(report, null, 2));
md.push('## Fork test matrix', '', '| Suite | Fork block | Test | Status | Reason |', '|---|---|---|---|---|', ...report.forge.fork.map((t) => `| ${t.suite} | ${t.forkBlock} | ${t.test} | ${t.status} | ${t.reason ?? ''} |`), '');
md.push(`**Critical gates: ${failed.length ? 'FAILED: ' + failed.map((s) => s.id).join(', ') : 'ALL PASSED'}**`);
fs.writeFileSync(path.join(root, 'validation', 'validation-log.md'), md.join('\n'));
console.log(`\nGate report: validation/gate-report.json  critical=${report.summary.criticalPassed ? 'PASS' : 'FAIL'}  fork pass/fail=${report.summary.forkPassed}/${report.summary.forkFailed}`);
process.exit(failed.length ? 1 : 0);
