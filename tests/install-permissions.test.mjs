import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {spawnSync} from 'node:child_process';

test('Ubuntu installer has valid syntax and grants dependency reads without making files writable',()=>{
  const installer=new URL('../install-ubuntu.sh',import.meta.url);
  const source=fs.readFileSync(installer,'utf8');
  const syntax=spawnSync('bash',['-n',installer.pathname],{encoding:'utf8'});
  assert.equal(syntax.status,0,syntax.stderr);
  assert.match(source,/chmod -R a\+rX "\$APP\/lib" "\$APP\/public" "\$APP\/scripts" "\$APP\/node_modules"/);
  assert.match(source,/chown -R root:root "\$APP"; chmod -R go-w "\$APP"/);
  assert.match(source,/runuser -u nexora -- "\$NODE_BIN" --input-type=module/);
  assert.match(source,/await import\('file:\/\/\$APP\/lib\/chain-ethers\.mjs'\)/);
  assert.match(source,/NEXORA_IMPORTS_OK/);
  assert.doesNotMatch(source,/chmod\s+-R\s+777/);
});
