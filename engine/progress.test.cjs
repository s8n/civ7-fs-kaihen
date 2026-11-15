const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const {EventEmitter} = require('node:events');
const {PassThrough} = require('node:stream');
const {estimate, readSnapshot, format, createProgress} = require('./lib/progress.cjs');
const {parse, observe} = require('./hen.cjs');

const acquiring = () => ({
  pipeline: {stages: [{name: 'app/map', status: 'complete'},
    {name: 'FS read, write and restoration', status: 'running'}]},
  supervisor: {stage: 'acquiring', attempts: [{attempt: 1, started: '2026-11-15T01:00:00Z'}]},
  report: {started: '2026-11-15T01:00:01Z'},
});

test('--progress is optional, accepted in either argument order and advertised in help', () => {
  assert.equal(parse(['192.168.2.118']).progress, false);
  assert.equal(parse(['192.168.2.118', '--progress', '--dir', 'kaihen']).progress, true);
  assert.equal(parse(['--progress', '192.168.2.118']).progress, true);
  const help = spawnSync(process.execPath, [path.join(__dirname, 'hen.cjs'), '--help'], {encoding: 'utf8'});
  assert.equal(help.status, 0);
  assert.match(help.stdout, /--progress/);
});

test('acquisition milestones advance, while unsuccessful waves alone cannot imply readiness', () => {
  const input = acquiring();
  assert.ok(estimate(input).percent < 10);
  input.report.markerSelected = true;
  assert.equal(estimate(input).percent, 45);
  input.report.markerReproduced = true;
  input.report.cacheAlias = {};
  assert.equal(estimate(input).percent, 57);
  input.report.cacheRange = {};
  assert.equal(estimate(input).percent, 60);
  input.report.linkCandidates = [{}];
  assert.equal(estimate(input).percent, 63);
  input.report.memoryControl = {ready: true};
  assert.equal(estimate(input).percent, 70);
  delete input.report.memoryControl;
  input.report.retryBatches = [{profile: 'positive', attemptsStarted: 10, limit: 10,
    qualifiedWindows: 0, markerHits: 0, aborted: 10}];
  const state = estimate(input);
  assert.equal(state.percent, 63);
  assert.match(format(state), /positive 10\/10 waves, 0 windows, 0 hits, 10 aborted/);
});

test('failure resets to zero; a fresh acquisition does not inherit prior marker hits or errors', async () => {
  const input = acquiring();
  input.report.error = 'Positive canary verification failed';
  assert.equal(estimate(input).percent, 0);
  assert.match(estimate(input).status, /failed/);
  const next = acquiring();
  next.supervisor.attempts.push({attempt: 2, started: '2026-11-15T01:01:00Z'});
  next.report = {};
  const state = estimate(next);
  assert.equal(state.percent, 0);
  assert.equal(state.attempt, 2);
  assert.notEqual(state.epoch, estimate(input).epoch);
});

test('a recoverable metadata failure stays in phase 3, and capture fallback resets to phase 2', () => {
  const input = acquiring();
  input.pipeline.stages.at(-1).status = 'complete';
  input.pipeline.stages.push({name: 'retained/find-metadata', status: 'failed', error: 'No native links'});
  let state = estimate(input);
  assert.equal(state.phase, 3);
  assert.equal(state.percent, 70);
  assert.doesNotMatch(state.status, /failed/);
  const previousEpoch = state.epoch;
  input.pipeline.stages.push({name: 'Retire the uncaptured endpoint', status: 'complete'},
    {name: 'FS read, write and restoration (capture retry)', status: 'running'});
  input.report = {};
  state = estimate(input);
  assert.equal(state.phase, 2);
  assert.equal(state.percent, 0);
  assert.notEqual(state.epoch, previousEpoch);
  input.pipeline.error = 'install-retained failed';
  assert.equal(estimate(input).percent, 0);
  assert.match(estimate(input).status, /failed/);
});

test('100% requires launcher-confirmed HEN startup, not pipeline verification or an intermediate record', () => {
  const input = acquiring();
  input.pipeline.stages.push({name: 'Connect to the RO frontend', status: 'complete'});
  input.pipeline.verified = true;
  input.hen = {operation: 10, result: 0};
  assert.equal(estimate(input).percent, 98);
  input.henStarted = true;
  assert.equal(estimate(input).percent, 100);
  assert.match(estimate(input).status, /verified/);
});

async function fixture(t) {
  const run = await fs.mkdtemp(path.join(os.tmpdir(), 'kaihen-progress-'));
  t.after(() => fs.rm(run, {recursive: true, force: true}));
  const folder = path.join(run, 'switch2');
  await fs.mkdir(path.join(folder, 'memory'), {recursive: true});
  const put = (name, value) => fs.writeFile(path.join(folder, name), JSON.stringify(value));
  return {run, folder, put};
}

test('reader follows only its assigned run and ignores an old acquisition report during a retry', async t => {
  const {run, folder, put} = await fixture(t);
  const input = acquiring();
  await put('pipeline.json', input.pipeline);
  await put('acquisition-supervisor.json', input.supervisor);
  const reportPath = path.join(folder, 'memory', 'first.json');
  await put('current-acquisition.json', {report: reportPath});
  await put('memory/first.json', {...input.report, markerSelected: true});
  assert.equal(estimate(await readSnapshot(run)).percent, 45);
  input.supervisor.attempts.push({attempt: 2, started: '2026-11-15T01:01:00Z'});
  await put('acquisition-supervisor.json', input.supervisor);
  assert.deepEqual((await readSnapshot(run)).report, {});
  // A capture retry starts a new supervisor with attempt 1. There is a short
  // interval where the old supervisor still claims its endpoint is ready.
  input.pipeline.stages.push({name: 'retained/find-metadata', status: 'failed'},
    {name: 'FS read, write and restoration (capture retry)', status: 'running',
      started: '2026-11-15T01:02:00Z'});
  await put('pipeline.json', input.pipeline);
  await put('acquisition-supervisor.json', {...input.supervisor, stage: 'memory-ready'});
  const fallback = estimate(await readSnapshot(run));
  assert.equal(fallback.phase, 2);
  assert.equal(fallback.percent, 0);
  await put('current-acquisition.json', {report: path.join(run, '..', 'unrelated.json')});
  assert.deepEqual((await readSnapshot(run)).report, {});
});

test('missing, partial and null reports do not crash or report success', async t => {
  const {run, put} = await fixture(t);
  assert.equal(estimate(await readSnapshot(run)).percent, 0);
  await fs.writeFile(path.join(run, 'switch2', 'pipeline.json'), '{"stages":');
  assert.equal(estimate(await readSnapshot(run)).percent, 0);
  await put('pipeline.json', null);
  assert.equal(estimate(await readSnapshot(run)).percent, 0);
  await put('memory/nulls.json', {started: '2026-11-15T01:00:01Z',
    control: null, memoryControl: null, retainedMemory: null, retryBatches: null});
  await put('current-acquisition.json', {report: path.join(run, 'switch2/memory/nulls.json')});
  assert.ok(estimate(await readSnapshot(run)).percent < 100);
});

test('observed run folder starts monitoring without consuming the RO-ready notification', async () => {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  const seen = [];
  const output = observe(child, line => seen.push(line));
  const ready = output.waitFor('RO frontend verified');
  child.stdout.write('Run folder: /tmp/one-run\nRO frontend verified\n');
  await ready;
  assert.deepEqual(seen, ['Run folder: /tmp/one-run', 'RO frontend verified']);
  assert.deepEqual(output.seen, seen);
  child.stdout.end();
});

test('reporter stops on failure/success and never emits stale polling results afterward', async t => {
  const {run} = await fixture(t);
  let output = '';
  const progress = createProgress({stream: {write: text => {output += text;}}, interval: 5});
  progress.start(run);
  progress.fail(new Error('connection reset'));
  const afterFail = output;
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(output, afterFail);
  assert.match(output, /~0%.*failed; progress reset/);
  output = '';
  const success = createProgress({stream: {write: text => {output += text;}}, interval: 5});
  success.start(run);
  success.succeed();
  success.fail(new Error('game closed after success'));
  assert.match(output, /~100%.*HEN started \(verified\)/);
  assert.doesNotMatch(output, /failed; progress reset/);
});

test('terminal control characters in checkpoints cannot alter the display', () => {
  const input = acquiring();
  input.report.control = {checkpoint: '\x1b[2Junsafe\ncheckpoint'};
  assert.doesNotMatch(format(estimate(input)), /\x1b|\n/);
});

test('launcher integration: opt-in progress follows the spawned run and confirms HEN without hardware', async t => {
  const {run: directory} = await fixture(t);
  await fs.mkdir(path.join(directory, 'lib'));
  await fs.copyFile(path.join(__dirname, 'hen.cjs'), path.join(directory, 'hen.cjs'));
  await fs.copyFile(path.join(__dirname, 'lib/progress.cjs'), path.join(directory, 'lib/progress.cjs'));
  const ship = path.join(directory, 'ship');
  for (const file of ['ro/main', 'hen/main', 'game/main', 'bootstrap.bin', 'hbmenu.nro']) {
    await fs.mkdir(path.dirname(path.join(ship, file)), {recursive: true});
    await fs.writeFile(path.join(ship, file), 'fixture');
  }
  await fs.writeFile(path.join(directory, 'run.cjs'), `
    const fs = require('node:fs'), path = require('node:path');
    const mode = process.env.PROGRESS_SIMULATION_MODE;
    const run = fs.mkdtempSync(path.join(__dirname, 'fixture-run-'));
    fs.mkdirSync(path.join(run, 'switch2/ro'), {recursive:true});
    fs.writeFileSync(path.join(run, 'result.json'), JSON.stringify({verified:mode !== 'frontend-failure',
      rpc:{state:'listening'}, ro:{retainedEndpoint:{ready:true}}}));
    fs.writeFileSync(path.join(run, 'switch2/pipeline.json'), JSON.stringify({stages:[
      {name:'FS read, write and restoration',status:'running'}]}));
    fs.writeFileSync(path.join(run, 'switch2/ro/start-hen.cjs'),
      mode === 'startup-failure'
        ? 'exports.main = async () => {require("node:fs").writeFileSync(__dirname + "/hen-startup.json", JSON.stringify({operation:10,result:0,gateRestoreResult:123})); throw Error("simulated startup restoration failure");};'
        : 'exports.main = async () => ({pid:210,file:"fixture-startup.json"});');
    console.log('Run folder: ' + run);
    console.log('fixture console output');
    setTimeout(() => console.log('RO frontend verified'), 120);
    setTimeout(() => process.exit(0), 250);
  `);
  for (const mode of ['success', 'frontend-failure', 'startup-failure']) {
    for (const enabled of [false, true]) {
      const args = [path.join(directory, 'hen.cjs'), '192.168.2.118', '--dir', ship,
        '--no-programs', ...(enabled ? ['--progress'] : [])];
      const result = spawnSync(process.execPath, args, {encoding: 'utf8', timeout: 5000,
        env: {...process.env, PROGRESS_SIMULATION_MODE: mode}});
      assert.equal(result.status, mode === 'success' ? 0 : 1, result.stderr);
      assert.match(result.stdout, /fixture console output/);
      if (mode === 'success') assert.match(result.stdout, /HEN is running/);
      else assert.doesNotMatch(result.stdout, /HEN is running/);
      if (enabled) {
        assert.match(result.stderr, /Milestone estimates/);
        if (mode === 'success') assert.match(result.stderr, /~100%.*HEN started \(verified\)/);
        else {
          assert.doesNotMatch(result.stderr, /~100%/);
          assert.match(result.stderr, /~0%.*failed; progress reset/);
        }
      } else {
        assert.doesNotMatch(result.stderr, /\[progress\]/);
        if (mode === 'success') assert.equal(result.stderr, '');
      }
    }
  }
});
