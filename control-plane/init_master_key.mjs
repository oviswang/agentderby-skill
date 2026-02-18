#!/usr/bin/env node
import { ensureMasterKey } from './lib/crypto.mjs';

const { path } = ensureMasterKey();
console.log(JSON.stringify({ ok: true, masterKeyPath: path, note: 'Keep this file backed up offline; losing it means losing the ability to decrypt stored SSH keys.' }, null, 2));
