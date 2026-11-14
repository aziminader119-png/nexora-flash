// Read-only pinned-block preflight for operator-supplied multihop catalogs.
// Never promotes unapproved routers or declares a pool executable.
// A positive V2/V3 quote validates only the quoting interface, not underlying
// reserves, pool factory identity, fee-on-transfer semantics or round trip.
const ADDRESS=/^0x[0-9a-fA-F]{40}$/;
const low=s=>String(s||'').toLowerCase();
const CODE_RE=/^0x[0-9a-fA-F]+$/;
export async function verifyCatalogIdentities({chain,net,edges=[],block,maxContracts=80,maxTokens=40,maxQuotes=12}){
 if(!Array.isArray(edges)||edges.length>150||!Number.isSafeInteger(block)||block<0||
  !Number.isInteger(maxContracts)||maxContracts<1||maxContracts>120||
  !Number.isInteger(maxTokens)||maxTokens<1||maxTokens>100||
  !Number.isInteger(maxQuotes)||maxQuotes<0||maxQuotes>40)
 throw Error('Invalid catalog preflight parameters');
 const fail=[],contracts=new Set(),tokens=new Set(),pairs=[];
 for(const [i,e] of edges.entries()){
  if(!e?.pool||!ADDRESS.test(e.pool.router)||!ADDRESS.test(e.tokenIn?.address)||
   !ADDRESS.test(e.tokenOut?.address)||
   !['v2','v3'].includes(e.pool.type)||
   (e.pool.type==='v3'&&!ADDRESS.test(e.pool.quoter))){
   fail.push({edge:i,reason:'INVALID_EDGE'});continue;
  }
  contracts.add(low(e.pool.router));
  if(e.pool.type==='v3')contracts.add(low(e.pool.quoter));
  tokens.add(low(e.tokenIn.address));tokens.add(low(e.tokenOut.address));
  pairs.push({index:i,edge:e});
 }
 if(contracts.size>maxContracts||tokens.size>maxTokens)
  return {status:'REJECTED',block,passed:false,contractCount:contracts.size,
   tokenCount:tokens.size,quoteChecks:0,failures:[{reason:'CATALOG_BUDGET_EXCEEDED'}],
   executable:false};
 try {
  const cid=await chain.chainId();
  if(cid!==net.id)throw Error('RPC_CHAIN_ID_MISMATCH');
  const [chainBlock]=await Promise.all([chain.blockNumber()]);
  if(chainBlock<block)throw Error('BLOCK_NOT_AVAILABLE');
 }catch(e){return {status:'REJECTED',block,passed:false,
   quoteChecks:0,failures:[{reason:String(e.message||e).slice(0,100)}],executable:false};}
 for(const address of contracts){
  try{
   const code=await chain.contractCode(address,block);
   if(typeof code!=='string'||!CODE_RE.test(code)||code==='0x')
     throw Error('CONTRACT_NO_CODE');
  }catch{fail.push({address,reason:'CONTRACT_CODE_UNAVAILABLE'});}
 }
 const decimals=new Map();
 for(const address of tokens){
  try{
   const code=await chain.contractCode(address,block);
   if(typeof code!=='string'||!CODE_RE.test(code)||code==='0x')throw Error('NO_CODE');
   const d=await chain.tokenDecimals(address,block);
   if(!Number.isInteger(d)||d<0||d>36)throw Error('BAD_DECIMALS');
   decimals.set(address,d);
  }catch{fail.push({address,reason:'TOKEN_IDENTITY_UNVERIFIED'});}
 }
 if(decimals.has(low(net.stable.address)) &&
    decimals.get(low(net.stable.address))!==net.stable.decimals)
  fail.push({address:low(net.stable.address),reason:'BASE_TOKEN_DECIMALS_MISMATCH'});
 let quoteChecks=0;
 // Nonzero but bounded probe to distinguish usable quote interfaces from
 // phantom routers. Exact route-size economics use the ordinary engine.
 for(const {index,edge:e} of pairs.slice(0,maxQuotes)){
  const d=decimals.get(low(e.tokenIn.address));
  if(d===undefined)continue;
  const sample=10n**BigInt(d);
  try{
   quoteChecks++;
   const out=e.pool.type==='v2'?
    await chain.quoteV2(e.pool.router,sample,e.tokenIn.address,e.tokenOut.address,block):
    await chain.quoteV3(e.pool.quoter,e.tokenIn.address,e.tokenOut.address,e.pool.fee,sample,block);
   if(typeof out!=='bigint'||out<=0n)throw Error('INVALID_QUOTE');
  }catch{fail.push({edge:index,reason:'SMALL_QUOTE_UNAVAILABLE'});}
 }
 const complete=pairs.length<=maxQuotes;
 return {status:fail.length?'REJECTED':complete?'QUOTE_PREFLIGHT_PASSED':'PARTIAL',
   block,passed:fail.length===0&&complete,quoteChecks,
   contractCount:contracts.size,tokenCount:tokens.size,
   verifiedTokens:decimals.size,failures:fail,
   caveat:'No on-chain factory/pool identity or atomic flash-loan execution was verified. This read-only report cannot authorize new venues.',
   executable:false};
}
