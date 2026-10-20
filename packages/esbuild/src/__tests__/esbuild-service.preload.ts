import { initialize } from 'esbuild';

// When a test times out, bun test kills the processes that the tests and
// hooks of its file have spawned. Started here, before any test, the esbuild
// service is not one of them: a timed-out test loses only its own processes,
// and the tests after it can still build.
await initialize({});
