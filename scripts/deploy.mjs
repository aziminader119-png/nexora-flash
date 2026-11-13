#!/usr/bin/env node
// Deploy and configure NexoraFlashExecutor on one network. The contract is deployed PAUSED.
//
//   DEPLOYER_KEYSTORE=/secure/owner.json RPC_8453=https://... \
//   node scripts/deploy.mjs --chain 8453 --operator 0xHOT... [--receiver 0xTREASURY] [--max-loan 1000] [--unpause]
//
// The deployer becomes the OWNER (use a cold/hardware-backed wallet). The OPERATOR is the bot's hot key.
// Only fork-validated venues and the network's configured providers are allow-listed.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import {fileURLToPath} from 'node:url';
import {JsonRpcProvider, Wallet, ContractFactory, keccak256, getAddress, parseUnits} from 'ethers';
import {networkById, withEnvProviders, PROVIDER_KIND} from '../lib/networks.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (k, d = null) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const flag = (k) => process.argv.includes(`--${k}`);

function hiddenPrompt(q) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({input: process.stdin, output: process.stdout, terminal: true});
    rl._writeToOutput = (s) => { if (s.includes(q)) process.stdout.write(s); };
    rl.question(q, (a) => { rl.close(); process.stdout.write('\n'); resolve(a); });
  });
}

const chainId = Number(arg('chain'));
const net0 = networkById(chainId);
if (!net0) throw Error('--chain must be one of 56, 8453, 42161, 10, 137');
const net = withEnvProviders(net0);
const operator = getAddress(arg('operator') || '');
const rpc = process.env[`RPC_${chainId}`] || net.rpcDefault;
const provider = new JsonRpcProvider(rpc, chainId, {staticNetwork: true, cacheTimeout: -1});
if (Number(BigInt(await provider.send('eth_chainId', []))) !== chainId) throw Error('RPC chain id mismatch');

const ks = process.env.DEPLOYER_KEYSTORE;
if (!ks) throw Error('DEPLOYER_KEYSTORE (encrypted owner keystore) is required');
const pw = process.env.DEPLOYER_KEYSTORE_PASSWORD_FILE ? fs.readFileSync(process.env.DEPLOYER_KEYSTORE_PASSWORD_FILE, 'utf8').trim() : await hiddenPrompt('Owner keystore password: ');
const owner = (await Wallet.fromEncryptedJson(fs.readFileSync(ks, 'utf8'), pw)).connect(provider);
const receiver = getAddress(arg('receiver') || owner.address);
const maxLoan = parseUnits(String(Number(arg('max-loan', '1000'))), net.stable.decimals);
if (operator === owner.address) throw Error('operator must differ from owner (hot key vs cold key separation)');

for (const [what, a] of [['stable', net.stable.address], ['wrapped', net.wrapped.address], ...net.providers.map((p) => [p.kind, p.address]), ...net.venues.filter((v) => v.forkValidated).map((v) => [v.name, v.router])]) {
  if ((await provider.getCode(a)) === '0x') throw Error(`no contract code at ${what} ${a} on chain ${chainId}`);
}

const art = JSON.parse(fs.readFileSync(path.join(root, 'out/NexoraFlashExecutor.sol/NexoraFlashExecutor.json'), 'utf8'));
console.log(`Deploying from owner ${owner.address} on ${net.name}; operator ${operator}; profit receiver ${receiver}`);
const exe = await new ContractFactory(art.abi, art.bytecode.object, owner).deploy(owner.address, operator, receiver);
await exe.waitForDeployment();
const address = await exe.getAddress();
const codehash = keccak256(await provider.getCode(address));
if (codehash !== keccak256(art.deployedBytecode.object)) throw Error('deployed runtime code does not match the build artifact');
console.log(`Deployed ${address} (codehash ${codehash})`);

const tx = async (label, p) => { const r = await (await p).wait(); console.log(`  ${label}: ${r.hash}`); };
for (const p of net.providers) await tx(`provider ${p.kind} ${p.address}`, exe.setProvider(p.address, PROVIDER_KIND[p.kind]));
for (const v of net.venues.filter((x) => x.forkValidated)) await tx(`router ${v.name} ${v.router}`, exe.setRouter(v.router, true));
await tx(`token ${net.stable.symbol}`, exe.setToken(net.stable.address, true));
await tx(`token ${net.wrapped.symbol}`, exe.setToken(net.wrapped.address, true));
await tx(`maxLoan ${arg('max-loan', '1000')} ${net.stable.symbol}`, exe.setMaxLoan(net.stable.address, maxLoan));
if (flag('unpause')) await tx('unpause', exe.unpause());

console.log(`\nAdd to /etc/nexora/nexora.env:\nEXECUTOR_${chainId}=${address}\n${flag('unpause') ? '' : 'Contract is PAUSED. Unpause with the owner wallet after preflight passes.'}`);
