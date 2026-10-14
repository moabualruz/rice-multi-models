import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);

// helper/native/launch.ts
import { createHash as createHash2 } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync as readFileSync2, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join as join2 } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// helper/native/state.ts
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";

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
  return join(configDir, "plugins/store", `rice-multi-models_inline-${createHash("sha256").update(id).digest("hex").slice(0, 12)}.json`);
}
function resumedModel(args, configDir) {
  const index = args.indexOf("--resume");
  const id = index >= 0 ? args[index + 1] : args.find((arg) => arg.startsWith("--resume="))?.slice("--resume=".length);
  if (!id || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(id)) return void 0;
  try {
    const store = JSON.parse(readFileSync(approvalStore(configDir), "utf8"));
    const owner = record(store) ? store[`native-session:${id}`] : void 0;
    return record(owner) && owner.version === 1 && typeof owner.model === "string" && owner.model.length <= 1024 ? owner.model : void 0;
  } catch (error) {
    if (record(error) && error.code === "ENOENT") return void 0;
    throw new Error("native session ownership could not be read");
  }
}

// helper/native/launch.ts
var SUPPORTED = /* @__PURE__ */ new Set(["2.1.299"]);
function bootstrap(bundle) {
  if (process.platform === "win32") throw new Error("native adapter launcher requires a verified macOS or Linux Claude executable");
  const uid = process.getuid();
  const base = /\s/.test(tmpdir()) ? "/tmp" : tmpdir();
  const directory = join2(base, `rice-multi-models-${uid}`);
  mkdirSync(directory, { recursive: true, mode: 448 });
  const info = lstatSync(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== uid || (info.mode & 63) !== 0) throw new Error("unsafe native bootstrap directory");
  const source = `await import(${JSON.stringify(pathToFileURL(bundle).href)});
`;
  const hash = createHash2("sha256").update(source).update(readFileSync2(bundle)).digest("hex");
  const path = join2(directory, `${hash}.mjs`);
  try {
    writeFileSync(path, source, { flag: "wx", mode: 384 });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    const existing = lstatSync(path);
    if (!existing.isFile() || existing.isSymbolicLink() || existing.uid !== uid || (existing.mode & 63) !== 0 || readFileSync2(path, "utf8") !== source) throw new Error("unsafe native bootstrap file");
  }
  return path;
}
async function launch(args) {
  if (Number(process.versions.node.split(".")[0]) < 22) throw new Error("rice-multi-models launcher requires Node 22+");
  const dist = dirname(fileURLToPath(import.meta.url));
  const plugin = dirname(dist);
  if (args.length === 1 && args[0] === "--install") {
    if (process.platform === "win32") throw new Error("native adapter installation requires macOS or Linux");
    const directory2 = join2(homedir(), ".local/bin"), path = join2(directory2, "rice-claude");
    mkdirSync(directory2, { recursive: true });
    try {
      const existing = lstatSync(path);
      if (!existing.isFile() || existing.isSymbolicLink() || !readFileSync2(path, "utf8").startsWith("#!/usr/bin/env node\n// rice-multi-models installed launcher\n")) throw new Error("rice-claude already exists and is not this mod's managed launcher");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    const temporary = join2(directory2, `.rice-claude-${crypto.randomUUID()}`);
    try {
      writeFileSync(temporary, readFileSync2(join2(dist, "entry.mjs")), { flag: "wx", mode: 493 });
      chmodSync(temporary, 493);
      renameSync(temporary, path);
    } finally {
      rmSync(temporary, { force: true });
    }
    process.stdout.write(`Installed rice-claude in ${directory2}. Start new sessions with rice-claude; the official Claude executable and updater remain intact.
`);
    return 0;
  }
  const native = process.env.RICE_CLAUDE_EXECUTABLE || "claude";
  const preload = bootstrap(join2(dist, "native.mjs"));
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
    model = resumedModel(args, environment.CLAUDE_CONFIG_DIR ?? join2(homedir(), ".claude"));
    if (model) args = ["--model", model, ...args];
  }
  if (model) environment.RICE_MULTI_MODELS_INITIAL_MODEL = model;
  else delete environment.RICE_MULTI_MODELS_INITIAL_MODEL;
  const directory = mkdtempSync(join2(dirname(preload), "verify-"));
  const handshake = join2(directory, "ready.json");
  try {
    const probe = spawnSync(native, ["--version"], { env: { ...environment, RICE_MULTI_MODELS_HANDSHAKE: handshake }, encoding: "utf8", timeout: 15e3 });
    const version = probe.stdout?.match(/^(\d+\.\d+\.\d+)\s/m)?.[1];
    let ready;
    try {
      ready = JSON.parse(readFileSync2(handshake, "utf8"));
    } catch {
    }
    if (probe.status !== 0 || ready?.version !== "1" || ready.native !== true || ready.pid !== probe.pid || !ready.executable) throw new Error("native adapter did not activate in the official Claude executable");
    if (!version || !SUPPORTED.has(version)) throw new Error(`Claude ${version ?? "unknown"} has not passed the native adapter compatibility proof; supported: ${[...SUPPORTED].join(", ")}`);
    environment.RICE_MULTI_MODELS_NATIVE_EXECUTABLE = ready.executable;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
  const child = spawn(native, ["--plugin-dir", plugin, ...args], { env: environment, stdio: "inherit" });
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
