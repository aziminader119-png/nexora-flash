#!/usr/bin/env node
// Read-only long-route readiness probe. No signer, no transaction, no wallet.
import fs from 'node:fs';
import {JsonRpcProvider, Contract, getAddress} from 'ethers';
import {NETWORKS} from '../lib/networks.mjs';
import {EXECUTOR_ABI} from '../lib/chain-ethers.mjs';

const [idArg, executorArg, file] = process.argv.slice(2);
if (!idArg || !executorArg || !file) {
  console.error('Usage: node scripts/check-long-route.mjs <chainId> <executorAddress> <candidate.json>');
  process.exit(2);
}
const net = NETWORKS.find((x) => x.id === Number(idArg));
if (!net) throw Error('Unsupported chain');
const executor = getAddress(executorArg);
const candidate = JSON.parse(fs.readFileSync(file, 'utf8'));
if (candidate.chainId !== net.id || !Array.isArray(candidate.legs)
  || candidate.legs.length < 5 || candidate.legs.length > 10
  || candidate.asset?.toLowerCase() !== net.stable.address.toLowerCase()
  || !candidate.provider?.address) throw Error('Invalid candidate or network mismatch');
const plan = {
  provider: getAddress(candidate.provider.address),
  asset: getAddress(candidate.asset),
  amount: BigInt(candidate.amount),
  maxFee: BigInt(candidate.provider.fee),
  minProfit: 1n, deadline: BigInt(Math.floor(Date.now() / 1000) + 60),
  legs: candidate.legs.map((l) => ({
    router:getAddress(l.router), kind:l.routerKind, tokenIn:getAddress(l.tokenIn),
    tokenOut:getAddress(l.tokenOut), fee:l.fee, minOut:1n,
  })),
};
const rpc = process.env[`RPC_${net.id}`] || net.rpcDefault;
const provider = new JsonRpcProvider(rpc, net.id, {staticNetwork:true, batchMaxCount:1, cacheTimeout:-1});
try {
  const actualChain = Number((await provider.getNetwork()).chainId);
  if (actualChain !== net.id || (await provider.getCode(executor)) === '0x') throw Error('Wrong RPC chain or executor contract missing');
  const c = new Contract(executor, EXECUTOR_ABI, provider);
  const addresses = [...new Set(plan.legs.flatMap((l) => [l.tokenIn, l.tokenOut]))];
  const routers = [...new Set(plan.legs.map((l) => l.router))];
  const [routeHash, cap, maxLoan, lenderKind, paused, owner, version, tokenFlags, routerFlags] = await Promise.all([
    c.longRouteHash(plan), c.maxRouteLegs(), c.maxLoan(plan.asset),
    c.providerKind(plan.provider), c.paused(), c.owner(), c.VERSION(),
    Promise.all(addresses.map((x) => c.allowedToken(x))),
    Promise.all(routers.map((x) => c.allowedRouter(x))),
  ]);
  const approved = await c.approvedLongRoute(routeHash);
  const reasons = [];
  if (BigInt(cap) < BigInt(plan.legs.length)) reasons.push('cold-owner maxRouteLegs below required length');
  if (!approved) reasons.push('cold owner has not approved route hash');
  if (BigInt(maxLoan) < plan.amount) reasons.push('on-chain maxLoan below requested amount');
  if (Number(lenderKind) === 0) reasons.push('lender not allowed');
  if (paused) reasons.push('executor is paused');
  if (!tokenFlags.every(Boolean)) reasons.push('some tokens are not allow-listed');
  if (!routerFlags.every(Boolean)) reasons.push('some routers are not allow-listed');
  console.log(JSON.stringify({
    mode:'READ_ONLY', fundedOrdersSubmitted:0, chainId:net.id, executor,
    version, owner, hopCount:plan.legs.length, routeHash,
    routeApprovedByColdOwner:approved, maxRouteLegs:Number(cap),
    onchainChecksPass:reasons.length === 0, reasons,
    note:'Does not prove market profitability, full fork readiness, external audit or execution authorization',
  }, null, 2));
  if (reasons.length) process.exitCode=1;
} finally {
  provider.destroy();
}
