import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";
import { CONFIG_DEFAULTS, SHADOW_TEXT_SETTINGS } from "../src/configDefaults";
import { LOG_LEVELS } from "../src/log";
import { projectRoot } from "./notebookFixture";

/**
 * Every setting exists twice: declared in `package.json` for the settings UI, and read
 * back with a fallback in `readConfig`. VS Code returns the declared default when the
 * user has not set the value, so the fallback is normally invisible - which is exactly
 * why a drift between the two survives manual testing and only shows up as the settings
 * UI advertising one value while the extension quietly uses another.
 */

const SETTING_PREFIX = "scalaNotebook.";

interface ContributedProperty {
  default?: unknown;
  enum?: string[];
}

interface PackageManifest {
  contributes: { configuration: { properties: Record<string, ContributedProperty> } };
}

const manifest = JSON.parse(
  fs.readFileSync(path.join(projectRoot, "package.json"), "utf8")
) as PackageManifest;
const contributed = manifest.contributes.configuration.properties;

const declaredDefaults = new Map(
  Object.entries(contributed).map(([key, property]) => [key.slice(SETTING_PREFIX.length), property.default])
);

test("every contributed setting is namespaced and read by readConfig", () => {
  for (const key of Object.keys(contributed)) {
    assert.ok(key.startsWith(SETTING_PREFIX), `${key} is not under ${SETTING_PREFIX}`);
  }
  assert.deepEqual([...declaredDefaults.keys()].sort(), Object.keys(CONFIG_DEFAULTS).sort());
});

test("package.json's declared defaults match the fallbacks readConfig uses", () => {
  for (const [name, declared] of declaredDefaults) {
    assert.deepEqual(
      declared,
      CONFIG_DEFAULTS[name as keyof typeof CONFIG_DEFAULTS],
      `default for ${SETTING_PREFIX}${name} differs between package.json and CONFIG_DEFAULTS`
    );
  }
});

test("logLevel's default is one the extension can actually parse", () => {
  assert.deepEqual(contributed[`${SETTING_PREFIX}logLevel`].enum, LOG_LEVELS);
  assert.ok(LOG_LEVELS.includes(CONFIG_DEFAULTS.logLevel));
});

/**
 * `SHADOW_TEXT_SETTINGS` is what decides whether changing a setting rewrites the shadows
 * already on disk. A setting wrongly left out of it does not fail anywhere - it just
 * quietly stops taking effect until the user's next keystroke in a cell, which is the bug
 * the list was added to fix. So the settings that genuinely feed the transform are named
 * here, independently of how the list is built.
 */
const SETTINGS_THAT_CHANGE_THE_SHADOW = [
  "scalaVersion",
  "mvnDeps",
  "preamble",
  "almondVersion",
  "ammoniteVersion",
  "shadowDir",
];

test("every setting the transform reads forces a rewrite when it changes", () => {
  for (const name of SETTINGS_THAT_CHANGE_THE_SHADOW) {
    assert.ok(
      (SHADOW_TEXT_SETTINGS as readonly string[]).includes(name),
      `${SETTING_PREFIX}${name} changes the shadow's text but would not rewrite it`
    );
  }
});

test("settings that only affect runtime behaviour do not force a rewrite", () => {
  // Each is read at the point it is used, so rewriting every shadow would be pure cost -
  // and for logLevel it would mean a compile on every change of log verbosity.
  for (const name of ["logLevel", "completionResolveCount", "codeActionResolveCount", "debounceMs", "compileOnSave"]) {
    assert.ok(
      !(SHADOW_TEXT_SETTINGS as readonly string[]).includes(name),
      `${SETTING_PREFIX}${name} does not change the shadow's text but would rewrite it`
    );
  }
});

test("SHADOW_TEXT_SETTINGS names only settings that exist", () => {
  for (const name of SHADOW_TEXT_SETTINGS) {
    assert.ok(declaredDefaults.has(name), `${SETTING_PREFIX}${name} is not a contributed setting`);
  }
});
