import vm from 'node:vm';

const SINGLE_REALM_PROBE =
  'typeof Object === "function" && typeof Array === "function" && ' +
  'Object.getPrototypeOf([]) === Array.prototype';

const exposesOwnIntrinsics = (win) => {
  try {
    return vm.runInContext(SINGLE_REALM_PROBE, win) === true;
  } catch {
    return false;
  }
};

/**
 * Creates the DOM window that evaluated code runs in.
 *
 * happy-dom's `Window` contextifies itself and copies the intrinsics of that
 * context (`Object`, `Array`, ...) onto the window, so literals and global
 * constructors in evaluated code come from one realm. Some runtimes do not
 * provide them that way: on StackBlitz, and under Bun, the copied values are
 * `undefined` (callstack/linaria#1345). There `GlobalWindow`, which copies the
 * host's intrinsics instead, still lets the code run, at the cost of literals
 * and global constructors coming from different realms.
 */
// eslint-disable-next-line import/prefer-default-export
export const createHappyDomWindow = ({ Window, GlobalWindow }) => {
  const win = new Window();
  if (!GlobalWindow || exposesOwnIntrinsics(win)) {
    return win;
  }

  win.happyDOM?.abort();
  return new GlobalWindow();
};
