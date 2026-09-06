import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";
import { CONFIG_DEFAULTS } from "../src/configDefaults";
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
