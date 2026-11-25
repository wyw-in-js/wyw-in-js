// The entry of the eval runner process: it owns stdin, stdout, the host
// console and the exit, and hands every protocol message to the runner core.
import { Console } from 'node:console';
// The lint resolver does not read package `exports`; Node resolves it.
// eslint-disable-next-line import/no-unresolved
import { createWriteQueue } from '@wyw-in-js/shared/eval';

// The runner runs as plain ESM in Node, which needs the file extension.
// eslint-disable-next-line import/extensions
import { createEvalRunner, createPrefixStream } from './runner.js';

const NOOP = () => {};

const writeStderr = (text, callback) => process.stderr.write(text, callback);

const hostStdout = createPrefixStream(
  () => '[wyw-runner:host stdout] ',
  writeStderr
);

// require'd modules outside vm use host console — must not write to stdout (IPC channel).
global.console = new Console({
  stdout: hostStdout,
  stderr: createPrefixStream(() => '[wyw-runner:host stderr] ', writeStderr),
});

// Only the protocol writes to the real stdout, through this saved write.
// Evaluated and host code can still reach process.stdout: require('process')
// returns the real process, and require('console') the original console of
// Node. Their output goes to stderr like the host console output.
const writeProtocolStdout = process.stdout.write.bind(process.stdout);
process.stdout.write = (chunk, encoding, callback) =>
  hostStdout.write(chunk, encoding, callback);

const keepAlive = setInterval(() => {}, 60_000);

let stdoutWriteFailed = false;
let shutdownFinished = false;
// Created below, once the frames it sends have a way out.
let runner = null;

const finishShutdown = (exitCode = 0) => {
  if (shutdownFinished) {
    return;
  }

  shutdownFinished = true;
  clearInterval(keepAlive);
  runner?.teardown();
  process.exit(exitCode);
};

// Frames go out one at a time through the saved write of the real stdout,
// while the stream events come from process.stdout itself.
const stdoutWriteQueue = createWriteQueue(
  {
    off: (event, listener) => process.stdout.off(event, listener),
    once: (event, listener) => process.stdout.once(event, listener),
    write: (chunk, callback) => writeProtocolStdout(chunk, callback),
  },
  'eval runner stdout'
);

const onStdoutWriteFailed = (error) => {
  if (stdoutWriteFailed) {
    return;
  }

  stdoutWriteFailed = true;
  process.stderr.write(`[wyw-eval-runner] ${error.message}\n`);
  finishShutdown(1);
};

const sendMessage = (message) => {
  stdoutWriteQueue
    .write(`${JSON.stringify(message)}\n`)
    .catch(onStdoutWriteFailed);
};

// Exits once every frame is written. A failed write exits through
// onStdoutWriteFailed instead.
const shutdown = () => {
  stdoutWriteQueue.onIdle().then(() => finishShutdown(0), NOOP);
};

runner = createEvalRunner({
  send: sendMessage,
  writeStderr,
  env: process.env,
});

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.resume();
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  const lines = buffer.split('\n');
  buffer = lines.pop() ?? '';
  lines.forEach((line) => {
    if (!line.trim()) return;
    const message = runner.parseStdinMessage(line);
    if (message) runner.handleMessage(message);
  });
});

process.stdin.on('close', shutdown);
