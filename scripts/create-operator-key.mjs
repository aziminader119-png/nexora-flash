#!/usr/bin/env node
// Create the bot's OPERATOR hot key as an encrypted keystore plus a random password file.
//   sudo node /opt/nexora/scripts/create-operator-key.mjs \
//        --out /var/lib/nexora/keys/operator.json --password-file /etc/nexora/keys/keystore-password
//   sudo chown nexora:nexora /var/lib/nexora/keys/operator.json && sudo bash install-ubuntu.sh
// Fund the printed address with a small amount of native gas only. Profit is paid to the owner-set receiver.
import fs from 'node:fs';
import crypto from 'node:crypto';
import {Wallet} from 'ethers';

const arg = (k) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : null; };
const out = arg('out');
const pwFile = arg('password-file');
if (!out || !pwFile) throw Error('usage: --out <keystore.json> --password-file <file>');
for (const f of [out, pwFile]) if (fs.existsSync(f)) throw Error(`${f} already exists; refusing to overwrite`);
const password = crypto.randomBytes(32).toString('hex');
const wallet = Wallet.createRandom();
const json = await wallet.encrypt(password);
fs.writeFileSync(pwFile, password + '\n', {mode: 0o600});
fs.writeFileSync(out, json, {mode: 0o600});
console.log(`Operator address: ${wallet.address}`);
console.log(`Keystore: ${out}\nPassword file: ${pwFile}`);
console.log('No mnemonic is printed. Back up the keystore + password file offline if you need to restore this key.');
