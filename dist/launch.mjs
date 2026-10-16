import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);

// helper/native/launch.ts
import { createHash as createHash2 } from "node:crypto";
import { spawn, spawnSync as spawnSync2 } from "node:child_process";
import { chmodSync, lstatSync as lstatSync2, mkdirSync as mkdirSync2, mkdtempSync, readFileSync as readFileSync4, realpathSync, renameSync as renameSync2, rmSync as rmSync2, writeFileSync as writeFileSync2 } from "node:fs";
import { homedir, tmpdir as tmpdir2 } from "node:os";
import { dirname as dirname3, join as join5 } from "node:path";
import { fileURLToPath, pathToFileURL as pathToFileURL2 } from "node:url";

// helper/native/native-runtime.ts
import { randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, win32 } from "node:path";
var SUPPORTED_NATIVE_VERSIONS = /* @__PURE__ */ new Set(["2.1.299"]);
var NATIVE_SELECTION_REPAIR = "Run /rice-models setup native <absolute path to a qualified Claude executable>.";
var NativeSelectionError = class extends Error {
  code = "RICE_NATIVE_SELECTION";
};
function selectionPath(configDir) {
  return join(configDir, "rice-multi-models", "native-launcher.json");
}
function absoluteNativePath(value, platform = process.platform) {
  if (/[\0\r\n]/.test(value)) return false;
  return platform === "win32" ? win32.isAbsolute(value) && (/^[A-Za-z]:[\\/]/.test(value) || /^\\\\[^\\]+\\[^\\]+/.test(value)) : isAbsolute(value);
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

// helper/native/account-cache.ts
import { existsSync, readFileSync as readFileSync3 } from "node:fs";
import { dirname as dirname2, isAbsolute as isAbsolute2, join as join3, resolve as resolve2, sep } from "node:path";
import { pathToFileURL } from "node:url";
function accountCache(configDir, cwd) {
  let ledger;
  try {
    ledger = JSON.parse(readFileSync3(join3(configDir, "plugins/installed_plugins.json"), "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return void 0;
    throw new NativeSelectionError("The installed plugin registry could not be read; repair the Rice plugin installation.");
  }
  const installs = (ledger.plugins?.["rice-session-accounts@rice-mods"] ?? []).filter((row) => typeof row.installPath === "string" && isAbsolute2(row.installPath) && ["user", "project", "local"].includes(row.scope ?? "") && (!row.projectPath || cwd === resolve2(row.projectPath) || cwd.startsWith(resolve2(row.projectPath) + sep))).sort((a, b) => (b.projectPath?.length ?? 0) - (a.projectPath?.length ?? 0));
  const root = installs[0]?.installPath;
  if (!root) return void 0;
  const cache = join3(root, "native/cache.mjs");
  if (existsSync(cache)) {
    if (!existsSync(join3(root, "native/startup.mjs"))) throw new NativeSelectionError("Rice Accounts startup support is missing; update rice-session-accounts before starting rice-claude.");
    return cache;
  }
  let version;
  try {
    version = JSON.parse(readFileSync3(join3(root, ".claude-plugin/plugin.json"), "utf8")).version;
  } catch {
    throw new NativeSelectionError("Rice Accounts is incomplete; update rice-session-accounts before starting rice-claude.");
  }
  if (typeof version === "string" && /^0\.[012]\./.test(version)) return void 0;
  throw new NativeSelectionError("Rice Accounts native cache support is missing; update rice-session-accounts before starting rice-claude.");
}
async function prepareAccounts(cache, args, environment, configDir) {
  const delimiter = args.indexOf("--");
  const selectsAccount = args.slice(0, delimiter < 0 ? void 0 : delimiter).some((arg) => arg === "--account" || arg.startsWith("--account="));
  if (!cache) {
    if (selectsAccount) throw new NativeSelectionError("The --account option requires Rice Accounts 0.3 or newer. Update rice-session-accounts, complete /rice-account setup <name>, then start rice-claude again.");
    return { args, env: environment };
  }
  try {
    const { prepareAccountLaunch } = await import(pathToFileURL(join3(dirname2(cache), "startup.mjs")).href);
    return prepareAccountLaunch(args, environment, configDir);
  } catch {
    throw new NativeSelectionError("Rice Accounts could not prepare the saved browser account. Update rice-session-accounts, complete /rice-account setup <name>, and pass --account <name> once before the Claude arguments.");
  }
}

// helper/native/windows-launcher.ts
var WINDOWS_LAUNCHER_MARKER = "@echo off\r\nrem rice-multi-models installed launcher\r\n";
function windowsLauncher(node) {
  if (!absoluteNativePath(node, "win32") || /"/.test(node)) throw new Error("the Windows launcher requires an absolute Node executable");
  const executable = node.replace(/%/g, "%%");
  return `${WINDOWS_LAUNCHER_MARKER}setlocal DisableDelayedExpansion\r
"${executable}" "%~dp0rice-claude.mjs" %*\r
exit /b %errorlevel%\r
`;
}

// helper/native/windows-bootstrap.ts
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join as join4 } from "node:path";
var WINDOWS_BOOTSTRAP_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$stage = 'identity'
try {
  $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
  $sid = $identity.User.Value
  function Assert-PrivatePath([string]$path, [bool]$directory) {
    $script:stage = 'inspect-private-path'
    $item = Get-Item -Force -LiteralPath $path
    $script:stage = 'private-path-type'
    if ($item.PSIsContainer -ne $directory) { throw 'unsafe bootstrap type' }
    $script:stage = 'private-path-reparse'
    if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'unsafe bootstrap reparse point' }
    $script:stage = 'read-private-acl'
    $sections = [System.Security.AccessControl.AccessControlSections]'Access,Owner'
    $acl = if ($directory) { [System.IO.Directory]::GetAccessControl($path, $sections) } else { [System.IO.File]::GetAccessControl($path, $sections) }
    $script:stage = 'private-path-owner'
    if ($acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $sid -or ($directory -and -not $acl.AreAccessRulesProtected)) { throw 'unsafe bootstrap owner' }
    $write = [System.Security.AccessControl.FileSystemRights]::Write -bor [System.Security.AccessControl.FileSystemRights]::Delete -bor [System.Security.AccessControl.FileSystemRights]::ChangePermissions -bor [System.Security.AccessControl.FileSystemRights]::TakeOwnership
    foreach ($rule in $acl.Access) {
      $script:stage = 'private-path-writers'
      $writer = $rule.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value
      if ($rule.AccessControlType -eq [System.Security.AccessControl.AccessControlType]::Allow -and ($rule.FileSystemRights -band $write) -ne 0 -and $writer -notin @($sid, 'S-1-5-18', 'S-1-5-32-544')) { throw 'unsafe bootstrap writer' }
    }
  }
  $stage = 'short-path-api'
  Add-Type -TypeDefinition @'
using System.Text;
using System.Runtime.InteropServices;
public static class RiceNativeBootstrapPath {
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern uint GetShortPathName(string path, StringBuilder output, uint length);
}
'@
  $security = New-Object System.Security.AccessControl.DirectorySecurity
  $security.SetAccessRuleProtection($true, $false)
  $security.SetOwner($identity.User)
  $rule = [System.Security.AccessControl.FileSystemAccessRule]::new($identity.User, [System.Security.AccessControl.FileSystemRights]::FullControl, [System.Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit', [System.Security.AccessControl.PropagationFlags]::None, [System.Security.AccessControl.AccessControlType]::Allow)
  $security.AddAccessRule($rule)
  $bases = @($env:RICE_NATIVE_BOOTSTRAP_TEMP)
  if ($env:RICE_NATIVE_BOOTSTRAP_WINDOWS) { $bases += Join-Path $env:RICE_NATIVE_BOOTSTRAP_WINDOWS 'Temp' }
  foreach ($base in $bases | Select-Object -Unique) {
    if (-not $base) { continue }
    $directory = Join-Path $base ('rice-multi-models-' + $sid)
    $existed = [System.IO.Directory]::Exists($directory)
    $stage = 'create-private-directory'
    try { [void][System.IO.Directory]::CreateDirectory($directory, $security) } catch { continue }
    Assert-PrivatePath $directory $true
    $plain = $directory
    if ($plain -match '\s') {
      $stage = 'shorten-directory'
      $buffer = New-Object System.Text.StringBuilder(32768)
      $length = [RiceNativeBootstrapPath]::GetShortPathName($directory, $buffer, [uint32]$buffer.Capacity)
      if ($length -gt 0 -and $length -lt $buffer.Capacity -and [System.IO.Directory]::Exists($buffer.ToString())) { $plain = $buffer.ToString() }
    }
    if ($plain -match '\s') {
      if (-not $existed -and [System.IO.Directory]::GetFileSystemEntries($directory).Length -eq 0) { [System.IO.Directory]::Delete($directory) }
      continue
    }
    $file = Join-Path $directory $env:RICE_NATIVE_BOOTSTRAP_FILE
    if (Test-Path -LiteralPath $file) { Assert-PrivatePath $file $false }
    $stage = 'return-private-path'
    [pscustomobject]@{directory=$plain} | ConvertTo-Json -Compress
    exit 0
  }
  throw 'no private plain bootstrap path'
} catch {
  [Console]::Error.WriteLine('Windows native bootstrap could not establish a private, space-free path. stage=' + $stage + '; class=' + $_.Exception.GetType().Name)
  exit 1
}
`;
function windowsBootstrapDirectory(filename, options = {}) {
  if (process.platform !== "win32" || !/^[a-f0-9]{64}\.mjs$/.test(filename)) throw new NativeSelectionError("Invalid Windows native bootstrap request.");
  const windowsDirectory = options.windowsDirectory ?? process.env.SystemRoot ?? process.env.WINDIR;
  const powershell = windowsDirectory ? join4(windowsDirectory, "System32/WindowsPowerShell/v1.0/powershell.exe") : "powershell.exe";
  const result = spawnSync(powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", WINDOWS_BOOTSTRAP_SCRIPT], {
    encoding: "utf8",
    timeout: 15e3,
    windowsHide: true,
    maxBuffer: 16 * 1024,
    env: { ...process.env, RICE_NATIVE_BOOTSTRAP_TEMP: options.temporaryDirectory ?? tmpdir(), RICE_NATIVE_BOOTSTRAP_WINDOWS: windowsDirectory, RICE_NATIVE_BOOTSTRAP_FILE: filename }
  });
  if (result.status === 0) {
    try {
      const value = JSON.parse(result.stdout);
      if (typeof value.directory === "string" && absoluteNativePath(value.directory) && !/\s/.test(value.directory)) return value.directory;
    } catch {
    }
  }
  const stage = result.stderr?.match(/stage=([a-z-]+)/)?.[1];
  throw new NativeSelectionError(`Windows native bootstrap needs a private, space-free temporary path${stage ? ` (stage=${stage})` : ""}. Check your user TEMP permissions, then run /rice-models setup native again.`);
}

// helper/native/launch.ts
var ENTRY_MARKER = "#!/usr/bin/env node\n// rice-multi-models installed launcher\n";
function bootstrap(bundle, cache) {
  const windows = process.platform === "win32";
  const uid = windows ? void 0 : process.getuid();
  const source = `await import(${JSON.stringify(pathToFileURL2(bundle).href)});
` + (cache ? `process.env.RICE_SESSION_ACCOUNTS_NATIVE_VERSION = '2.1.299';
await import(${JSON.stringify(pathToFileURL2(cache).href)});
` : "");
  const digest = createHash2("sha256").update(source).update(readFileSync4(bundle));
  if (cache) digest.update(readFileSync4(cache)).update(readFileSync4(join5(dirname3(cache), "startup.mjs")));
  const hash = digest.digest("hex");
  const base = /\s/.test(tmpdir2()) ? "/tmp" : tmpdir2();
  const directory = windows ? windowsBootstrapDirectory(`${hash}.mjs`) : join5(base, `rice-multi-models-${uid}`);
  if (!windows) {
    mkdirSync2(directory, { recursive: true, mode: 448 });
    const info = lstatSync2(directory);
    if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== uid || (info.mode & 63) !== 0) throw new Error("unsafe native bootstrap directory");
  }
  const path = join5(directory, `${hash}.mjs`);
  try {
    writeFileSync2(path, source, { flag: "wx", mode: 384 });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    const existing = lstatSync2(path);
    if (!existing.isFile() || existing.isSymbolicLink() || !windows && (existing.uid !== uid || (existing.mode & 63) !== 0) || readFileSync4(path, "utf8") !== source) throw new Error("unsafe native bootstrap file");
  }
  return windows ? path.replace(/\\/g, "/") : path;
}
async function launch(args) {
  if (Number(process.versions.node.split(".")[0]) < 22) throw new Error("rice-multi-models launcher requires Node 22+");
  const dist = dirname3(fileURLToPath(import.meta.url));
  const plugin = dirname3(dist);
  const installing = args[0] === "--install";
  const explicit = installing ? args[1] : void 0;
  if (installing && (args.length > 2 || explicit !== void 0 && !absoluteNativePath(explicit))) {
    throw new NativeSelectionError("Usage: --install [absolute path to a qualified Claude executable]");
  }
  const windows = process.platform === "win32";
  const directory = join5(homedir(), ".local/bin");
  const path = join5(directory, windows ? "rice-claude.cmd" : "rice-claude");
  const entry = windows ? join5(directory, "rice-claude.mjs") : path;
  const managed = [{ path: entry, marker: ENTRY_MARKER }, ...windows ? [{ path, marker: WINDOWS_LAUNCHER_MARKER }] : []];
  if (installing) {
    for (const file of managed) {
      try {
        const existing = lstatSync2(file.path);
        if (!existing.isFile() || existing.isSymbolicLink() || !readFileSync4(file.path, "utf8").replace(/\r\n/g, "\n").startsWith(file.marker.replace(/\r\n/g, "\n"))) throw new Error("rice-claude already exists and is not this mod's managed launcher");
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
  }
  const configDir = process.env.CLAUDE_CONFIG_DIR ?? join5(homedir(), ".claude");
  const override = explicit ?? process.env.RICE_CLAUDE_EXECUTABLE;
  const saved = override ? void 0 : readSelection(configDir);
  const native = override || saved?.executable || "claude";
  const cache = accountCache(configDir, process.cwd());
  const preload = bootstrap(join5(dist, "native.mjs"), cache);
  let environment = {
    ...process.env,
    BUN_OPTIONS: `${process.env.BUN_OPTIONS ?? ""} --preload ${preload}`.trim(),
    // This native flag emits request-class and caller headers. They are consumed
    // in process and never forwarded to a different provider; no gateway exists.
    CLAUDE_CODE_GATEWAY_HINT_HEADERS: "1"
  };
  delete environment.RICE_MULTI_MODELS_NATIVE_ACTIVE;
  delete environment.RICE_MULTI_MODELS_NATIVE_STATE;
  delete environment.RICE_SESSION_ACCOUNTS_NATIVE_ACTIVE;
  if (!installing) {
    const prepared = await prepareAccounts(cache, args, environment, configDir);
    args = prepared.args;
    environment = prepared.env;
  }
  const modelIndex = args.indexOf("--model");
  let model = modelIndex >= 0 ? args[modelIndex + 1] : args.find((arg) => arg.startsWith("--model="))?.slice("--model=".length);
  if (!model) {
    model = resumedModel(args, environment.CLAUDE_CONFIG_DIR ?? join5(homedir(), ".claude"));
    if (model) args = ["--model", model, ...args];
  }
  if (model) environment.RICE_MULTI_MODELS_INITIAL_MODEL = model;
  else delete environment.RICE_MULTI_MODELS_INITIAL_MODEL;
  const verification = mkdtempSync(join5(dirname3(preload), "verify-"));
  const handshake = join5(verification, "ready.json");
  let selection;
  try {
    const probe = spawnSync2(native, ["--version"], { env: { ...environment, RICE_MULTI_MODELS_HANDSHAKE: handshake }, encoding: "utf8", timeout: 15e3 });
    const version = probe.stdout?.match(/^(\d+\.\d+\.\d+)\s/m)?.[1];
    let ready;
    try {
      ready = JSON.parse(readFileSync4(handshake, "utf8"));
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
    const outputs = [{ path: entry, bytes: readFileSync4(join5(dist, "entry.mjs")) }, ...windows ? [{ path, bytes: Buffer.from(windowsLauncher(process.execPath)) }] : []];
    const temporary = outputs.map(() => join5(directory, `.rice-claude-${crypto.randomUUID()}`));
    try {
      for (let index = 0; index < outputs.length; index++) {
        writeFileSync2(temporary[index], outputs[index].bytes, { flag: "wx", mode: 493 });
        if (!windows) chmodSync(temporary[index], 493);
      }
      for (let index = 0; index < outputs.length; index++) renameSync2(temporary[index], outputs[index].path);
    } finally {
      for (const file of temporary) rmSync2(file, { force: true });
    }
    saveSelection(configDir, selection);
    process.stdout.write(`Installed ${windows ? "rice-claude.cmd" : "rice-claude"} in ${directory}. Saved verified Claude ${selection.claudeVersion} at ${selection.executable} in ${selectionPath(configDir)}. Start new sessions with rice-claude; no executable override is needed. The official Claude executable and updater remain intact.
`);
    return 0;
  }
  const child = spawn(selection.executable, ["--plugin-dir", plugin, ...args], { env: environment, stdio: "inherit" });
  const signals = ["SIGINT", "SIGTERM", "SIGHUP"];
  const forward = (signal) => child.kill(signal);
  const handlers = signals.map((signal) => () => forward(signal));
  for (let index = 0; index < signals.length; index++) process.on(signals[index], handlers[index]);
  try {
    return await new Promise((resolve3, reject) => {
      child.once("error", () => reject(new Error("official Claude executable could not be started")));
      child.once("exit", (code, signal) => resolve3(code ?? (signal === "SIGINT" ? 130 : 1)));
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
