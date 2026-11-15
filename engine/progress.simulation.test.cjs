// Disk-backed replays of successful and misleading report sequences. These use
// temporary files only: no Switch, sockets, payloads or real run files.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {createProgress} = require('./lib/progress.cjs');

async function simulation(t) {
  const run = await fs.mkdtemp(path.join(os.tmpdir(), 'kaihen-progress-simulation-'));
  const folder = path.join(run, 'switch2');
  await fs.mkdir(path.join(folder, 'memory'), {recursive: true});
  await fs.mkdir(path.join(folder, 'ro'));
  const lines = [];
  const progress = createProgress({interval: 5, stream: {write(text) {
    lines.push(...text.trimEnd().split('\n'));
  }}});
  t.after(async () => {progress.stop(); await fs.rm(run, {recursive: true, force: true});});
  const write = async (name, value) => {
    const file = path.join(folder, name);
    await fs.writeFile(file + '.next', JSON.stringify(value));
    await fs.rename(file + '.next', file);
  };
  const waitFor = async pattern => {
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      if (pattern.test(lines.at(-1) || '')) return lines.at(-1);
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.fail(`No progress update matching ${pattern}; got:\n${lines.join('\n')}`);
  };
  const session = path.basename(run);
  const pipeline = {session, stages: [{name: 'app/map', status: 'running'}]};
  const began = '2026-11-15T01:00:00.000Z';
  const stage = {name: 'FS read, write and restoration', status: 'running', started: began};
  const supervisor = {stage: 'acquiring', attempts: [{attempt: 1, started: began}]};
  const report = {session, started: '2026-11-15T01:00:00.010Z'};
  const pointAt = async filename => write('current-acquisition.json', {
    session, report: path.join(folder, 'memory', filename),
  });
  const startAcquisition = async () => {
    pipeline.stages = [{name: 'app/map', status: 'complete'}, stage];
    await write('pipeline.json', pipeline);
    await write('acquisition-supervisor.json', supervisor);
    await write('memory/first.json', report);
    await pointAt('first.json');
  };
  await write('pipeline.json', pipeline);
  progress.start(run);
  await waitFor(/phase 1\/4/);
  return {progress, lines, write, waitFor, pipeline, supervisor, report, stage, pointAt, startAcquisition};
}

test('simulation: console checks → race → native helper → frontend → verified HEN', async t => {
  const s = await simulation(t);
  await s.startAcquisition();
  await s.waitFor(/phase 2\/4/);
  for (const [fields, percent] of [
    [{markerSelected: true}, 45],
    [{markerReproduced: true, cacheAlias: {}}, 57],
    [{cacheRange: {}}, 60],
    [{linkCandidates: [{encodable: true}]}, 63],
    [{retainedMemory: {ready: true}}, 67],
    [{memoryControl: {ready: true}}, 70],
  ]) {
    Object.assign(s.report, fields);
    await s.write('memory/first.json', s.report);
    await s.waitFor(new RegExp(`~${percent}%`));
  }
  s.stage.status = 'complete';
  s.pipeline.stages.push({name: 'retained/find-metadata', status: 'complete'});
  await s.write('pipeline.json', s.pipeline);
  await s.waitFor(/phase 3\/4/);
  s.pipeline.stages.push({name: 'Connect to the RO frontend', status: 'complete'});
  s.pipeline.verified = true;
  await s.write('pipeline.json', s.pipeline);
  await s.waitFor(/~95%.*phase 4\/4/);
  await s.write('ro/hen-startup.json', {operation: 10, result: 0, pid: '210',
    gateRestoreResult: 0, channelRestoreResult: 0});
  await s.waitFor(/~98%.*awaiting launcher verification/);
  assert.ok(s.lines.every(line => !line.includes('~100%')));
  // This callback belongs to hen.cjs, after startHen() has returned successfully.
  s.progress.succeed();
  await s.waitFor(/~100%.*HEN started \(verified\)/);
  assert.equal(s.lines.filter(line => line.includes('~100%')).length, 1);
});

test('simulation: 10 waves and marker hits are not success; failures and stale retry reports reset', async t => {
  const s = await simulation(t);
  await s.startAcquisition();
  Object.assign(s.report, {markerSelected: true, markerReproduced: true, cacheAlias: {},
    retryBatches: [{profile: 'positive', limit: 10, attemptsStarted: 10,
      qualifiedWindows: 2, markerHits: 1, aborted: 8}]});
  await s.write('memory/first.json', s.report);
  await s.waitFor(/~57%.*positive 10\/10 waves/);
  s.report.error = 'The bounded native leak contains no qualified, encodable link candidate';
  await s.write('memory/first.json', s.report);
  await s.waitFor(/~0%.*failed; progress reset.*no qualified, encodable link candidate/);
  s.supervisor.attempts.push({attempt: 2, started: '2026-11-15T01:01:00Z'});
  await s.write('acquisition-supervisor.json', s.supervisor);
  // Pointer still references attempt 1, which has marker hits and an error.
  await s.waitFor(/~0%.*acquisition 2.*in progress/);
  const fresh = {session: s.pipeline.session, started: '2026-11-15T01:01:00.010Z',
    control: {checkpoint: 'abort-control'}};
  await s.write('memory/second.json', fresh);
  await s.pointAt('second.json');
  await s.waitFor(/~2%.*acquisition 2.*abort-control/);
  s.pipeline.error = 'Positive canary verification failed';
  await s.write('pipeline.json', s.pipeline);
  await s.waitFor(/~0%.*failed; progress reset.*Positive canary/);
  assert.ok(s.lines.every(line => !line.includes('~100%')));
});

test('simulation: missing retained capture recovers, reacquires, then fails without a false pass', async t => {
  const s = await simulation(t);
  await s.startAcquisition();
  s.stage.status = 'complete';
  s.supervisor.stage = 'memory-ready';
  s.report.memoryControl = {ready: true};
  await s.write('memory/first.json', s.report);
  await s.write('acquisition-supervisor.json', s.supervisor);
  s.pipeline.stages.push({name: 'retained/find-metadata', status: 'failed',
    error: 'The pool capture has no native links'});
  await s.write('pipeline.json', s.pipeline);
  await s.waitFor(/phase 3\/4.*in progress.*launcher may recover/);
  assert.doesNotMatch(s.lines.at(-1), /failed; progress reset/);
  s.pipeline.stages.push({name: 'Retire the uncaptured endpoint', status: 'complete'},
    {name: 'FS read, write and restoration (capture retry)', status: 'running',
      started: '2026-11-15T01:02:00Z'});
  await s.write('pipeline.json', s.pipeline);
  await s.waitFor(/~0%.*phase 2\/4/);
  s.pipeline.error = 'install-retained failed: Expected an idle captured bootstrap';
  await s.write('pipeline.json', s.pipeline);
  await s.waitFor(/~0%.*failed; progress reset.*install-retained/);
  assert.ok(s.lines.every(line => !line.includes('~100%')));
});

test('simulation: copied reports and success-shaped records cannot declare HEN running', async t => {
  const s = await simulation(t);
  await s.startAcquisition();
  await s.waitFor(/phase 2\/4/);
  s.report.session = 'a-different-run';
  s.report.memoryControl = {ready: true};
  s.report.markerSelected = true;
  await s.write('memory/first.json', s.report);
  await s.waitFor(/~0%.*Initializing acquisition/);
  s.pipeline.stages.push({name: 'Connect to the RO frontend', status: 'complete'});
  s.pipeline.verified = true;
  await s.write('pipeline.json', s.pipeline);
  await s.write('ro/hen-startup.json', {operation: 10, result: 0,
    gateRestoreResult: 123, channelRestoreResult: 0});
  await s.waitFor(/~98%.*awaiting launcher verification/);
  s.progress.fail(new Error('HEN startup restoration failed'));
  await s.waitFor(/~0%.*failed; progress reset.*restoration failed/);
  assert.ok(s.lines.every(line => !line.includes('~100%')));
});
