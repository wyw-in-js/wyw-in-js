import fs from 'node:fs';

import { stripQueryAndHash } from '@wyw-in-js/shared';

import { hashContent } from '../utils/contentHash';

/** The content hash of a file's bytes on disk, if they can be read. */
export const hashDiskContent = (filename: string): string | undefined => {
  try {
    return hashContent(fs.readFileSync(stripQueryAndHash(filename), 'utf8'));
  } catch {
    return undefined;
  }
};
