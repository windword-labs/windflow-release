import { readFileSync } from 'node:fs'
import process from 'node:process'
import { pathToFileURL } from 'node:url'

export const PLATFORM_CONFIG = {
  'macos-arm64': {
    // Pinned: signing fails on the macos-26 (26.6) image (windword-labs/windflow#3447).
    os: 'macos-15',
    updaterMetadataSource: 'latest-mac.yml',
    updaterMetadataAsset: 'dev-macos-arm64-mac.yml',
  },
  'windows-x64': {
    os: 'windows-latest',
    updaterMetadataSource: 'latest.yml',
    updaterMetadataAsset: 'dev-windows-x64.yml',
  },
  'linux-x64': {
    os: 'ubuntu-latest',
    updaterMetadataSource: 'latest-linux.yml',
    updaterMetadataAsset: 'dev-linux-x64-linux.yml',
  },
}

const stableVersionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/
const fullShaPattern = /^[0-9a-f]{40}$/
const positiveIntegerPattern = /^[1-9]\d*$/

export function normalizePlatforms(value) {
  const requested = Array.isArray(value)
    ? value
    : String(value || '')
        .split(',')
        .map((platform) => platform.trim())
        .filter(Boolean)

  if (requested.length === 0) {
    throw new Error('at least one dev release platform is required')
  }
  if (requested.length !== new Set(requested).size) {
    throw new Error('dev release platform selection contains duplicates')
  }
  for (const platform of requested) {
    if (!PLATFORM_CONFIG[platform]) {
      throw new Error(`unsupported dev release platform: ${platform}`)
    }
  }
  return requested
}

export function prepareDevRelease({ sha, platforms, baseVersion, runId, attempt }) {
  if (!fullShaPattern.test(String(sha))) {
    throw new Error('source SHA must be a full lowercase commit SHA')
  }
  if (!stableVersionPattern.test(String(baseVersion))) {
    throw new Error('source package version must use stable semantic version X.Y.Z')
  }
  if (!positiveIntegerPattern.test(String(runId))) {
    throw new Error('run ID must be a positive integer')
  }
  if (!positiveIntegerPattern.test(String(attempt))) {
    throw new Error('run attempt must be a positive integer')
  }

  const selectedPlatforms = normalizePlatforms(platforms)
  const shortSha = String(sha).slice(0, 7)

  return {
    sha: String(sha),
    shortSha,
    selectedPlatforms,
    matrix: {
      include: selectedPlatforms.map((id) => ({ id, ...PLATFORM_CONFIG[id] })),
    },
    tag: `dev-main-${shortSha}.${runId}.${attempt}`,
    version: `${baseVersion}-dev.${runId}.${attempt}`,
  }
}

export function selectRetentionCandidates(releases, keep = 10) {
  if (!Array.isArray(releases)) {
    throw new Error('release list must be an array')
  }
  if (!Number.isInteger(keep) || keep < 0) {
    throw new Error('retention count must be a non-negative integer')
  }

  return releases
    .filter(
      (release) =>
        release?.draft !== true &&
        release?.prerelease === true &&
        typeof release?.tag_name === 'string' &&
        release.tag_name.startsWith('dev-'),
    )
    .sort((left, right) => {
      const rightTime = Date.parse(right.published_at || right.created_at || 0)
      const leftTime = Date.parse(left.published_at || left.created_at || 0)
      return rightTime - leftTime
    })
    .slice(keep)
    .map((release) => ({ id: release.id, tagName: release.tag_name }))
}

export function formatDevReleaseNotes(metadata) {
  const selected = normalizePlatforms(metadata.selectedPlatforms)
  const successful = normalizePlatforms(metadata.successfulPlatforms)
  const failed = Array.isArray(metadata.failedPlatforms) ? metadata.failedPlatforms : []
  for (const platform of [...successful, ...failed]) {
    if (!selected.includes(platform)) {
      throw new Error(`result platform was not selected: ${platform}`)
    }
  }
  if (successful.some((platform) => failed.includes(platform))) {
    throw new Error('a platform cannot be both successful and failed')
  }

  const status = failed.length === 0 ? 'complete' : 'partial'
  const machineMetadata = {
    schemaVersion: 1,
    kind: 'windflow-dev-release',
    status,
    packageVersion: metadata.packageVersion,
    sourceSha: metadata.sourceSha,
    commitTitle: metadata.commitTitle,
    selectedPlatforms: selected,
    successfulPlatforms: successful,
    failedPlatforms: failed,
    sourceRun: metadata.sourceRun,
    publicRun: metadata.publicRun,
  }

  return [
    '<!-- windflow-dev-release',
    JSON.stringify(machineMetadata),
    '-->',
    '',
    `# WindFlow Desktop dev build (${status})`,
    '',
    'This is a public integration-test build, not a stable production release.',
    '',
    `- Package build: \`${metadata.packageVersion}\``,
    `- Source SHA: [\`${metadata.sourceSha}\`](https://github.com/windword-labs/windflow/commit/${metadata.sourceSha})`,
    `- Commit: ${metadata.commitTitle}`,
    `- Selected: ${selected.join(', ')}`,
    `- Successful: ${successful.join(', ')}`,
    `- Failed: ${failed.length > 0 ? failed.join(', ') : 'none'}`,
    `- Source workflow: ${metadata.sourceRun.url}`,
    `- Public workflow: ${metadata.publicRun.url} (attempt ${metadata.publicRun.attempt})`,
    '',
  ].join('\n')
}

function parseArgs(argv) {
  const [command, ...rest] = argv
  const options = {}
  for (let index = 0; index < rest.length; index += 2) {
    const name = rest[index]
    const value = rest[index + 1]
    if (!name?.startsWith('--') || value === undefined) {
      throw new Error(`invalid argument: ${name || ''}`)
    }
    options[name.slice(2)] = value
  }
  return { command, options }
}

function main() {
  const { command, options } = parseArgs(process.argv.slice(2))
  if (command === 'prepare') {
    const platforms = options.platforms?.trim().startsWith('[')
      ? JSON.parse(options.platforms)
      : options.platforms
    console.log(
      JSON.stringify(
        prepareDevRelease({
          sha: options.sha,
          platforms,
          baseVersion: options['base-version'],
          runId: options['run-id'],
          attempt: options.attempt,
        }),
      ),
    )
    return
  }

  if (command === 'retention') {
    const releases = JSON.parse(readFileSync(0, 'utf8'))
    console.log(JSON.stringify(selectRetentionCandidates(releases, Number(options.keep ?? 10))))
    return
  }

  if (command === 'notes') {
    console.log(formatDevReleaseNotes(JSON.parse(readFileSync(0, 'utf8'))))
    return
  }

  throw new Error(`unknown command: ${command || ''}`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main()
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
