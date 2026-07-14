#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { appendFileSync } from 'node:fs'

function sh(cmd, args, fallback = '') {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8' }).trim()
  } catch {
    return fallback
  }
}

function shOk(cmd, args) {
  try {
    execFileSync(cmd, args, { encoding: 'utf8', stdio: 'pipe' })
    return true
  } catch {
    return false
  }
}

function uniq(arr) {
  return [...new Set(arr)]
}

function isDocs(path) {
  return (
    path.startsWith('docs/') ||
    path.endsWith('.md') ||
    path.endsWith('.mdx') ||
    path.startsWith('.changeset/')
  )
}

function isWorkflow(path) {
  return path.startsWith('.github/workflows/')
}

function isTest(path) {
  return (
    path.includes('/test/') ||
    path.includes('/tests/') ||
    /\.test\.[cm]?[jt]sx?$/.test(path) ||
    /\.spec\.[cm]?[jt]sx?$/.test(path)
  )
}

function isSource(path) {
  if (!path.startsWith('extensions/memory-hybrid/')) return false
  if (isTest(path)) return false
  return /\.[cm]?[jt]sx?$/.test(path)
}

function isPackageOrLock(path) {
  return (
    path === 'extensions/memory-hybrid/package.json' ||
    path === 'extensions/memory-hybrid/package-lock.json' ||
    path.endsWith('/package-lock.json') ||
    path.endsWith('/pnpm-lock.yaml') ||
    path.endsWith('/yarn.lock')
  )
}

function isScript(path) {
  return (
    path.startsWith('.github/scripts/') ||
    path.startsWith('scripts/') ||
    path.includes('/scripts/')
  )
}

function isMetadata(path) {
  return (
    path === '.editorconfig' ||
    path === '.gitignore' ||
    path === '.gitattributes' ||
    path === '.prettierignore' ||
    path === '.prettierrc' ||
    path === '.prettierrc.json' ||
    path === 'CODEOWNERS' ||
    path === 'LICENSE' ||
    path === 'README.md' ||
    path === '.nvmrc' ||
    path === '.npmrc'
  )
}

/**
 * Resolve the diff range, or `null` when it can't be determined (e.g. a shallow
 * checkout leaves the base and head refs with no shared history, so a three-dot
 * diff has no merge-base). Callers MUST treat `null` as "assume everything
 * changed" — the previous behavior silently fell back to an empty diff on any
 * git failure, which made every required-check gate (ci_required,
 * heavy_ci_required, ...) false and let real typecheck/lint/test jobs be
 * skipped in favor of the harmless "no changes" passthrough stubs.
 */
function targetRange() {
  const event = process.env.GITHUB_EVENT_NAME || ''
  const baseRef = process.env.GITHUB_BASE_REF || ''
  if (event === 'pull_request' && baseRef) {
    // Progressively deepen the fetch until a merge-base is found, in case the
    // checkout is shallow. The ci.yml checkout for this job now uses
    // fetch-depth: 0 (full history), so this is defense-in-depth, not the
    // primary fix.
    for (const depth of [1, 50, 500]) {
      sh('git', ['fetch', '--no-tags', `--depth=${depth}`, 'origin', baseRef], '')
      if (shOk('git', ['merge-base', `origin/${baseRef}`, 'HEAD'])) {
        return `origin/${baseRef}...HEAD`
      }
    }
    sh('git', ['fetch', '--no-tags', '--unshallow', 'origin', baseRef], '')
    if (shOk('git', ['merge-base', `origin/${baseRef}`, 'HEAD'])) {
      return `origin/${baseRef}...HEAD`
    }
    return null
  }

  const before = process.env.GITHUB_EVENT_BEFORE || ''
  if (before && before !== '0000000000000000000000000000000000000000' && shOk('git', ['cat-file', '-e', before])) {
    return `${before}...HEAD`
  }

  const mergeBase = sh('git', ['merge-base', 'HEAD', 'origin/main'], '')
  if (mergeBase) return `${mergeBase}...HEAD`
  return null
}

const range = targetRange()
const rangeResolved = range !== null
const namesRaw = rangeResolved ? sh('git', ['diff', '--name-only', range], '') : ''
const files = uniq(
  namesRaw
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean),
)

const docsOnly = rangeResolved && files.length > 0 && files.every((f) => isDocs(f))
const workflowChanged = !rangeResolved || files.some((f) => isWorkflow(f))
const sourceChanged = !rangeResolved || files.some((f) => isSource(f))
const testsChanged = !rangeResolved || files.some((f) => isTest(f))
const packageOrLockChanged = !rangeResolved || files.some((f) => isPackageOrLock(f))
const scriptsChanged = !rangeResolved || files.some((f) => isScript(f))
const metadataOnly = rangeResolved && files.length > 0 && files.every((f) => isMetadata(f) || isDocs(f))

const ciRequired = !rangeResolved || sourceChanged || packageOrLockChanged || scriptsChanged || testsChanged
const heavyCiRequired = !rangeResolved || sourceChanged || packageOrLockChanged || scriptsChanged
const actionlintRequired = !rangeResolved || workflowChanged
const securityRequired = !rangeResolved || sourceChanged || packageOrLockChanged || scriptsChanged || workflowChanged

const outputs = {
  range_resolved: String(rangeResolved),
  docs_only: String(docsOnly),
  workflow_changed: String(workflowChanged),
  source_changed: String(sourceChanged),
  tests_changed: String(testsChanged),
  package_or_lock_changed: String(packageOrLockChanged),
  scripts_changed: String(scriptsChanged),
  metadata_only: String(metadataOnly),
  ci_required: String(ciRequired),
  heavy_ci_required: String(heavyCiRequired),
  actionlint_required: String(actionlintRequired),
  security_required: String(securityRequired),
  changed_files_count: String(files.length),
}

const outputFile = process.env.GITHUB_OUTPUT
if (outputFile) {
  for (const [k, v] of Object.entries(outputs)) {
    appendFileSync(outputFile, `${k}=${v}\n`)
  }
}

const summaryFile = process.env.GITHUB_STEP_SUMMARY
if (summaryFile) {
  const lines = []
  lines.push('## Changed-path policy classification')
  lines.push('')
  if (!rangeResolved) {
    lines.push(
      '**⚠️ Could not resolve a diff range (no merge-base found) — failing open: all CI-required flags forced to `true` so real checks still run.**',
    )
    lines.push('')
  }
  lines.push(`Range: \`${range ?? '<unresolved>'}\``)
  lines.push(`Changed files: **${files.length}**`)
  lines.push('')
  lines.push('| Signal | Value |')
  lines.push('| --- | --- |')
  for (const [k, v] of Object.entries(outputs)) {
    if (k === 'changed_files_count') continue
    lines.push(`| \`${k}\` | \`${v}\` |`)
  }
  lines.push('')
  if (files.length) {
    lines.push('<details><summary>Files</summary>')
    lines.push('')
    for (const f of files) lines.push(`- \`${f}\``)
    lines.push('')
    lines.push('</details>')
  } else {
    lines.push('_No changed files detected for computed range._')
  }
  appendFileSync(summaryFile, `${lines.join('\n')}\n`)
}
