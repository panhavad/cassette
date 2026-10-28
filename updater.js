'use strict';

// Supervisor: runs server.js and, when GIT_REPO is set, keeps it in sync with the
// latest commit on GIT_BRANCH (polling + webhook trigger), restarting on change and
// rolling back if a new commit fails to boot.

const { fork, execFile } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const REPO = (process.env.GIT_REPO || '').trim();
const BRANCH = process.env.GIT_BRANCH || 'main';
const POLL_MS = Math.max(15, Number(process.env.GIT_POLL_SECONDS) || 60) * 1000;
const LIVE_DIR = process.env.LIVE_DIR || '/srv/chassette';
const HEALTHY_AFTER_MS = 20000;

let appDir = __dirname;
let sha = process.env.GIT_SHA || 'dev';
let child = null;
let restarting = false;
let stopping = false;
let rollbackTo = null;
let healthyTimer = null;
let badSha = null;
let checking = null;
let crashCount = 0;

const log = (...a) => console.log('[updater]', ...a);
const redact = (s) => (REPO ? s.split(REPO).join('<repo>') : s);

function git(args, cwd = LIVE_DIR) {
  return new Promise((resolve, reject) => {
    execFile('git', ['-c', 'safe.directory=*', ...args], { cwd, timeout: 120000 }, (err, stdout, stderr) => {
      if (err) reject(new Error(redact((stderr || err.message).trim())));
      else resolve(stdout.trim());
    });
  });
}

function run(cmd, args, cwd) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { cwd, timeout: 300000 }, (err, _out, stderr) => (err ? reject(new Error(stderr || err.message)) : resolve()));
  });
}

function fileHash(file) {
  try {
    return crypto.createHash('sha1').update(fs.readFileSync(file)).digest('hex');
  } catch {
    return null;
  }
}

async function installDepsIfNeeded(lockBefore) {
  const pkg = JSON.parse(fs.readFileSync(path.join(LIVE_DIR, 'package.json'), 'utf8'));
  if (!pkg.dependencies || !Object.keys(pkg.dependencies).length) return;
  const lock = path.join(LIVE_DIR, 'package-lock.json');
  if (lockBefore && lockBefore === fileHash(lock) && fs.existsSync(path.join(LIVE_DIR, 'node_modules'))) return;
  log('installing dependencies');
  await run('npm', fs.existsSync(lock) ? ['ci', '--omit=dev'] : ['install', '--omit=dev'], LIVE_DIR);
}

function startChild() {
  const startedAt = Date.now();
  const self = fork(path.join(appDir, 'server.js'), [], { cwd: appDir, env: { ...process.env, GIT_SHA: sha } });
  child = self;
  log(`started server ${sha.slice(0, 12)} from ${appDir}`);

  clearTimeout(healthyTimer);
  healthyTimer = setTimeout(() => {
    rollbackTo = null;
    crashCount = 0;
  }, HEALTHY_AFTER_MS);

  self.on('message', (m) => {
    if (m && m.type === 'check-update') checkForUpdate('webhook');
  });
  self.on('exit', (code, signal) => {
    if (child === self) child = null;
    if (stopping || restarting) return;
    log(`server exited (code=${code}, signal=${signal})`);
    if (rollbackTo && Date.now() - startedAt < HEALTHY_AFTER_MS) {
      rollback().catch((err) => log('rollback failed:', err.message));
      return;
    }
    crashCount++;
    setTimeout(() => !child && !stopping && startChild(), Math.min(30000, 1000 * 2 ** Math.min(crashCount, 5)));
  });
}

function stopChild() {
  return new Promise((resolve) => {
    if (!child) return resolve();
    const c = child;
    const kill = setTimeout(() => c.kill('SIGKILL'), 10000);
    c.once('exit', () => {
      clearTimeout(kill);
      resolve();
    });
    c.kill('SIGTERM');
  });
}

async function restart() {
  restarting = true;
  try {
    await stopChild();
  } finally {
    restarting = false;
  }
  if (!stopping) startChild();
}

async function rollback() {
  const target = rollbackTo;
  rollbackTo = null;
  badSha = sha;
  log(`commit ${sha.slice(0, 12)} failed to start, rolling back to ${target.sha.slice(0, 12)}`);
  if (target.dir === LIVE_DIR) await git(['reset', '--hard', target.sha]);
  appDir = target.dir;
  sha = target.sha;
  startChild();
}

async function cloneRepo() {
  fs.mkdirSync(LIVE_DIR, { recursive: true });
  for (const f of fs.readdirSync(LIVE_DIR)) fs.rmSync(path.join(LIVE_DIR, f), { recursive: true, force: true });
  log(`cloning branch ${BRANCH}`);
  await git(['clone', '--depth', '1', '--branch', BRANCH, REPO, LIVE_DIR], path.dirname(LIVE_DIR));
}

function checkForUpdate(reason) {
  if (!REPO) return Promise.resolve();
  if (checking) return checking;
  checking = (async () => {
    try {
      if (!fs.existsSync(path.join(LIVE_DIR, '.git'))) await cloneRepo();
      else await git(['remote', 'set-url', 'origin', REPO]);
      await git(['fetch', '--depth', '1', 'origin', BRANCH]);
      const remote = await git(['rev-parse', 'FETCH_HEAD']);
      if (remote === badSha) return;
      if (appDir === LIVE_DIR && remote === sha) return;
      log(`deploying ${remote.slice(0, 12)} (${reason}), was ${sha.slice(0, 12)}`);
      const lockBefore = fileHash(path.join(LIVE_DIR, 'package-lock.json'));
      await git(['reset', '--hard', remote]);
      await git(['clean', '-fdq', '-e', 'node_modules']);
      try {
        await installDepsIfNeeded(lockBefore);
      } catch (err) {
        log('dependency install failed:', err.message);
      }
      rollbackTo = { dir: appDir, sha };
      appDir = LIVE_DIR;
      sha = remote;
      await restart();
    } catch (err) {
      log(`update check failed (${reason}):`, err.message);
    }
  })().finally(() => {
    checking = null;
  });
  return checking;
}

async function main() {
  if (REPO) {
    await checkForUpdate('startup');
    setInterval(() => checkForUpdate('poll'), POLL_MS);
    log(`watching branch ${BRANCH} every ${POLL_MS / 1000}s`);
  }
  if (!child) startChild();
}

function shutdown() {
  stopping = true;
  stopChild().then(() => process.exit(0));
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

main();
