import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);

// helper/native/launch.ts
import { createHash as createHash2 } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, lstatSync as lstatSync2, mkdirSync as mkdirSync2, mkdtempSync, readFileSync as readFileSync3, realpathSync, renameSync as renameSync2, rmSync as rmSync2, writeFileSync as writeFileSync2 } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname as dirname2, join as join3 } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// helper/native/native-runtime.ts
import { randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
var SUPPORTED_NATIVE_VERSIONS = /* @__PURE__ */ new Set(["2.1.299"]);
var NATIVE_SELECTION_REPAIR = "Run /rice-models setup native <absolute path to a qualified Claude executable>.";
var NativeSelectionError = class extends Error {
  code = "RICE_NATIVE_SELECTION";
};
function selectionPath(configDir) {
  return join(configDir, "rice-multi-models", "native-launcher.json");
}
function absoluteNativePath(value) {
  return isAbsolute(value) && !/[\0\r\n]/.test(value);
}
function regularSelection(path) {
  const info = lstatSync(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 16 * 1024) {
    throw new NativeSelectionError(`Native launcher selection is not a regular bounded file. ${NATIVE_SELECTION_REPAIR}`);
  }
}
function readSelection(configDir) {
  const path = selectionPath(configDir);
  try {
    regularSelection(path);
  } catch (error) {
    if (error.code === "ENOENT") return void 0;
    throw new NativeSelectionError(`Cannot read the saved native Claude selection. ${NATIVE_SELECTION_REPAIR}`);
  }
  try {
    const value = JSON.parse(readFileSync(path, "utf8"));
    if (value?.format !== 1 || typeof value.executable !== "string" || !absoluteNativePath(value.executable) || typeof value.claudeVersion !== "string" || !SUPPORTED_NATIVE_VERSIONS.has(value.claudeVersion)) throw new Error("invalid selection");
    return { format: 1, executable: value.executable, claudeVersion: value.claudeVersion };
  } catch {
    throw new NativeSelectionError(`The saved native Claude selection is invalid or unsupported. ${NATIVE_SELECTION_REPAIR}`);
  }
}
function saveSelection(configDir, selection) {
  if (!absoluteNativePath(selection.executable) || !SUPPORTED_NATIVE_VERSIONS.has(selection.claudeVersion)) {
    throw new NativeSelectionError(`Refused an unqualified native Claude selection. ${NATIVE_SELECTION_REPAIR}`);
  }
  const path = selectionPath(configDir);
  mkdirSync(dirname(path), { recursive: true, mode: 448 });
  try {
    regularSelection(path);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const temporary = `${path}.${process.pid}-${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(selection, null, 2)}
`, { flag: "wx", mode: 384 });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

// helper/native/state.ts
import { readFileSync as readFileSync2 } from "node:fs";
import { createHash } from "node:crypto";
import { join as join2 } from "node:path";

// hooks/config.ts
var REQUEST_KEYS = ["params", "effort", "cache", "headers"];
var MODEL_KEYS = ["kind", "contextWindow", "maxInputTokens", "maxOutputTokens", "tools", "vision", ...REQUEST_KEYS];
var MAX_TIMEOUT_MS = 2 ** 31 - 1;

// helper/native/ownership.ts
var record = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
var UNOWNED = Object.freeze({ unowned: true });

// helper/core/executable.ts
var MAX_SHIM_SIZE = 32 * 1024;

// helper/provider-catalog.ts
var MAX_BYTES = 4 * 1024 * 1024;

// helper/native/state.ts
function approvalStore(configDir) {
  const id = "rice-multi-models@inline";
  return join2(configDir, "plugins/store", `rice-multi-models_inline-${createHash("sha256").update(id).digest("hex").slice(0, 12)}.json`);
}
function resumedModel(args, configDir) {
  const index = args.indexOf("--resume");
  const id = index >= 0 ? args[index + 1] : args.find((arg) => arg.startsWith("--resume="))?.slice("--resume=".length);
  if (!id || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(id)) return void 0;
  try {
    const store = JSON.parse(readFileSync2(approvalStore(configDir), "utf8"));
    const owner = record(store) ? store[`native-session:${id}`] : void 0;
    return record(owner) && owner.version === 1 && typeof owner.model === "string" && owner.model.length <= 1024 ? owner.model : void 0;
  } catch (error) {
    if (record(error) && error.code === "ENOENT") return void 0;
    throw new Error("native session ownership could not be read");
  }
}

// helper/native/launch.ts
function bootstrap(bundle) {
  if (process.platform === "win32") throw new Error("native adapter launcher requires a verified macOS or Linux Claude executable");
  const uid = process.getuid();
  const base = /\s/.test(tmpdir()) ? "/tmp" : tmpdir();
  const directory = join3(base, `rice-multi-models-${uid}`);
  mkdirSync2(directory, { recursive: true, mode: 448 });
  const info = lstatSync2(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== uid || (info.mode & 63) !== 0) throw new Error("unsafe native bootstrap directory");
  const source = `await import(${JSON.stringify(pathToFileURL(bundle).href)});
`;
  const hash = createHash2("sha256").update(source).update(readFileSync3(bundle)).digest("hex");
  const path = join3(directory, `${hash}.mjs`);
  try {
    writeFileSync2(path, source, { flag: "wx", mode: 384 });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    const existing = lstatSync2(path);
    if (!existing.isFile() || existing.isSymbolicLink() || existing.uid !== uid || (existing.mode & 63) !== 0 || readFileSync3(path, "utf8") !== source) throw new Error("unsafe native bootstrap file");
  }
  return path;
}
async function launch(args) {
  if (Number(process.versions.node.split(".")[0]) < 22) throw new Error("rice-multi-models launcher requires Node 22+");
  const dist = dirname2(fileURLToPath(import.meta.url));
  const plugin = dirname2(dist);
  const installing = args[0] === "--install";
  const explicit = installing ? args[1] : void 0;
  if (installing && (args.length > 2 || explicit !== void 0 && !absoluteNativePath(explicit))) {
    throw new NativeSelectionError("Usage: --install [absolute path to a qualified Claude executable]");
  }
  const directory = join3(homedir(), ".local/bin"), path = join3(directory, "rice-claude");
  if (installing) {
    if (process.platform === "win32") throw new Error("native adapter installation requires macOS or Linux");
    try {
      const existing = lstatSync2(path);
      if (!existing.isFile() || existing.isSymbolicLink() || !readFileSync3(path, "utf8").startsWith("#!/usr/bin/env node\n// rice-multi-models installed launcher\n")) throw new Error("rice-claude already exists and is not this mod's managed launcher");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  const configDir = process.env.CLAUDE_CONFIG_DIR ?? join3(homedir(), ".claude");
  const override = explicit ?? process.env.RICE_CLAUDE_EXECUTABLE;
  const saved = override ? void 0 : readSelection(configDir);
  const native = override || saved?.executable || "claude";
  const preload = bootstrap(join3(dist, "native.mjs"));
  const environment = {
    ...process.env,
    BUN_OPTIONS: `${process.env.BUN_OPTIONS ?? ""} --preload ${preload}`.trim(),
    // This native flag emits request-class and caller headers. They are consumed
    // in process and never forwarded to a different provider; no gateway exists.
    CLAUDE_CODE_GATEWAY_HINT_HEADERS: "1"
  };
  delete environment.RICE_MULTI_MODELS_NATIVE_ACTIVE;
  delete environment.RICE_MULTI_MODELS_NATIVE_STATE;
  const modelIndex = args.indexOf("--model");
  let model = modelIndex >= 0 ? args[modelIndex + 1] : args.find((arg) => arg.startsWith("--model="))?.slice("--model=".length);
  if (!model) {
    model = resumedModel(args, environment.CLAUDE_CONFIG_DIR ?? join3(homedir(), ".claude"));
    if (model) args = ["--model", model, ...args];
  }
  if (model) environment.RICE_MULTI_MODELS_INITIAL_MODEL = model;
  else delete environment.RICE_MULTI_MODELS_INITIAL_MODEL;
  const verification = mkdtempSync(join3(dirname2(preload), "verify-"));
  const handshake = join3(verification, "ready.json");
  let selection;
  try {
    const probe = spawnSync(native, ["--version"], { env: { ...environment, RICE_MULTI_MODELS_HANDSHAKE: handshake }, encoding: "utf8", timeout: 15e3 });
    const version = probe.stdout?.match(/^(\d+\.\d+\.\d+)\s/m)?.[1];
    let ready;
    try {
      ready = JSON.parse(readFileSync3(handshake, "utf8"));
    } catch {
    }
    if (probe.status !== 0 || ready?.version !== "1" || ready.native !== true || ready.pid !== probe.pid || !ready.executable) {
      throw new NativeSelectionError(`The selected native Claude executable is unavailable or its adapter could not activate. ${NATIVE_SELECTION_REPAIR}`);
    }
    if (!version || !SUPPORTED_NATIVE_VERSIONS.has(version)) throw new NativeSelectionError(`Claude ${version ?? "unknown"} has not passed the native adapter compatibility proof; supported: ${[...SUPPORTED_NATIVE_VERSIONS].join(", ")}. ${NATIVE_SELECTION_REPAIR}`);
    environment.RICE_MULTI_MODELS_NATIVE_EXECUTABLE = ready.executable;
    selection = { format: 1, executable: ready.executable, claudeVersion: version };
  } finally {
    rmSync2(verification, { recursive: true, force: true });
  }
  if (installing) {
    mkdirSync2(directory, { recursive: true });
    const temporary = join3(directory, `.rice-claude-${crypto.randomUUID()}`);
    try {
      writeFileSync2(temporary, readFileSync3(join3(dist, "entry.mjs")), { flag: "wx", mode: 493 });
      chmodSync(temporary, 493);
      renameSync2(temporary, path);
    } finally {
      rmSync2(temporary, { force: true });
    }
    saveSelection(configDir, selection);
    process.stdout.write(`Installed rice-claude in ${directory}. Saved verified Claude ${selection.claudeVersion} at ${selection.executable} in ${selectionPath(configDir)}. Start new sessions with rice-claude; no executable override is needed. The official Claude executable and updater remain intact.
`);
    return 0;
  }
  const child = spawn(selection.executable, ["--plugin-dir", plugin, ...args], { env: environment, stdio: "inherit" });
  const signals = ["SIGINT", "SIGTERM", "SIGHUP"];
  const forward = (signal) => child.kill(signal);
  const handlers = signals.map((signal) => () => forward(signal));
  for (let index = 0; index < signals.length; index++) process.on(signals[index], handlers[index]);
  try {
    return await new Promise((resolve2, reject) => {
      child.once("error", () => reject(new Error("official Claude executable could not be started")));
      child.once("exit", (code, signal) => resolve2(code ?? (signal === "SIGINT" ? 130 : 1)));
    });
  } finally {
    for (let index = 0; index < signals.length; index++) process.off(signals[index], handlers[index]);
  }
}
if (process.argv[1] && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])) {
  process.exitCode = await launch(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`rice-multi-models: ${error instanceof Error ? error.message : "native launcher failed"}
`);
    return 1;
  });
}
export {
  bootstrap,
  launch
};
