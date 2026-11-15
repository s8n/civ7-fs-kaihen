'use strict';
// Display only: these estimates never drive the exploit or retry decisions.
const fs = require('node:fs/promises');
const path = require('node:path');

const safeText = value => String(value || '').replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').slice(0, 220);
const firstLine = value => String(value || '').split('\n')[0];
const acquisitionStage = stage => stage?.name?.startsWith('FS read, write and restoration');

function estimate({pipeline = {}, supervisor = {}, report = {}, hen = {}, henStarted = false} = {}) {
  const stages = pipeline.stages || [];
  const last = stages.at(-1);
  const attempts = supervisor.attempts || [];
  const attempt = attempts.at(-1) || {};
  const batches = report.retryBatches || [];
  const batch = batches.at(-1) || {};
  const profiles = new Set((report.cases || []).map(row => row.profile));
  const captureRetry = stages.filter(acquisitionStage).length;
  let phase = stages.length ? 1 : 0;
  let percent = 0;
  let detail = last?.name || 'Waiting for the console';
  let status = 'in progress';

  if (stages.some(acquisitionStage)) phase = 2;
  if (stages.some(row => row.name === 'retained/find-metadata')) phase = 3;
  if (stages.some(row => row.name === 'Connect to the RO frontend')) phase = 4;
  // A phase-3 repair can fall back to acquiring FS again. Do not leave the bar
  // at 70% just because an earlier acquisition completed.
  if (acquisitionStage(last)) phase = 2;
  if (phase === 1) {
    percent = Math.min(10, stages.filter(row => row.status === 'complete').length * 2.5);
  } else if (phase === 2) {
    detail = report.control?.checkpoint || 'Initializing acquisition';
    percent = report.started ? 2 : 0;
    for (const [profile, score] of [
      ['abort-control', 6], ['abort-hole-control', 10],
      ['extent-absent', 14], ['extent-present', 18], ['negative', 28], ['positive', 32],
    ]) {
      if (profiles.has(profile) || batch.profile === profile) percent = Math.max(percent, score);
    }
    if (report.qualifiedReadSize) percent = Math.max(percent, 25);
    if (report.markerSelected) percent = Math.max(percent, 45);
    if (report.markerReproduced) percent = Math.max(percent, 52);
    // Presence means work has reached a milestone, not that it has passed.
    if (report.cacheAlias) percent = Math.max(percent, 57);
    if (report.cacheRange) percent = Math.max(percent, 60);
    if (report.linkCandidates?.length) percent = Math.max(percent, 63);
    if (report.retainedMemory?.ready) percent = Math.max(percent, 67);
    if (report.memoryControl?.ready || supervisor.stage === 'memory-ready') percent = 70;
  } else if (phase === 3) {
    const acquisitionIndex = stages.findLastIndex(acquisitionStage);
    const complete = stages.slice(acquisitionIndex + 1).filter(row => row.status === 'complete').length;
    percent = Math.min(89, 70 + complete);
    if (last?.status === 'failed') detail += ' (launcher may recover)';
  } else if (phase === 4) {
    percent = 90;
    if (stages.some(row => row.name === 'Connect to the RO frontend' && row.status === 'complete')) percent = 95;
    if (hen.operation !== undefined) {
      percent = 98;
      detail = `HEN operation ${hen.operation}; awaiting launcher verification`;
    }
  }

  let error = pipeline.error;
  if (!error && phase === 2) {
    if (supervisor.stage === 'failed') error = attempt.error || attempt.failureSummary?.message || 'Acquisition failed';
    else error = report.error || (report.completed && report.cleanedUp && !report.memoryControl?.ready
      ? 'Acquisition did not become ready' : null);
  }
  if (error) {
    percent = 0;
    status = 'failed; progress reset';
    detail = firstLine(error);
  }
  if (henStarted) {
    phase = 4;
    percent = 100;
    status = 'HEN started (verified)';
    detail = 'Close Civilization VII normally; hold R while opening a native game';
  }
  return {
    phase, percent: Math.round(percent), status, detail: safeText(detail),
    attempt: attempt.attempt || 0,
    // A fresh supervisor can reuse attempt number 1 during a capture retry.
    epoch: `${captureRetry}:${attempt.started || attempt.attempt || 0}`,
    wave: batch.profile ? {
      profile: safeText(batch.profile), started: batch.attemptsStarted || 0,
      limit: batch.limit || 0, windows: batch.qualifiedWindows || 0,
      hits: batch.markerHits || 0, aborted: batch.aborted || 0,
    } : null,
  };
}

function inside(run, file) {
  if (typeof file !== 'string') return null;
  const resolved = path.resolve(file);
  const relative = path.relative(run, resolved);
  return relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
    ? resolved : null;
}

function createReader() {
  const cache = new Map();
  return async file => {
    if (!file) return {};
    try {
      const stat = await fs.stat(file);
      if (stat.size > 32 * 1024 * 1024) return {};
      const old = cache.get(file);
      if (old?.mtime === stat.mtimeMs && old.size === stat.size) return old.value;
      const value = JSON.parse(await fs.readFile(file, 'utf8'));
      if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
      cache.set(file, {mtime: stat.mtimeMs, size: stat.size, value});
      return value;
    } catch {
      // Reports can be absent or briefly incomplete while the launcher writes.
      // Do not reuse stale state from the previous acquisition on a read error.
      return {};
    }
  };
}

async function readSnapshot(run, read = createReader()) {
  const folder = path.join(run, 'switch2');
  const [pipeline, savedSupervisor, current, hen] = await Promise.all([
    read(path.join(folder, 'pipeline.json')),
    read(path.join(folder, 'acquisition-supervisor.json')),
    read(path.join(folder, 'current-acquisition.json')),
    read(path.join(folder, 'ro', 'hen-startup.json')),
  ]);
  const acquisition = pipeline.stages?.findLast(acquisitionStage);
  let supervisor = savedSupervisor;
  if (Date.parse(acquisition?.started) > Date.parse(supervisor.attempts?.at(-1)?.started)) supervisor = {};
  const attempt = supervisor.attempts?.at(-1);
  const file = inside(run, attempt?.report || current.report);
  let report = await read(file);
  // The supervisor announces a retry before current-acquisition.json changes.
  // Ignore the old report in that interval, including its old marker hits/error.
  if (attempt?.started && !(Date.parse(report.started) >= Date.parse(attempt.started))) report = {};
  if (Date.parse(acquisition?.started) > Date.parse(report.started)) report = {};
  return {pipeline, supervisor, report, hen};
}

function format(state) {
  const filled = Math.round(state.percent / 5);
  const bar = '#'.repeat(filled) + '-'.repeat(20 - filled);
  const wave = state.wave;
  const counts = wave ? ` | ${wave.profile} ${wave.started}/${wave.limit} waves, ` +
    `${wave.windows} windows, ${wave.hits} hits, ${wave.aborted} aborted` : '';
  return `[progress] [${bar}] ~${state.percent}% | phase ${state.phase}/4` +
    (state.attempt ? ` | acquisition ${state.attempt}` : '') +
    ` | ${state.status} | ${state.detail}${counts}`;
}

function createProgress({stream = process.stderr, interval = 1000} = {}) {
  const read = createReader();
  let run, busy = false, stopped = false, timer, previous, henStarted = false;
  const emit = state => {
    const line = format(state);
    if (line !== previous) {stream.write(line + '\n'); previous = line;}
  };
  const update = async () => {
    if (busy || stopped || !run) return;
    busy = true;
    try {
      const state = estimate({...await readSnapshot(run, read), henStarted});
      if (!stopped) emit(state);
    } catch {
      // Progress reporting must never fail, stop, or retry console operations.
    } finally {busy = false;}
  };
  return {
    start(directory) {
      if (run || stopped) return;
      run = path.resolve(directory);
      stream.write('[progress] Milestone estimates, not time remaining or success probability. ' +
        'Retries reset the bar; only verified HEN startup reaches 100%.\n');
      emit(estimate());
      update();
      timer = setInterval(update, interval);
      timer.unref();
    },
    succeed() {
      henStarted = true;
      emit(estimate({henStarted: true}));
      this.stop();
    },
    fail(error) {
      if (!henStarted) emit(estimate({pipeline: {error: firstLine(error?.message || error)}}));
      this.stop();
    },
    stop() {stopped = true; clearInterval(timer);},
  };
}

module.exports = {estimate, readSnapshot, format, createProgress};
