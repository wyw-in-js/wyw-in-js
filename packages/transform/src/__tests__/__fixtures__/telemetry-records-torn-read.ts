/**
 * Preloaded by transform.telemetry-records.torn-read.test.ts into a child
 * `bun test` of transform.telemetry-records.test.ts.
 *
 * The file reporter writes the schema line of pipeline-telemetry.jsonl when it
 * is created and the buffered records later, in one write of an async stream,
 * so a reader can find the file between the two writes or in the middle of
 * the second one. This preload makes the reads of that file meet the records
 * write in the same order every run. Reads are grouped into synchronous turns
 * (the reads between two microtask checkpoints). In the first turn in which a
 * read finds the records on disk, the first read of the turn sees only the
 * schema line, as before the write; the later reads of that turn and the reads
 * of the next turn see the schema line and the records cut inside a string,
 * as in the middle of the write; the reads of later turns see the file as it
 * is. After the tests it prints how many reads met the records write.
 */
import fs from 'fs';

import { afterAll, mock } from 'bun:test';

const TORN_FILE = 'pipeline-telemetry.jsonl';

const realReadFileSync = fs.readFileSync;

let turn = 0;
let readsInTurn = 0;
let recordsTurn: number | undefined;
let replayedReads = 0;

const nextRead = () => {
  if (readsInTurn === 0) {
    turn += 1;
    queueMicrotask(() => {
      readsInTurn = 0;
    });
  }
  readsInTurn += 1;
};

const hasRecords = (content: string) =>
  content.endsWith('\n') && content.indexOf('\n') < content.length - 1;

const replayWrite = (content: string) => {
  nextRead();
  if (recordsTurn === undefined) {
    if (!hasRecords(content)) return content;
    recordsTurn = turn;
  }

  if (turn > recordsTurn + 1) return content;

  replayedReads += 1;
  const schemaLine = content.slice(0, content.indexOf('\n') + 1);
  if (turn === recordsTurn && readsInTurn === 1) return schemaLine;
  const records = content.slice(schemaLine.length);
  return schemaLine + records.slice(0, records.indexOf(':"') + 2);
};

const readFileSync = ((...args: Parameters<typeof fs.readFileSync>) => {
  const content = realReadFileSync(...args);
  const [file] = args;
  if (
    typeof file === 'string' &&
    file.endsWith(`/${TORN_FILE}`) &&
    typeof content === 'string'
  ) {
    return replayWrite(content);
  }
  return content;
}) as typeof fs.readFileSync;

afterAll(() => {
  // eslint-disable-next-line no-console
  console.log(
    `${TORN_FILE} reads that met the records write: ${replayedReads}`
  );
});

mock.module('fs', () => ({ ...fs, readFileSync }));
