// Read-only price-dislocation discovery from published DEX Screener metadata.
// NEVER an executable arbitrage quote. No venue promotion or signer interaction.
// Curated token seeds, not a list of executable contracts or approved venues.
// Wider seed coverage exposes more reported pools without inferring a route.
const ASSETS=Object.freeze({
 base:[
  '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', // native USDC
  '0x4200000000000000000000000000000000000006', // WETH
  '0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf', // cbBTC, Coinbase
  '0x940181a94A35A4569E4529A3CDfB74e38Fd98631', // AERO
 ],
 arbitrum:[
  '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', // USDC
  '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1', // WETH
  '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9', // USDT
  '0x912CE59144191C1204E64559FE8253a0e49E6548', // ARB
  '0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f', // WBTC
 ],
});
// Ten venue *discovery targets*, selected for relevant Base / Arbitrum activity.
// DEX Screener dexId strings are metadata; IDs do not approve venue routers.
// Missing IDs must be reported, never claimed as connected or executable.
export const DISCOVERY_VENUES=Object.freeze([
 {name:'Aerodrome',ids:['aerodrome'],chains:['base']},
 {name:'Uniswap',ids:['uniswap'],chains:['base','arbitrum']},
 {name:'PancakeSwap',ids:['pancakeswap'],chains:['base','arbitrum']},
 {name:'Metric',ids:['metric'],chains:['base','arbitrum']},
 {name:'Fluid',ids:['fluid'],chains:['base','arbitrum']},
 {name:'WOOFi',ids:['woofi'],chains:['base','arbitrum']},
 {name:'Camelot',ids:['camelot'],chains:['arbitrum']},
 {name:'Curve',ids:['curve'],chains:['base','arbitrum']},
 {name:'Sushi',ids:['sushiswap'],chains:['base','arbitrum']},
 {name:'DODO',ids:['dodo'],chains:['arbitrum']},
]);
const TARGET_BY_CHAIN=Object.fromEntries(Object.keys(ASSETS).map(chain=>[
 chain,new Map(DISCOVERY_VENUES.filter(v=>v.chains.includes(chain))
  .flatMap(v=>v.ids.map(id=>[id,v.name]))),
]));

const ADDR=/^0x[\da-f]{40}$/i;
const address=v=>String(v||'').toLowerCase();
function pairKey(p){return [address(p.baseToken.address),address(p.quoteToken.address)].sort().join(':');}
function normalizedNativePrice(p){
 // Normalize reversed orientation to one token order.
 const a=address(p.baseToken.address), b=address(p.quoteToken.address);
 const price=Number(p.priceNative);
 return a < b ? price : 1 / price;
}
const MAX_POOLS_PER_PAIR=20;
function valid(p,chain,{minLiquidityUSD,minVolume24hUSD}){
 if(!p || p.chainId!==chain || !ADDR.test(p.pairAddress)||!ADDR.test(p.baseToken?.address)||
   !ADDR.test(p.quoteToken?.address)||!p.dexId|| typeof p.dexId!=='string' ||
   !Number.isFinite(Number(p.priceNative))||Number(p.priceNative)<=0||
   !Number.isFinite(Number(p.liquidity?.usd))||Number(p.liquidity.usd)<minLiquidityUSD||
   !Number.isFinite(Number(p.volume?.h24))||Number(p.volume.h24)<minVolume24hUSD)return false;
 if(address(p.baseToken.address)===address(p.quoteToken.address))return false;
 return true;
}
/**
 * Same exact ordered token addresses + same chain is essential: priceNative
 * represents quoteToken / baseToken. priceUsd can refer to inconsistent
 * dollar proxies across pools and is never used for directional comparison.
 */
export function discoverPublishedSpreads(raw,chain,{minLiquidityUSD=50000,
  minVolume24hUSD=5000,maxSpreadBps=3000,limit=40}={}){
 if(!Object.hasOwn(ASSETS,chain)||!Array.isArray(raw)||
   !Number.isFinite(minLiquidityUSD)||minLiquidityUSD<10000||
   !Number.isFinite(minVolume24hUSD)||minVolume24hUSD<0||
   !Number.isInteger(maxSpreadBps)||maxSpreadBps<1||maxSpreadBps>10000||
   !Number.isInteger(limit)||limit<1||limit>100)throw Error('Invalid discovery input');
 const validPairs=new Map();
 const targets=TARGET_BY_CHAIN[chain];
 const venuePools=new Map(DISCOVERY_VENUES.filter(v=>v.chains.includes(chain)).map(v=>[v.name,0]));
 const ignoredDexIds=new Set();
 for(const p of raw){
   if(!valid(p,chain,{minLiquidityUSD,minVolume24hUSD}))continue;
   const name=targets.get(String(p.dexId).toLowerCase());
   if(!name){ignoredDexIds.add(String(p.dexId).slice(0,60));continue;}
   validPairs.set(address(p.pairAddress),{...p,verifiedDiscoveryVenueName:name});
 }
 for(const p of validPairs.values()){
   const v=p.verifiedDiscoveryVenueName;
   venuePools.set(v,(venuePools.get(v)||0)+1);
 }
 const byTokens=new Map();
 for(const p of validPairs.values()){
   const k=pairKey(p);
   if(!byTokens.has(k))byTokens.set(k,[]);
   byTokens.get(k).push(p);
 }
 let compared=0,aboveZero=0,overSpreadLimit=0;const candidates=[];
 for(const rawGroup of byTokens.values()){
  // Cap quadratic comparisons, favor actual observed volume and depth.
  const group=[...rawGroup].sort((a,b)=>Number(b.volume.h24)-Number(a.volume.h24)||
   Number(b.liquidity.usd)-Number(a.liquidity.usd)).slice(0,MAX_POOLS_PER_PAIR);
  for(let i=0;i<group.length;i++)for(let j=0;j<group.length;j++){
   if(i===j)continue;
   const buy=group[i],sell=group[j],
     pBuy=normalizedNativePrice(buy),pSell=normalizedNativePrice(sell);
   if(!(Number.isFinite(pBuy)&&Number.isFinite(pSell)&&pBuy>0&&pSell>pBuy))continue;
   compared++;aboveZero++;
   const spreadBps=(pSell/pBuy-1)*10000;
   if(!Number.isFinite(spreadBps)||spreadBps>maxSpreadBps){overSpreadLimit++;continue;}
   const liquidityUSD=Math.min(Number(buy.liquidity.usd),Number(sell.liquidity.usd));
   const tokenAddresses=[address(buy.baseToken.address),address(buy.quoteToken.address)].sort();
   const baseToken=tokenAddresses[0],quoteToken=tokenAddresses[1];
   const symbolOf=(p,addr)=>address(p.baseToken.address)===addr?p.baseToken.symbol:p.quoteToken.symbol;
   candidates.push({
     chain,baseToken,quoteToken,
     pair:String(symbolOf(buy,baseToken)||'TOKEN0')+'/'+String(symbolOf(buy,quoteToken)||'TOKEN1'),
     buyPool:address(buy.pairAddress),sellPool:address(sell.pairAddress),
     buyDex:String(buy.dexId),sellDex:String(sell.dexId),
     buyVenue:buy.verifiedDiscoveryVenueName,sellVenue:sell.verifiedDiscoveryVenueName,
     spreadBps:Number(spreadBps.toFixed(3)),minLiquidityUSD:liquidityUSD,
     minVolume24hUSD:Math.min(Number(buy.volume.h24),Number(sell.volume.h24)),
     qualification:'PUBLISHED_SPREAD_ONLY',repaidLoan:false,
     actionable:false,executable:false,
   });
  }
 }
 candidates.sort((a,b)=>b.spreadBps-a.spreadBps || b.minLiquidityUSD-a.minLiquidityUSD);
 return {mode:'DISCOVERY_ONLY',chain,observedPools:validPairs.size,
  comparedPositiveDirections:compared,overSpreadLimit,
  pairsCompared:byTokens.size,comparisonPoolCapPerPair:MAX_POOLS_PER_PAIR,
  signals:candidates.slice(0,limit),
  totalSignals:candidates.length,
  venueCoverage:{
   targets:venuePools.size,
   observed:[...venuePools].filter(([,count])=>count>0).map(([name,pools])=>({name,pools})),
   missing:[...venuePools].filter(([,count])=>count===0).map(([name])=>name),
   ignoredDexIds:[...ignoredDexIds].slice(0,30),
  },
  caveat:'Published DEX prices are not executable quotes. No exact amount-out, slippage, gas, price impact, lender fee, or flash-loan repayment has been validated.'};
}
// Tolerate one failed public-market seed without inventing full chain coverage.
// A complete outage is an error, not an empty opportunity report.
export async function fetchPublishedPairsDetailed(chain,{fetchFn=fetch,signal}={}){
 if(!Object.hasOwn(ASSETS,chain))throw Error('Unsupported network');
 const out=[],failedSeeds=[];
 let successfulSeeds=0;
 for(const token of ASSETS[chain]){
  try {
   const url='https://api.dexscreener.com/token-pairs/v1/'+chain+'/'+token;
   const r=await fetchFn(url,{signal,headers:{Accept:'application/json'}});
   if(!r.ok)throw Error('Published price API HTTP '+r.status);
   const data=await r.json();
   if(!Array.isArray(data))throw Error('Malformed published price response');
   // Metadata is not trusted for router promotion. Prefer the most active
   // pairs under a hard budget, independently for each token seed.
   const finite=v=>Number.isFinite(Number(v))?Math.max(0,Number(v)):0;
   const ordered=[...data].sort((a,b)=>
     finite(b?.volume?.h24)-finite(a?.volume?.h24)||
     finite(b?.liquidity?.usd)-finite(a?.liquidity?.usd));
   out.push(...ordered.slice(0,250));
   successfulSeeds++;
  } catch(e){
   failedSeeds.push({seedToken:token,reason:signal?.aborted?'TIMEOUT_OR_ABORT':'UPSTREAM_FAILURE'});
   if(signal?.aborted)break;
  }
 }
 if(successfulSeeds===0)throw Error('All published price seeds unavailable');
 return {pairs:out.slice(0,1500),requestedSeeds:ASSETS[chain].length,
  successfulSeeds,failedSeeds,
  coverageComplete:successfulSeeds===ASSETS[chain].length};
}
export async function fetchPublishedPairs(chain,options={}){
 const r=await fetchPublishedPairsDetailed(chain,options);
 if(!r.coverageComplete)throw Error('Incomplete published price coverage');
 return r.pairs;
}
