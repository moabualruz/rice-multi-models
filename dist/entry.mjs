#!/usr/bin/env node
// rice-multi-models installed launcher
import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);

// helper/native/entry.ts
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
function installedRoot(configDir, cwd) {
  const ledger = JSON.parse(readFileSync(join(configDir, "plugins/installed_plugins.json"), "utf8"));
  const choices = Object.entries(ledger.plugins ?? {}).filter(([id]) => id.split("@")[0] === "rice-multi-models").flatMap(([, installs]) => installs).filter((install) => typeof install.installPath === "string" && isAbsolute(install.installPath) && (install.scope === "user" || install.scope === "local" || install.scope === "project") && (!install.projectPath || cwd === resolve(install.projectPath) || cwd.startsWith(resolve(install.projectPath) + sep))).sort((a, b) => (b.projectPath?.length ?? 0) - (a.projectPath?.length ?? 0));
  if (!choices[0]?.installPath) throw new Error("install rice-multi-models with Claude Code before using rice-claude");
  return choices[0].installPath;
}
try {
  const root = installedRoot(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"), process.cwd());
  const { launch } = await import(pathToFileURL(join(root, "dist/launch.mjs")).href);
  process.exitCode = await launch(process.argv.slice(2));
} catch {
  process.stderr.write("rice-multi-models: rice-claude could not start the installed native adapter; update the plugin and run /rice-models setup native\n");
  process.exitCode = 1;
}
export {
  installedRoot
};
