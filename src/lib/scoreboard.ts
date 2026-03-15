/**
 * Command success/failure scoreboard for the session.
 * Port of CommandScoreboard + CommandStats from agent_shell.py
 */

export class CommandStats {
  successes: number;
  failures: number;

  constructor(successes = 0, failures = 0) {
    this.successes = successes;
    this.failures = failures;
  }

  record(success: boolean): void {
    if (success) {
      this.successes++;
    } else {
      this.failures++;
    }
  }

  get score(): number {
    return this.successes - this.failures;
  }

  get total(): number {
    return this.successes + this.failures;
  }

  toDict(): { successes: number; failures: number; score: number } {
    return {
      successes: this.successes,
      failures: this.failures,
      score: this.score,
    };
  }
}

export class CommandScoreboard {
  private _scores: Map<string, CommandStats> = new Map();

  static _normalize(command: string): string {
    let s = command.trim().replace(/\s+/g, " ");

    // Normalize home-relative paths (~/foo/bar → <path>) before absolute paths
    // so the ~/ prefix is consumed first.
    s = s.replace(/~\/\S*/g, "<path>");

    // Normalize absolute paths (/foo, /foo/bar/baz → <path>).
    // Requires at least one leading slash followed by a non-space char so we
    // don't accidentally match lone `-` flags or redirect operators.
    s = s.replace(/\/[^\s/][^\s]*/g, "<path>");

    // Normalize flag values (--output=<anything> → --output=<val>) so
    // --timeout=30 and --timeout=60 map to the same scoreboard key.
    s = s.replace(/(--[\w-]+=)\S+/g, "$1<val>");

    return s || command.trim();
  }

  analyze(command: string): [string, CommandStats | null] {
    const key = CommandScoreboard._normalize(command);
    const stats = this._scores.get(key);
    if (stats === undefined) return [key, null];
    return [key, new CommandStats(stats.successes, stats.failures)];
  }

  record(command: string, success: boolean): [string, CommandStats] {
    const key = CommandScoreboard._normalize(command);
    let stats = this._scores.get(key);
    if (!stats) {
      stats = new CommandStats();
      this._scores.set(key, stats);
    }
    stats.record(success);
    return [key, new CommandStats(stats.successes, stats.failures)];
  }

  statsForKey(key: string): CommandStats | null {
    const stats = this._scores.get(key);
    if (stats === undefined) return null;
    return new CommandStats(stats.successes, stats.failures);
  }
}
