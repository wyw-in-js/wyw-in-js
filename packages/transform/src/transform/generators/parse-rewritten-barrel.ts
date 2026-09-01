import type { Program } from 'oxc-parser';

import { recordPipelineUncachedParse } from '../../debug/pipelineTelemetry';
import { parseOxcSync } from '../../utils/parseOxc';

export const parseRewrittenBarrel = (
  code: string,
  filename: string
): Program => {
  const astType =
    filename.endsWith('.ts') || filename.endsWith('.tsx') ? 'ts' : 'js';
  let parsed: ReturnType<typeof parseOxcSync>;
  try {
    parsed = parseOxcSync(filename, code, {
      astType,
      range: true,
      sourceType: 'module',
    });
  } catch (error) {
    recordPipelineUncachedParse(filename, code, 'module', astType, true);
    throw error;
  }
  const fatalError = parsed.errors.find((error) => error.severity === 'Error');
  if (fatalError) {
    recordPipelineUncachedParse(filename, code, 'module', astType, true);
    throw new Error(fatalError.message);
  }
  recordPipelineUncachedParse(filename, code, 'module', astType, false);

  return parsed.program as Program;
};
