#!/usr/bin/env node
/*
 * Standalone Control4 discovery dump — no Homebridge needed.
 *
 * It prints every item the controller exposes, grouped by proxy, so you can see
 * exactly what would map into HomeKit. Credentials are read from the environment
 * and never printed.
 *
 * Usage (either auth method):
 *   CONTROL4_IP=192.168.1.172 CONTROL4_TOKEN=<director token> node tools/discover.js
 *   CONTROL4_IP=192.168.1.172 CONTROL4_USER=you@example.com CONTROL4_PASS=... node tools/discover.js
 *
 * With --json it prints the raw item array instead of the summary.
 */
'use strict';
const https = require('https');

const IP = process.env.CONTROL4_IP;
const TOKEN = process.env.CONTROL4_TOKEN;
const USER = process.env.CONTROL4_USER;
const PASS = process.env.CONTROL4_PASS;
const JSON_OUT = process.argv.includes('--json');
const APPLICATION_KEY = '78f6791373d61bea49fdb9fb8897f1f3af193f11';

if (!IP) {
  console.error('Set CONTROL4_IP to the controller LAN address.');
  process.exit(2);
}

function cloudPost(url, body, bearer) {
  return fetchJson(url, { method: 'POST', body, bearer });
}
async function fetchJson(url, { method = 'GET', body, bearer } = {}) {
  const headers = {};
  if (bearer) headers['Authorization'] = 'Bearer ' + bearer;
  if (body) headers['Content-Type'] = 'application/json';
  const res = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${url} -> HTTP ${res.status}: ${text.slice(0, 160)}`);
  return text ? JSON.parse(text) : {};
}

async function directorToken() {
  if (TOKEN) return TOKEN;
  if (!USER || !PASS) throw new Error('Provide CONTROL4_TOKEN, or CONTROL4_USER + CONTROL4_PASS.');
  const auth = await cloudPost('https://apis.control4.com/authentication/v1/rest', {
    clientInfo: {
      device: { deviceName: 'discover', deviceUUID: '0000000000000000', make: 'discover', model: 'discover', os: 'Android', osVersion: '10' },
      userInfo: { applicationKey: APPLICATION_KEY, password: PASS, userName: USER },
    },
  });
  const acct = auth.authToken && auth.authToken.token;
  if (!acct) throw new Error('Cloud login failed (no token).');
  const accounts = await fetchJson('https://apis.control4.com/account/v3/rest/accounts', { bearer: acct });
  const raw = accounts.account;
  const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
  if (!list.length) throw new Error('No controllers on account.');
  const common = (process.env.CONTROL4_COMMON_NAME) || list[0].controllerCommonName;
  console.error('Controller:', common);
  const authz = await cloudPost('https://apis.control4.com/authentication/v1/rest/authorization',
    { serviceInfo: { commonName: common, services: 'director' } }, acct);
  const tok = authz.authToken && authz.authToken.token;
  if (!tok) throw new Error('No director token returned.');
  return tok;
}

function directorGet(path, token) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      host: IP, port: 443, path, method: 'GET',
      rejectUnauthorized: false,
      headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' },
      timeout: 15000,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const t = Buffer.concat(chunks).toString('utf8');
        if ((res.statusCode || 0) >= 300) return reject(new Error(`GET ${path} -> HTTP ${res.statusCode}: ${t.slice(0, 160)}`));
        resolve(t ? JSON.parse(t) : null);
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.end();
  });
}

(async () => {
  const token = await directorToken();
  const items = await directorGet('/api/v1/items', token);
  const arr = Array.isArray(items) ? items : [];
  if (JSON_OUT) { console.log(JSON.stringify(arr, null, 2)); return; }

  const byProxy = new Map();
  for (const it of arr) {
    const p = it.proxy || '(none)';
    if (!byProxy.has(p)) byProxy.set(p, []);
    byProxy.get(p).push(it);
  }
  console.log(`\n${arr.length} items total\n`);
  for (const [proxy, list] of [...byProxy.entries()].sort((a, b) => b[1].length - a[1].length)) {
    console.log(`${proxy}  (${list.length})`);
    for (const it of list) {
      console.log(`   #${it.id}  "${it.name}"  room="${it.roomName || '?'}"  type=${it.type != null ? it.type : '?'}`);
    }
  }
})().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
