import type { Program } from 'oxc-parser';

import {
  parseOxcFragmentProgramCached,
  parseOxcProgramCached,
} from '../parseOxc';

export type OxcSourceType = 'module' | 'unambiguous';

export const parseOxcProgram = (
  code: string,
  filename: string,
  sourceType: OxcSourceType = 'unambiguous'
): Program => parseOxcProgramCached(filename, code, sourceType);

// For the static expression texts of the value engine; see
// parseOxcFragmentProgramCached.
export const parseOxcFragmentProgram = (
  code: string,
  filename: string
): Program => parseOxcFragmentProgramCached(filename, code, 'unambiguous');
