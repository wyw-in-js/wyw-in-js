// Preloaded into the eval runner process with `--require`. When the process
// exits it writes to stderr which of the watched packages were loaded, as
// `LOADED ["name", ...]`. The write is synchronous because nothing
// asynchronous runs after the `exit` event.
const fs = require('fs');

const WATCHED_PACKAGES = ['debug', 'find-up'];

const isFileOfPackage = (file, name) =>
  file.replace(/\\/g, '/').includes(`/node_modules/${name}/`);

process.on('exit', () => {
  const files = Object.keys(require.cache);
  const loaded = WATCHED_PACKAGES.filter((name) =>
    files.some((file) => isFileOfPackage(file, name))
  );
  fs.writeSync(2, `LOADED ${JSON.stringify(loaded)}\n`);
});
