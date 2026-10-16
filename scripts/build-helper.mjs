// Reproducible, offline build after npm install. --check compares without writing generated files.
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const packageJson = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
const wsPackage = JSON.parse(await readFile(join(root, 'node_modules/ws/package.json'), 'utf8'))
if (packageJson.dependencies.ws !== wsPackage.version) throw new Error('installed ws does not match the pinned package version')
const result = await build({
  absWorkingDir: root,
  entryPoints: { helper: 'helper/main.ts' },
  outdir: 'dist',
  outExtension: { '.js': '.mjs' },
  tsconfig: 'helper/tsconfig.node.json',
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  charset: 'utf8',
  legalComments: 'inline',
  write: false,
  banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" },
  define: { 'process.env.WS_NO_BUFFER_UTIL': '"1"', 'process.env.WS_NO_UTF_8_VALIDATE': '"1"' },
  plugins: [{
    name: 'embedded-openai-instructions',
    setup(build) {
      build.onLoad({ filter: /helper[/\\]openai[/\\]instructions\.ts$/ }, async ({ path }) => {
        const source = await readFile(path, 'utf8')
        const instructions = (await readFile(join(dirname(path), 'instructions.md'), 'utf8')).trim()
        const expression = "readFileSync(new URL('./instructions.md', import.meta.url), 'utf8').trim()"
        if (!source.includes(expression)) throw new Error('OpenAI instructions source changed; update the embedding transform')
        return { contents: source.replace(expression, JSON.stringify(instructions)), loader: 'ts' }
      })
    },
  }],
})
const bundles = Object.fromEntries(result.outputFiles.map(file => [basename(file.path), file.contents]))
const output = bundles['helper.mjs']
const metadata = Buffer.from(`${JSON.stringify({ format: 1, node: '>=22', websocket: { name: 'ws', version: wsPackage.version, license: 'MIT' }, sha256: createHash('sha256').update(output).digest('hex') }, null, 2)}\n`)
const files = [...Object.entries(bundles), ['helper.meta.json', metadata]]
if (process.argv.includes('--check')) {
  for (const [filename, bytes] of files) {
    const current = await readFile(join(root, 'dist', filename)).catch(() => undefined)
    if (!current || !Buffer.from(bytes).equals(current)) throw new Error(`dist/${filename} is stale; run npm run build`)
  }
  process.stdout.write('Direct provider helper bundle is current\n')
} else {
  await mkdir(join(root, 'dist'), { recursive: true })
  for (const [filename, bytes] of files) await writeFile(join(root, 'dist', filename), bytes)
  process.stdout.write('Built direct provider helper for Node 22+\n')
}
