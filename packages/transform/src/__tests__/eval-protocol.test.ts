// The protocol module is imported inside the tests, so that a missing export
// fails a test instead of the whole file.
const parse = async (message: unknown) => {
  const { parseRunnerMessage } = await import('../eval/protocol');
  return parseRunnerMessage(
    typeof message === 'string' ? message : JSON.stringify(message)
  );
};

describe('parseRunnerMessage', () => {
  it.each([
    ['INIT_ACK', { type: 'INIT_ACK', id: '1', modulesReset: true }],
    [
      'INIT_ACK with an error',
      {
        type: 'INIT_ACK',
        id: '1',
        error: { message: 'cannot restore', name: 'Error' },
      },
    ],
    [
      'EVAL_RESULT with evictedIds',
      {
        type: 'EVAL_RESULT',
        id: '2',
        payload: {
          values: { value: { kind: 'number', value: 1 } },
          modules: {},
          evictedIds: ['/root/entry.js'],
        },
      },
    ],
    [
      'EVAL_RESULT with an error',
      {
        type: 'EVAL_RESULT',
        id: '2',
        payload: { values: null, evictedIds: [] },
        error: { message: 'boom', name: 'TypeError' },
      },
    ],
    [
      'RESOLVE',
      {
        type: 'RESOLVE',
        id: '3',
        payload: {
          specifier: './dep',
          importerId: '/root/entry.js',
          kind: 'import',
        },
        sessionId: 1,
      },
    ],
    [
      'LOAD',
      {
        type: 'LOAD',
        id: '4',
        payload: {
          id: '/root/dep.js',
          importerId: '/root/entry.js',
          request: './dep',
        },
        sessionId: 1,
      },
    ],
    [
      'WARN with the eval-stale-module code',
      {
        type: 'WARN',
        payload: {
          code: 'eval-stale-module',
          message: 'Cached exports for this module may be stale.',
        },
      },
    ],
    [
      'WARN with a public code',
      {
        type: 'WARN',
        payload: {
          code: 'resolve-fallback',
          message: 'fallback',
          importer: '/root/entry.js',
          specifier: './dep',
        },
      },
    ],
  ])('accepts %s', async (_name, message) => {
    expect(await parse(message)).toEqual(message);
  });

  it.each([
    ['invalid JSON', 'not json'],
    ['JSON null', 'null'],
    ['a JSON array', '[]'],
    ['an unknown type', { type: 'UNKNOWN', id: '1' }],
    [
      'EVAL_RESULT without an id',
      { type: 'EVAL_RESULT', payload: { values: null } },
    ],
    ['RESOLVE without a payload', { type: 'RESOLVE', id: '3' }],
    [
      'WARN without a message',
      { type: 'WARN', payload: { code: 'resolve-error' } },
    ],
    [
      'EVAL_RESULT with a non-string evicted id',
      {
        type: 'EVAL_RESULT',
        id: '2',
        payload: { values: null, evictedIds: [1] },
      },
    ],
  ])('rejects %s', async (_name, message) => {
    expect(await parse(message)).toBeNull();
  });
});
