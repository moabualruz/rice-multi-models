// Obtain declarations from the official build's own authoring skill, then check
// maintained hooks against that exact public contract. No inference is required.
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const fixture = mkdtempSync(join(tmpdir(), 'rice-hooks-types-'))
const config = join(fixture, '.claude'), promptFile = join(fixture, 'authoring.txt')
const native = process.env.RICE_CLAUDE_EXECUTABLE || 'claude'
let child, nativePosts = 0
const server = createServer((request, response) => {
  if (request.method === 'POST') nativePosts++
  request.resume()
  response.writeHead(429, { 'content-type': 'application/json', 'x-should-retry': 'false' })
  response.end('{"error":{"type":"rate_limit_error","message":"Owned inference sentinel"}}')
})
function terminate() {
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', timeout: 10_000 })
  else try { process.kill(-child.pid, 'SIGTERM') } catch (error) { if (error.code !== 'ESRCH') throw error }
}
try {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  mkdirSync(config)
  writeFileSync(join(config, 'settings.json'), '{}')
  writeFileSync(join(fixture, '.claude.json'), JSON.stringify({ hasCompletedOnboarding: true }))
  const sources = {
    observer: `export const register=on=>{on('skill.prompt',async($,e,next)=>{const result=await next(e);if(e.skill==='plugin-authoring'||result.text.includes('WHERE THE TYPES ARE'))await $.fs.write(${JSON.stringify(promptFile)},result.text);return result;});};`,
    driver: `export const register=on=>{on('turn.step',async function*($,e){const result=await $.tool.call({tool:'Skill',skill:'plugin-authoring'});const answer=result.isError||result.deny?'OWNED_TYPES_FAILED':'OWNED_TYPES_READY';yield{kind:'text',index:0,text:answer};yield{kind:'stop',stopReason:'end_turn',usage:null};return{turnId:e.turnId,index:e.index,answer,toolUses:[],stopReason:'end_turn',usage:null};});};`,
  }
  const env = Object.fromEntries(['PATH', 'TMPDIR', 'LANG', 'SystemRoot', 'SystemDrive', 'WINDIR', 'ComSpec', 'TEMP', 'TMP', 'CLAUDE_CODE_GIT_BASH_PATH'].filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]))
  Object.assign(env, { HOME: fixture, USERPROFILE: fixture, CLAUDE_CONFIG_DIR: config, ANTHROPIC_API_KEY: 'owned-no-account', ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.address().port}`, DISABLE_AUTOUPDATER: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' })
  const plugins = []
  for (const [name, source] of Object.entries(sources)) {
    const folder = join(fixture, name); plugins.push(folder)
    mkdirSync(join(folder, '.claude-plugin'), { recursive: true }); mkdirSync(join(folder, 'hooks'))
    writeFileSync(join(folder, '.claude-plugin/plugin.json'), JSON.stringify({ name: `owned-types-${name}`, version: '1.0.0', description: 'Owned current-build declarations fixture', author: { name: 'Owned fixture' } }))
    writeFileSync(join(folder, 'hooks/hooks.json'), JSON.stringify({ modules: ['./register.js'] }))
    assert.equal(spawnSync(process.execPath, ['--input-type=module', '--check'], { input: source, encoding: 'utf8' }).status, 0, 'fixture payload compiles')
    writeFileSync(join(folder, 'hooks/register.js'), source)
    const validated = spawnSync(native, ['plugin', 'validate', '--strict', folder], { env, cwd: fixture, encoding: 'utf8', timeout: 15_000 })
    assert.equal(validated.status, 0, (validated.stdout + validated.stderr).slice(-3000))
  }
  child = spawn(native, ['-p', ...plugins.flatMap(folder => ['--plugin-dir', folder]), '--setting-sources', 'user', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--tools', 'Skill', '--allowedTools', 'Skill', '--no-session-persistence', '--output-format', 'json', '--', 'Load the installed authoring declarations.'], { cwd: fixture, env, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] })
  console.log(JSON.stringify({ phase: 'current-build-hook-types', ownedPid: child.pid, preload: false }))
  let stdout = '', stderr = '', timedOut = false
  child.stdout.on('data', bytes => stdout += bytes); child.stderr.on('data', bytes => stderr += bytes)
  const timer = setTimeout(() => { timedOut = true; terminate() }, 30_000)
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve) }); clearTimeout(timer)
  assert.equal(timedOut, false, 'authoring declarations finish within the owned deadline')
  assert.equal(code, 0, (stdout + stderr).slice(-3000))
  assert.equal(JSON.parse(stdout).result, 'OWNED_TYPES_READY')
  assert.equal(nativePosts, 0, 'loading the authoring skill performs no native inference')
  const prompt = readFileSync(promptFile, 'utf8')
  const declarationPath = [...prompt.matchAll(/`([^`\r\n]*[/\\]plugin-authoring[/\\]types[/\\]claude-code\.d\.ts)`/g)][0]?.[1]
  assert.ok(declarationPath, 'the actual authoring skill names its build-specific declaration file')
  const declarations = readFileSync(declarationPath)
  const copied = join(fixture, 'claude-code.d.ts'); writeFileSync(copied, declarations)
  const tsconfig = join(fixture, 'tsconfig.json')
  writeFileSync(tsconfig, JSON.stringify({ compilerOptions: { target: 'es2023', lib: ['es2023', 'dom'], types: [], module: 'esnext', moduleResolution: 'bundler', allowImportingTsExtensions: true, strict: true, noEmit: true, skipLibCheck: true }, files: [copied], include: [join(root, 'hooks'), join(root, 'types')] }))
  const checked = spawnSync(process.execPath, [join(root, 'node_modules/typescript/bin/tsc'), '-p', tsconfig], { cwd: root, encoding: 'utf8', timeout: 30_000 })
  if (checked.stdout) process.stdout.write(checked.stdout)
  if (checked.stderr) process.stderr.write(checked.stderr)
  assert.equal(checked.status, 0, 'maintained hooks type-check against the actual native build')
  console.log(JSON.stringify({ currentBuildHooksTypecheck: true, declarationSha256: createHash('sha256').update(declarations).digest('hex'), nativePosts }))
} finally {
  terminate()
  await new Promise(resolve => server.close(resolve))
  rmSync(fixture, { recursive: true, force: true })
}
