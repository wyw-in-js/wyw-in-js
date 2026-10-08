type RawSourceMapFields = {
  file: string;
  mappings: string;
  names: string[];
  sources: string[];
  version: number;
};

export type InputSourceMap = Partial<RawSourceMapFields>;

export type NormalizedInputSourceMap<T extends InputSourceMap> = Omit<
  T,
  keyof RawSourceMapFields
> &
  RawSourceMapFields;

/**
 * Turns the source map a loader receives from the previous loader into the
 * raw source map shape transform expects. String maps are not parsed and are
 * dropped, as before; missing required fields get defaults.
 */
export const normalizeInputSourceMap = <T extends InputSourceMap>(
  value: T | string | null | undefined,
  filename: string
): NormalizedInputSourceMap<T> | undefined => {
  if (typeof value === 'string' || !value) {
    return undefined;
  }

  return {
    ...value,
    file: value.file ?? filename,
    mappings: value.mappings ?? '',
    names: value.names ?? [],
    sources: value.sources ?? [],
    version: value.version ?? 3,
  };
};
