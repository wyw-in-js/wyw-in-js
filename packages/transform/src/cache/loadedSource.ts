type LoadedSource = { code: string; rawHash: string | undefined };

export class LoadedSources {
  private readonly sources = new Map<string, LoadedSource>();

  private recoveryDepth = 0;

  public preserveDuringRecovery<T>(run: () => T): T {
    this.recoveryDepth += 1;
    try {
      return run();
    } finally {
      this.recoveryDepth -= 1;
    }
  }

  public clear(): void {
    if (this.recoveryDepth === 0) this.sources.clear();
  }

  public delete(filename: string): void {
    this.sources.delete(filename);
  }

  public record(
    filename: string,
    code: string,
    rawHash: string | undefined
  ): void {
    if (this.sources.get(filename)?.code !== code) {
      this.sources.set(filename, { code, rawHash });
    }
  }

  public get(filename: string, rawHash: string): string | undefined {
    const source = this.sources.get(filename);
    return source?.rawHash === rawHash ? source.code : undefined;
  }
}
