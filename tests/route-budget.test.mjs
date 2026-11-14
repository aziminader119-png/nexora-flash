import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {routeDepthBudgets,TOTAL_DEPTH_QUOTES} from '../lib/route-budget.mjs';
const sum=budgets=>Object.values(budgets).reduce((a,b)=>a+b,0);
test('even with no history, short cycles are preferred without starving long routes',()=>{
 const p=routeDepthBudgets([]);
 assert.equal(sum(p.budgets),TOTAL_DEPTH_QUOTES);
 assert.ok(p.budgets.two>p.budgets.three);
 assert.ok(p.budgets.three>=16&&p.budgets.four>=16);
 assert.ok(p.budgets.long>=40);
});
test('observed profit at one depth increases relative quote budget, not other execution permissions',()=>{
 const baseline=routeDepthBudgets([]);
 const boosted=routeDepthBudgets([{hopCount:4,netEstimate:32}]);
 assert.ok(boosted.budgets.four>baseline.budgets.four);
 assert.equal(sum(boosted.budgets),TOTAL_DEPTH_QUOTES);
 assert.ok(boosted.budgets.long>=40);
 assert.equal(boosted.mode,'SCAN_ONLY_BUDGET');
});
test('massive returns and invalid inputs remain bounded',()=>{
 const p=routeDepthBudgets([{hopCount:2,netEstimate:1e50},
 {hopCount:10,netEstimate:-5},{hopCount:1,netEstimate:1e9},{hopCount:3,netEstimate:NaN}]);
 assert.equal(sum(p.budgets),TOTAL_DEPTH_QUOTES);
 assert.ok(Object.values(p.budgets).every(v=>Number.isInteger(v)&&v>=16&&v<=80));
 assert.throws(()=>routeDepthBudgets(null),/Invalid/);
});
test('backend budgets every catalog depth while leaving LIVE execution gate intact',()=>{
 const s=fs.readFileSync(new URL('../server.js',import.meta.url),'utf8');
 for(const name of ['two','three','four','long'])
  assert.match(s,new RegExp('maxQuotes:budgetPlan\\.budgets\\.'+name));
 assert.match(s,/if \(LIVE && settings\.autoExecute\)/);
});
