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
  codeActionResolveCount: 16,
  scalaVersion: "3.7.2",
  mvnDeps: [],
  preamble: [],
  almondVersion: "0.14.5",
  ammoniteVersion: "3.0.8",
  shadowDir: "notebook-shadow",
  debounceMs: 400,
  compileOnSave: true,
};

/**
 * The settings that change nothing about what a shadow script *contains*, and so need no
 * rewrite when they change - they are read at the point they are used instead.
 *
 * Kept as an exclusion rather than the inclusion list it could be, because the two fail
 * differently. A setting added later and forgotten here costs one needless regenerate;
 * forgotten in an inclusion list it would simply never take effect, which is the bug this
 * exists to fix. `SHADOW_TEXT_SETTINGS` derives the inclusion from `CONFIG_DEFAULTS`, so a
 * new setting joins it on its own.
 */
const NON_SHADOW_TEXT_SETTINGS: ReadonlySet<keyof ExtensionConfig> = new Set([
  "logLevel",
  "completionResolveCount",
  "codeActionResolveCount",
  "debounceMs",
  "compileOnSave",
]);

/** The settings whose change means every shadow script has to be written again. */
export const SHADOW_TEXT_SETTINGS: readonly (keyof ExtensionConfig)[] = (
  Object.keys(CONFIG_DEFAULTS) as (keyof ExtensionConfig)[]
).filter((key) => !NON_SHADOW_TEXT_SETTINGS.has(key));
