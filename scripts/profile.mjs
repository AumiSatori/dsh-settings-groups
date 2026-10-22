// Wire dsh-settings-groups into a DSH profile through the BUNDLE layer only.
//
// Why not the user patch layer (cordis.patch.yml `- insert:`)? Some plugins rewrite
// that file wholesale on save, which silently drops unrelated insert entries. The
// bundle layer (`dsh.profile.bundles` + package `dsh.bundle.patch`) has no such
// write-back path, so the wiring survives.
//
// Usage:
//   node scripts/profile.mjs check    [--profile desktop]
//   node scripts/profile.mjs install  [--profile desktop]
//   node scripts/profile.mjs uninstall[--profile desktop]
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const NAME = 'dsh-settings-groups'
const source = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const mode = args[0] || 'check'
if (!['install', 'uninstall', 'check'].includes(mode)) throw new Error('Use install, uninstall, or check')
const flag = args.indexOf('--profile')
const profile = flag < 0 ? 'desktop' : args[flag + 1]
if (!profile || !/^[\w-]+$/.test(profile)) throw new Error('Invalid profile name')

const home = resolve(process.env.DSH_HOME || join(homedir(), '.dsh'))
const target = join(home, 'profiles', profile)
const pkgPath = join(target, 'package.json')
const raw = readFileSync(pkgPath, 'utf8')
const pkg = JSON.parse(raw)
const link = join(target, 'node_modules', NAME)
const normalized = value => resolve(value.replace(/^\\\\\?\\/, '')).toLowerCase()

let linked = false
let occupied = false
try {
  const stat = lstatSync(link)
  linked = stat.isSymbolicLink() && normalized(readlinkSync(link)) === normalized(source)
  occupied = !linked
} catch (error) {
  if (error.code !== 'ENOENT') throw error
}
if (occupied) throw new Error('Plugin path already exists with a different target; preserving it')

const spec = `link:${source.replaceAll('\\', '/')}`
const bundles = pkg.dsh?.profile?.bundles ?? []
if (!Array.isArray(bundles)) throw new Error('Unexpected bundle list; preserving profile')

// Guard: the same package must not be loaded twice (bundle layer + user patch layer).
const patchPath = join(target, 'cordis.patch.yml')
if (existsSync(patchPath) && /\bid:\s*['"]?dsh-settings-groups\b/.test(readFileSync(patchPath, 'utf8'))) {
  throw new Error('Plugin also appears in the user patch layer; resolve duplicate loading first')
}

if (mode === 'check') {
  const result = { profile, linked, dependency: pkg.dependencies?.[NAME] === spec, bundle: bundles.includes(NAME) }
  console.log(JSON.stringify(result))
  console.log(`legacy organizer preset: ${bundles.some(name => String(name).includes('settings-nav-organizer')) ? 'YES (disable it first)' : 'no'}`)
  process.exitCode = result.linked && result.dependency && result.bundle ? 0 : 1
} else {
  pkg.dependencies ??= {}
  pkg.dsh ??= {}
  pkg.dsh.profile ??= {}
  if (mode === 'install') {
    pkg.dependencies[NAME] = spec
    pkg.dsh.profile.bundles = [...new Set([...bundles, NAME])]
  } else {
    if (pkg.dependencies[NAME] && pkg.dependencies[NAME] !== spec) throw new Error('Dependency changed; preserving it')
    delete pkg.dependencies[NAME]
    pkg.dsh.profile.bundles = bundles.filter(value => value !== NAME)
  }

  // Only touch this package's root importer record, leaving the resolved graph intact.
  const lockPath = join(target, 'pnpm-lock.yaml')
  const lockRaw = existsSync(lockPath) ? readFileSync(lockPath, 'utf8') : null
  let lockNext = lockRaw
  if (lockRaw !== null) {
    const anchor = /(^importers:\r?\n[\s\S]*?^  \.:\r?\n[\s\S]*?^    dependencies:\r?\n)/m
    if (!anchor.test(lockRaw)) throw new Error('Unknown lockfile layout; no profile files were changed')
    const block = /^      dsh-settings-groups:\r?\n        specifier: [^\r\n]*\r?\n        version: [^\r\n]*(?:\r?\n|$)/gm
    lockNext = lockRaw.replace(block, '')
    if (mode === 'install') lockNext = lockNext.replace(anchor, `$1      ${NAME}:\n        specifier: ${spec}\n        version: ${spec}\n`)
  }

  const pkgNext = `${JSON.stringify(pkg, null, 2)}\n`
  const changed = raw !== pkgNext || lockRaw !== lockNext
  if (changed) {
    const backupDir = join(home, 'backups', `${NAME}-${Date.now()}`)
    mkdirSync(backupDir, { recursive: true })
    copyFileSync(pkgPath, join(backupDir, 'package.json'))
    if (lockRaw !== null) copyFileSync(lockPath, join(backupDir, 'pnpm-lock.yaml'))
    if (readFileSync(pkgPath, 'utf8') !== raw || (lockRaw !== null && readFileSync(lockPath, 'utf8') !== lockRaw)) {
      throw new Error('Profile changed concurrently; preserving the newer files')
    }
  }

  if (mode === 'install' && !linked) {
    mkdirSync(dirname(link), { recursive: true })
    symlinkSync(source, link, process.platform === 'win32' ? 'junction' : 'dir')
  }
  if (raw !== pkgNext) writeFileSync(pkgPath, pkgNext)
  if (lockNext !== lockRaw) writeFileSync(lockPath, lockNext)
  if (mode === 'uninstall' && linked) {
    // unlink removes the junction itself, never the source tree.
    if (normalized(readlinkSync(link)) !== normalized(source)) throw new Error('Link changed concurrently')
    unlinkSync(link)
  }

  const legacy = bundles.filter(name => String(name).includes('settings-nav-organizer'))
  if (mode === 'install' && legacy.length > 0) {
    console.warn(`\n[warn] legacy organizer still enabled: ${legacy.join(', ')}`)
    console.warn('       它和新插件都会改写设置导航 —— 请先在「插件管理」里禁用它，否则本插件会自动退让（不生效）。')
  }
  console.log(JSON.stringify({ mode, profile, changed, bundleLayerOnly: true }))
  console.log('Fully restart DSH after adding/removing a plugin; refresh the window after client-only edits.')
}
