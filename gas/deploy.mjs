#!/usr/bin/env node
// Apps Script deploy tool (design.md §C.10, SP-22).
//
//   node gas/deploy.mjs --script-id <SCRIPT_ID>   back up → safety-check → push → redeploy → verify
//   node gas/deploy.mjs --backup-only              only snapshot the live project into backups/
//   node gas/deploy.mjs --rollback <version>       restore the backed-up code and re-point the live URL
//
// Prerequisite, once per machine: `npx clasp login` (a Google sign-in in your own browser),
// and "Google Apps Script API" switched on at https://script.google.com/home/usersettings.
// The Script ID is under Apps Script ▸ Project Settings ▸ IDs; after the first run it is
// remembered in backups/script-id.txt. backups/ is gitignored.
//
// Invariants (SP-22):
//  1. The live /exec URL never changes. The EXISTING deployment (id parsed from config.js)
//     is updated to a new version; a new deployment is never created, because a new URL
//     would break every browser that has the old one saved.
//  2. Nothing is pushed until the live project is cloned into backups/gas-<timestamp>/,
//     with its deployment and version lists.
//  3. The live Code.js must equal gas/Code.js at SOME commit in this repo's history. If it
//     matches none, it was edited in the online editor and pushing would erase that work,
//     so the tool aborts. (Time-driven triggers run the editor's code, not the deployed
//     version, so this also protects the daily snapshot.)
//  4. The live appsscript.json is reused verbatim, so timezone and web-app access
//     settings cannot drift. Only Code.js is replaced.
//  5. After redeploying, the endpoint is verified end to end. On any failure the backed-up
//     code is pushed back and the deployment re-pointed at the previous version.
// config.js values (Web App URL, API key) are read but never printed.

import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BACKUPS = path.join(ROOT, 'backups');
const SCRIPT_ID_FILE = path.join(BACKUPS, 'script-id.txt');
const LEDGER_RESOURCES = ['heldlots', 'trades', 'deposits', 'dividends', 'dailyhistory'];

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const rel = (p) => path.relative(ROOT, p).replace(/\\/g, '/');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let secrets = [];
const redact = (s) => secrets.reduce((acc, x) => (x ? acc.split(x).join('<redacted>') : acc), String(s));
const log = (msg) => console.log(redact(msg));
function die(msg, code = 1) {
  console.error('\n✗ ' + redact(msg));
  process.exit(code);
}

function clasp(argStr, cwd) {
  try {
    return execSync(`npx --no-install clasp ${argStr}`, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'], // stdin closed: never hang on a prompt
      timeout: 240000
    });
  } catch (e) {
    const out = `${e.stdout || ''}${e.stderr || ''}`.trim();
    if (/Apps Script API/i.test(out) && /enable/i.test(out)) {
      throw new Error('The Google Apps Script API is switched off for your account. Turn it on at ' +
        'https://script.google.com/home/usersettings, then re-run.');
    }
    throw new Error(`clasp ${argStr.split(' ')[0]} failed: ${out || e.message}`);
  }
}

async function loadConfig() {
  const cfgPath = path.join(ROOT, 'config.js');
  if (!fs.existsSync(cfgPath)) die('config.js not found — it holds the live Web App URL and API key.');
  const c = await import(pathToFileURL(cfgPath).href);
  const m = /\/macros\/s\/([A-Za-z0-9_-]+)\/exec$/.exec(c.WEBAPP_URL || '');
  if (!m || !c.API_KEY) die('config.js must export a WEBAPP_URL ending in /macros/s/<id>/exec and an API_KEY.');
  secrets = [c.API_KEY, m[1], c.WEBAPP_URL];
  return { url: c.WEBAPP_URL, key: c.API_KEY, deploymentId: m[1] };
}

async function getJson(cfg, params, key = cfg.key) {
  const qs = new URLSearchParams({ key, ...params }).toString();
  const res = await fetch(`${cfg.url}?${qs}`);
  return res.json();
}

async function postJson(cfg, body) {
  // text/plain, no custom headers: the same "simple request" shape the browser sends.
  const res = await fetch(cfg.url, { method: 'POST', body: JSON.stringify(body) });
  return res.json();
}

// Row counts only — never the data itself.
async function snapshot(cfg) {
  const counts = {};
  for (const r of LEDGER_RESOURCES) {
    const j = await getJson(cfg, { resource: r });
    counts[r] = Array.isArray(j) ? j.length : `error:${j && j.error}`;
  }
  return counts;
}

async function verify(cfg, baseline) {
  const problems = [];
  const now = await snapshot(cfg);
  for (const [r, n] of Object.entries(baseline)) {
    if (now[r] !== n) problems.push(`${r}: ${n} rows before, ${now[r]} after`);
  }

  const list0 = await getJson(cfg, { resource: 'sellplans' });
  if (!Array.isArray(list0)) {
    problems.push(`GET sellplans returned ${JSON.stringify(list0)} (new version not being served?)`);
    return problems;
  }

  const id = `deploycheck_${Date.now()}`;
  const probe = {
    id, name: 'deploy check (safe to delete)', savedAt: new Date().toISOString(),
    strategyId: 'custom', locked: [], rows: [], note: 'written and removed by gas/deploy.mjs'
  };
  const saved = await postJson(cfg, { key: cfg.key, action: 'save', scenario: probe });
  if (!saved || saved.ok !== true) problems.push(`POST save returned ${JSON.stringify(saved)}`);
  const list1 = await getJson(cfg, { resource: 'sellplans' });
  if (!Array.isArray(list1) || !list1.some((s) => s.id === id)) problems.push('saved probe not visible in the list');
  const del = await postJson(cfg, { key: cfg.key, action: 'delete', id });
  if (!del || del.deleted !== true) problems.push(`POST delete returned ${JSON.stringify(del)}`);
  const list2 = await getJson(cfg, { resource: 'sellplans' });
  if (Array.isArray(list2) && list2.some((s) => s.id === id)) problems.push('probe still present after delete');

  const badPost = await postJson(cfg, { key: 'wrong-key', action: 'save', scenario: probe });
  if (!badPost || badPost.error !== 'unauthorized') problems.push('a wrong-key POST was not refused');
  const badGet = await getJson(cfg, { resource: 'heldlots' }, 'wrong-key');
  if (!badGet || badGet.error !== 'unauthorized') problems.push('a wrong-key GET was not refused');
  return problems;
}

function requireLogin() {
  let who;
  try {
    who = clasp('show-authorized-user', ROOT);
  } catch (e) {
    who = e.message;
  }
  if (/not logged in|no credentials|login/i.test(who) && !/logged in as/i.test(who)) {
    die('clasp is not logged in. Run `npx clasp login` once — it opens a Google sign-in in your browser — then re-run.', 2);
  }
}

function resolveScriptId() {
  fs.mkdirSync(BACKUPS, { recursive: true });
  const id = opt('--script-id') ||
    (fs.existsSync(SCRIPT_ID_FILE) ? fs.readFileSync(SCRIPT_ID_FILE, 'utf8').trim() : '');
  if (!/^[A-Za-z0-9_-]{20,}$/.test(id)) {
    die('Need the Script ID: Apps Script ▸ Project Settings (gear icon) ▸ IDs ▸ Script ID. ' +
      'Pass it once as --script-id <id>.', 2);
  }
  fs.writeFileSync(SCRIPT_ID_FILE, id + '\n');
  return id;
}

function backup(scriptId, cfg) {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-');
  const dir = path.join(BACKUPS, `gas-${stamp}`);
  fs.mkdirSync(dir, { recursive: true });
  clasp(`clone ${scriptId} --rootDir .`, dir);
  const deployments = clasp(`list-deployments ${scriptId}`, dir);
  fs.writeFileSync(path.join(dir, 'deployments.txt'), deployments);
  fs.writeFileSync(path.join(dir, 'versions.txt'), clasp(`list-versions ${scriptId}`, dir));

  const line = deployments.split(/\r?\n/).find((l) => l.includes(cfg.deploymentId));
  const v = line && /@(\d+)/.exec(line);
  if (!v) {
    die(`The live deployment from config.js is not among this script's versioned deployments. ` +
      `Wrong Script ID? Nothing was pushed. See ${rel(dir)}/deployments.txt`, 3);
  }
  const prevVersion = Number(v[1]);
  fs.writeFileSync(path.join(dir, 'ROLLBACK.txt'),
    `The live deployment was on version ${prevVersion} before this deploy.\n` +
    `To roll back:  node gas/deploy.mjs --rollback ${prevVersion}\n`);
  return { dir, stamp, prevVersion };
}

function liveCodeFile(dir) {
  const files = fs.readdirSync(dir).filter((f) => /\.(js|gs)$/.test(f));
  const code = files.find((f) => /^Code\.(js|gs)$/.test(f));
  if (!code) die(`The live project has no Code.js (found: ${files.join(', ') || 'none'}). Nothing was pushed.`, 3);
  return { code, others: files.filter((f) => f !== code) };
}

// Invariant 3: the live code must be a committed version, i.e. nothing was edited online.
function matchCommittedVersion(liveText) {
  const norm = (s) => s.replace(/\r\n/g, '\n').replace(/[ \t]+$/gm, '').trim();
  const target = norm(liveText);
  const shas = execSync('git log --format=%H -- gas/Code.js', { cwd: ROOT, encoding: 'utf8' })
    .trim().split('\n').filter(Boolean);
  for (const sha of shas) {
    const text = execSync(`git show ${sha}:gas/Code.js`, { cwd: ROOT, encoding: 'utf8', maxBuffer: 16 << 20 });
    if (norm(text) === target) return sha;
  }
  return null;
}

function restore(backupDir, deploymentId, version, reason) {
  clasp('push --force', backupDir);
  clasp(`update-deployment ${deploymentId} -V ${version} -d "${reason}"`, backupDir);
}

async function main() {
  const cfg = await loadConfig();

  if (flag('--rollback')) {
    const v = Number(opt('--rollback'));
    if (!Number.isInteger(v) || v < 1) die('Usage: node gas/deploy.mjs --rollback <versionNumber>');
    requireLogin();
    const dirs = fs.existsSync(BACKUPS) ? fs.readdirSync(BACKUPS).filter((d) => d.startsWith('gas-')).sort() : [];
    if (!dirs.length) die('No backups/gas-* folder to restore from.');
    const latest = path.join(BACKUPS, dirs.at(-1));
    log(`Restoring the editor code from ${rel(latest)} and pointing the live URL at version ${v}…`);
    restore(latest, cfg.deploymentId, v, 'manual rollback');
    log(`✓ Rolled back. Ledger row counts now: ${JSON.stringify(await snapshot(cfg))}`);
    return;
  }

  requireLogin();
  const scriptId = resolveScriptId();

  log('1/6 Backing up the live Apps Script project…');
  const { dir: backupDir, stamp, prevVersion } = backup(scriptId, cfg);
  log(`    saved to ${rel(backupDir)}/ — the live URL is on version ${prevVersion}, the rollback point`);
  if (flag('--backup-only')) return;

  log('2/6 Checking the live code was not edited online…');
  const { code, others } = liveCodeFile(backupDir);
  const liveSha = matchCommittedVersion(fs.readFileSync(path.join(backupDir, code), 'utf8'));
  if (!liveSha) {
    die(`The live ${code} matches no committed version of gas/Code.js — it was edited in the Apps Script ` +
      `editor, and pushing would erase that work. Nothing was pushed. Its code is in ${rel(backupDir)}/.`, 3);
  }
  for (const f of others) {
    if (/function\s+doPost\s*\(/.test(fs.readFileSync(path.join(backupDir, f), 'utf8'))) {
      die(`${f} in the live project already defines doPost; merging it needs a human. Nothing was pushed.`, 3);
    }
  }
  const headSha = execSync('git rev-parse HEAD', { cwd: ROOT, encoding: 'utf8' }).trim();
  const between = execSync(`git log --oneline ${liveSha}..HEAD -- gas/Code.js`, { cwd: ROOT, encoding: 'utf8' }).trim();
  log(`    live code = committed version ${liveSha.slice(0, 7)}; this deploy brings in:\n` +
    (between ? between.split('\n').map((l) => '      ' + l).join('\n') : '      (no changes — already current)'));

  const baseline = await snapshot(cfg);
  if (Object.values(baseline).some((n) => typeof n !== 'number')) {
    die(`The live endpoint is already failing before any change: ${JSON.stringify(baseline)}. Nothing was pushed.`, 3);
  }
  log(`    ledger baseline (row counts): ${JSON.stringify(baseline)}`);

  log('3/6 Staging: live project + manifest, with only Code.js replaced…');
  const stageDir = path.join(BACKUPS, `staging-${stamp}`);
  fs.cpSync(backupDir, stageDir, { recursive: true });
  for (const f of ['deployments.txt', 'versions.txt', 'ROLLBACK.txt']) fs.rmSync(path.join(stageDir, f), { force: true });
  const claspCfg = JSON.parse(fs.readFileSync(path.join(backupDir, '.clasp.json'), 'utf8'));
  fs.writeFileSync(path.join(stageDir, '.clasp.json'), JSON.stringify({ ...claspCfg, rootDir: stageDir }, null, 2));
  fs.writeFileSync(path.join(backupDir, '.clasp.json'), JSON.stringify({ ...claspCfg, rootDir: backupDir }, null, 2));
  fs.copyFileSync(path.join(ROOT, 'gas', 'Code.js'), path.join(stageDir, code));
  const manifest = JSON.parse(fs.readFileSync(path.join(stageDir, 'appsscript.json'), 'utf8'));
  log(`    manifest reused verbatim — webapp ${JSON.stringify(manifest.webapp || {})}, timeZone ${manifest.timeZone}`);

  log('4/6 Pushing the code…');
  clasp('push --force', stageDir);

  log('5/6 Creating a version and pointing the live deployment at it…');
  const short = headSha.slice(0, 7);
  const vOut = clasp(`create-version "Rev 4.2 Sheet-synced scenarios (${short})"`, stageDir);
  const nv = /version\s+(\d+)/i.exec(vOut);
  if (!nv) {
    restore(backupDir, cfg.deploymentId, prevVersion, 'rollback: version number unreadable');
    die(`Could not read the new version number (${vOut.trim()}). Restored the backed-up code; the live URL stays on version ${prevVersion}.`, 4);
  }
  const newVersion = Number(nv[1]);
  clasp(`update-deployment ${cfg.deploymentId} -V ${newVersion} -d "Rev 4.2 (${short})"`, stageDir);

  log('6/6 Verifying the live endpoint end to end…');
  let problems = [];
  for (let attempt = 1; attempt <= 4; attempt++) {
    problems = await verify(cfg, baseline);
    if (!problems.length) break;
    if (attempt < 4) await sleep(10000); // a redeploy can take a few seconds to propagate
  }
  if (problems.length) {
    log('    verification FAILED:\n      - ' + problems.join('\n      - '));
    log(`    rolling back to version ${prevVersion} and restoring the backed-up code…`);
    restore(backupDir, cfg.deploymentId, prevVersion, 'rollback: Rev 4.2 verification failed');
    die(`Rolled back to version ${prevVersion}. Ledger row counts after rollback: ${JSON.stringify(await snapshot(cfg))}. ` +
      `Backup: ${rel(backupDir)}/`, 5);
  }

  log(`\n✓ Live on version ${newVersion}; ledger reads unchanged ${JSON.stringify(baseline)}; save/list/delete verified; wrong keys refused.`);
  log(`  Roll back any time:  node gas/deploy.mjs --rollback ${prevVersion}`);
  log(`  Previous live code:  ${rel(backupDir)}/`);
}

main().catch((e) => die(e.message));
