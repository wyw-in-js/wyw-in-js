export type OxcParserLanguage = 'dts' | 'js' | 'jsx' | 'ts' | 'tsx';

export const getOxcParserLanguage = (filename: string): OxcParserLanguage => {
  if (filename.endsWith('.jsx')) return 'jsx';
  if (filename.endsWith('.tsx')) return 'tsx';

  const basenameStart =
    Math.max(filename.lastIndexOf('/'), filename.lastIndexOf('\\')) + 1;
  if (filename.endsWith('.ts')) {
    return filename.lastIndexOf('.d.') > basenameStart ? 'dts' : 'ts';
  }

  if (filename.endsWith('.mts') || filename.endsWith('.cts')) {
    const basenameLength = filename.length - basenameStart;
    return basenameLength > 6 &&
      (filename.endsWith('.d.mts') || filename.endsWith('.d.cts'))
      ? 'dts'
      : 'ts';
  }

  return 'js';
};
