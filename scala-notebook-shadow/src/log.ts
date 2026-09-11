/**
 * A small level-filtered logger over an output channel. Deliberately free of any VS Code
 * import: `vscode.OutputChannel` satisfies `LogSink` structurally, so the whole thing is
 * unit testable with plain `node --test`, and the only part that needs the editor - noticing
 * the setting change - stays in extension.ts.
 */

export type LogLevel = "off" | "error" | "warn" | "info" | "debug" | "trace";

/** Every level a message can be written at, i.e. all of LogLevel except "off". */
export type WritableLogLevel = Exclude<LogLevel, "off">;

const SEVERITY: Record<LogLevel, number> = { off: 0, error: 1, warn: 2, info: 3, debug: 4, trace: 5 };

export const LOG_LEVELS: LogLevel[] = ["off", "error", "warn", "info", "debug", "trace"];

export function isLogLevel(value: string): value is LogLevel {
  return (LOG_LEVELS as string[]).includes(value);
}

/** Whether a message at `level` survives a `threshold` setting. */
export function isEnabled(threshold: LogLevel, level: WritableLogLevel): boolean {
  return SEVERITY[level] <= SEVERITY[threshold];
}

function twoDigits(value: number): string {
  return value.toString().padStart(2, "0");
}

export function formatLogLine(time: Date, level: WritableLogLevel, scope: string, message: string): string {
  const stamp =
    `${twoDigits(time.getHours())}:${twoDigits(time.getMinutes())}:${twoDigits(time.getSeconds())}` +
    `.${time.getMilliseconds().toString().padStart(3, "0")}`;
  return `${stamp} ${level.toUpperCase().padEnd(5)} [${scope}] ${message}`;
}

/**
 * A message, or a thunk producing one. Pass a thunk whenever building the text costs
 * anything: it is never called if the level is filtered out.
 */
export type LogMessage = string | (() => string);

export interface LogSink {
  appendLine(value: string): void;
  append(value: string): void;
}

export class Logger {
  constructor(
    private readonly sink: LogSink,
    private readonly threshold: () => LogLevel,
    private readonly scope: string = "extension",
    private readonly now: () => Date = () => new Date()
  ) {}

  /** A logger writing to the same channel under a different tag. */
  scoped(scope: string): Logger {
    return new Logger(this.sink, this.threshold, scope, this.now);
  }

  error(message: LogMessage): void {
    this.write("error", message);
  }

  warn(message: LogMessage): void {
    this.write("warn", message);
  }

  info(message: LogMessage): void {
    this.write("info", message);
  }

  debug(message: LogMessage): void {
    this.write("debug", message);
  }

  trace(message: LogMessage): void {
    this.write("trace", message);
  }

  /** True if a level would be written; for skipping work a log line would only then need. */
  enabled(level: WritableLogLevel): boolean {
    return isEnabled(this.threshold(), level);
  }

  private write(level: WritableLogLevel, message: LogMessage): void {
    if (!this.enabled(level)) {
      return;
    }
    const text = typeof message === "function" ? message() : message;
    this.sink.appendLine(formatLogLine(this.now(), level, this.scope, text));
  }
}

/**
 * Rendering an error for the log.
 *
 * Most of what this extension does is started from an event handler, a timer or a language
 * provider, none of which have a caller waiting: a rejection there becomes an unhandled
 * rejection in the *extension host* log, or is swallowed outright, and the notebook simply
 * goes without the feature with nothing saying why. These put one in the extension's own
 * channel instead.
 */
export function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The stack, for `debug`, where the message alone doesn't say where the failure came from. */
export function errorStack(error: unknown): string {
  return error instanceof Error && error.stack ? error.stack : String(error);
}

/**
 * True for the rejection VS Code raises when a `CancellationToken` passed to a command fires
 * mid-flight - its message is always the bare string "Canceled". That is the normal way a
 * request the user has already moved past ends, not a fault, so callers can use this to keep
 * it out of the noise `error`-level logging is for.
 */
export function isCancellationError(error: unknown): boolean {
  return error instanceof Error && error.message === "Canceled";
}
