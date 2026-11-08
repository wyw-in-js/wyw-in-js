/* eslint-disable max-classes-per-file */
import vm from 'vm';

import { createHappyDomWindow } from '../eval/happyDomWindow.js';

// Stand-ins for happy-dom's classes. Its `Window` contextifies itself and
// copies the intrinsics of that context onto the instance; on StackBlitz and
// under Bun the copied values are `undefined`. Its `GlobalWindow` carries the
// host's intrinsics and is not a VM context.
class ContextWindow {
  constructor() {
    vm.createContext(this);
    Object.assign(this, vm.runInContext('({ Object, Array })', this));
  }
}

class ContextWindowWithoutIntrinsics {
  happyDOM = { abort: jest.fn() };

  constructor() {
    vm.createContext(this);
    Object.assign(this, { Object: undefined, Array: undefined });
  }
}

class PlainWindow {}

class HostGlobalWindow {
  Array = Array;

  Object = Object;
}

describe('createHappyDomWindow', () => {
  it('keeps a Window whose context exposes its own intrinsics', () => {
    const win = createHappyDomWindow({
      GlobalWindow: HostGlobalWindow,
      Window: ContextWindow,
    });

    expect(win).toBeInstanceOf(ContextWindow);
  });

  it('falls back to GlobalWindow when the Window context lacks its intrinsics', () => {
    const win = createHappyDomWindow({
      GlobalWindow: HostGlobalWindow,
      Window: ContextWindowWithoutIntrinsics,
    });

    expect(win).toBeInstanceOf(HostGlobalWindow);
  });

  it('falls back to GlobalWindow when the Window is not a VM context', () => {
    const win = createHappyDomWindow({
      GlobalWindow: HostGlobalWindow,
      Window: PlainWindow,
    });

    expect(win).toBeInstanceOf(HostGlobalWindow);
  });

  it('keeps the Window when happy-dom has no GlobalWindow', () => {
    const win = createHappyDomWindow({
      Window: ContextWindowWithoutIntrinsics,
    });

    expect(win).toBeInstanceOf(ContextWindowWithoutIntrinsics);
  });

  it('aborts the Window it does not use', () => {
    const windows: ContextWindowWithoutIntrinsics[] = [];
    class TrackedWindow extends ContextWindowWithoutIntrinsics {
      constructor() {
        super();
        windows.push(this);
      }
    }

    createHappyDomWindow({
      GlobalWindow: HostGlobalWindow,
      Window: TrackedWindow,
    });

    expect(windows[0].happyDOM.abort).toHaveBeenCalled();
  });
});
