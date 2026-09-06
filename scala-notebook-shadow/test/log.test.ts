import assert from "node:assert/strict";
import { test } from "node:test";
import { formatLogLine, isEnabled, isLogLevel, LogLevel, Logger, LogSink } from "../src/log";

function recorder(): LogSink & { lines: string[]; chunks: string[] } {
  const lines: string[] = [];
  const chunks: string[] = [];
  return { lines, chunks, appendLine: (v) => lines.push(v), append: (v) => chunks.push(v) };
}

const at = new Date(2026, 8, 5, 9, 4, 3, 7);

function loggerAt(level: LogLevel) {
  const sink = recorder();
  return { sink, log: new Logger(sink, () => level, "shadow", () => at) };
}

test("a level is written when it is at or above the threshold", () => {
  assert.equal(isEnabled("info", "error"), true);
  assert.equal(isEnabled("info", "info"), true);
  assert.equal(isEnabled("info", "debug"), false);
  assert.equal(isEnabled("trace", "trace"), true);
});

test("off suppresses every level, including errors", () => {
  for (const level of ["error", "warn", "info", "debug", "trace"] as const) {
    assert.equal(isEnabled("off", level), false);
  }
});

test("isLogLevel rejects anything not a level, so a bad setting can fall back", () => {
  assert.equal(isLogLevel("debug"), true);
  assert.equal(isLogLevel("verbose"), false);
});

test("a line carries a zero-padded timestamp, the level and the scope", () => {
  assert.equal(formatLogLine(at, "info", "shadow", "Created x"), "09:04:03.007 INFO  [shadow] Created x");
});

test("the logger writes only what the threshold allows", () => {
  const { sink, log } = loggerAt("info");
  log.error("boom");
  log.info("hello");
  log.debug("noisy");
  assert.deepEqual(sink.lines, ["09:04:03.007 ERROR [shadow] boom", "09:04:03.007 INFO  [shadow] hello"]);
});

test("a thunk is not called when its level is filtered out", () => {
  const { log } = loggerAt("info");
  let built = 0;
  log.debug(() => {
    built += 1;
    return "expensive";
  });
  assert.equal(built, 0);
  log.info(() => {
    built += 1;
    return "expensive";
  });
  assert.equal(built, 1);
});

test("scoped shares the sink and threshold but retags the lines", () => {
  const { sink, log } = loggerAt("info");
  log.scoped("language").info("relayed");
  assert.deepEqual(sink.lines, ["09:04:03.007 INFO  [language] relayed"]);
});

test("raw subprocess output passes through unchanged, and only at debug", () => {
  const quiet = loggerAt("info");
  quiet.log.raw("compiling...");
  assert.deepEqual(quiet.sink.chunks, []);

  const verbose = loggerAt("debug");
  verbose.log.raw("compiling...");
  assert.deepEqual(verbose.sink.chunks, ["compiling..."]);
});

test("enabled reports what would be written, for skipping work up front", () => {
  const { log } = loggerAt("debug");
  assert.equal(log.enabled("debug"), true);
  assert.equal(log.enabled("trace"), false);
});
