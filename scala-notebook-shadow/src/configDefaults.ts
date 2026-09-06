import type { ExtensionConfig } from "./shadowManager";

/**
 * The defaults `readConfig` falls back to when a setting is unset.
 *
 * Every one of these is also declared in `package.json` under
 * `contributes.configuration`, which is what VS Code shows in the settings UI and
 * what it hands back from `cfg.get` when the user has not overridden anything. The
 * two have to agree, and nothing in the runtime notices when they drift - a
 * mismatch just means the settings UI advertises one value and the extension uses
 * another. Keeping them here, in a module free of any VS Code import, lets
 * `configDefaults.test.ts` read `package.json` and check the pair.
 */
export const CONFIG_DEFAULTS: Readonly<ExtensionConfig> = {
  logLevel: "info",
  completionResolveCount: 30,
  scalaVersion: "3.7.2",
  mvnDeps: [],
  preamble: [],
  almondVersion: "0.14.5",
  ammoniteVersion: "3.0.8",
  shadowDir: "notebook-shadow",
  debounceMs: 400,
  compileOnCreate: false,
  compileOnSave: true,
};
