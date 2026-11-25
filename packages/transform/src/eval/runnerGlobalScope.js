/* eslint-disable no-unused-vars, @typescript-eslint/no-unused-vars */
// Functions of eval.globals, and functions returned by overrideContext, are
// restored by a direct eval in the scope of this module. Besides the global
// names of the runner process, they see the Node.js modules imported below,
// under these names, and nothing of the runner itself. The imports are unused
// here on purpose: they are the scope.
import fs from 'node:fs';
import { Console } from 'node:console';
import { Writable } from 'node:stream';
import vm from 'node:vm';
import path from 'node:path';
import NativeModule, { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

// eslint-disable-next-line no-eval, import/prefer-default-export
export const evaluateGlobalFunction = (source) => eval(`(${source})`);
