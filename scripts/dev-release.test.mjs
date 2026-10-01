import assert from 'node:assert/strict'
import test from 'node:test'
import {
  formatDevReleaseNotes,
  normalizePlatforms,
  prepareDevRelease,
  selectRetentionCandidates,
} from './dev-release.mjs'

test('prepares a deterministic dynamic matrix, tag, and package version', () => {
  const prepared = prepareDevRelease({
    sha: 'a'.repeat(40),
    platforms: ['macos-arm64', 'windows-x64'],
    baseVersion: '0.3.11',
    runId: '12345',
    attempt: '2',
  })

  assert.equal(prepared.tag, 'dev-main-aaaaaaa.12345.2')
  assert.equal(prepared.version, '0.3.11-dev.12345.2')
  assert.deepEqual(prepared.matrix, {
    include: [
      {
        id: 'macos-arm64',
        os: 'macos-15',
        updaterMetadataSource: 'latest-mac.yml',
        updaterMetadataAsset: 'dev-macos-arm64-mac.yml',
      },
      {
        id: 'windows-x64',
        os: 'windows-latest',
        updaterMetadataSource: 'latest.yml',
        updaterMetadataAsset: 'dev-windows-x64.yml',
      },
    ],
  })
})

test('uses an Intel runner for macOS x64 dev builds', () => {
  const prepared = prepareDevRelease({
    sha: 'a'.repeat(40),
    platforms: ['macos-x64'],
    baseVersion: '0.3.11',
    runId: '12345',
    attempt: '1',
  })

  assert.deepEqual(prepared.matrix, {
    include: [
      {
        id: 'macos-x64',
        os: 'macos-15-intel',
        updaterMetadataSource: 'latest-mac.yml',
        updaterMetadataAsset: 'dev-macos-x64-mac.yml',
      },
    ],
  })
})

test('assigns unique updater metadata assets to universal macOS and Linux builds', () => {
  const prepared = prepareDevRelease({
    sha: 'a'.repeat(40),
    platforms: ['macos-universal', 'linux-x64'],
    baseVersion: '0.3.11',
    runId: '12345',
    attempt: '1',
  })

  assert.deepEqual(prepared.matrix.include, [
    {
      id: 'macos-universal',
      os: 'macos-15',
      updaterMetadataSource: 'latest-mac.yml',
      updaterMetadataAsset: 'dev-macos-universal-mac.yml',
    },
    {
      id: 'linux-x64',
      os: 'ubuntu-latest',
      updaterMetadataSource: 'latest-linux.yml',
      updaterMetadataAsset: 'dev-linux-x64-linux.yml',
    },
  ])
})

test('rejects invalid, empty, duplicate, and unsupported platform selections', () => {
  assert.throws(() => normalizePlatforms(''), /at least one/)
  assert.throws(() => normalizePlatforms('linux-x64,linux-x64'), /duplicates/)
  assert.throws(() => normalizePlatforms('freebsd-x64'), /unsupported/)
  assert.throws(
    () =>
      prepareDevRelease({
        sha: 'not-a-sha',
        platforms: 'linux-x64',
        baseVersion: '0.3.11',
        runId: '1',
        attempt: '1',
      }),
    /full lowercase/,
  )
})

test('retention selects only old public dev prereleases', () => {
  const releases = [
    {
      id: 1,
      tag_name: 'v9.9.9',
      prerelease: false,
      published_at: '2026-07-30T00:00:00Z',
    },
    {
      id: 2,
      tag_name: 'v9.9.9-beta',
      prerelease: true,
      published_at: '2026-07-29T00:00:00Z',
    },
    {
      id: 3,
      tag_name: 'dev-draft',
      prerelease: true,
      draft: true,
      published_at: '2026-07-28T00:00:00Z',
    },
    ...Array.from({ length: 12 }, (_, index) => ({
      id: 100 + index,
      tag_name: `dev-build-${index}`,
      prerelease: true,
      draft: false,
      published_at: `2026-07-${String(index + 1).padStart(2, '0')}T00:00:00Z`,
    })),
  ]

  assert.deepEqual(selectRetentionCandidates(releases, 10), [
    { id: 101, tagName: 'dev-build-1' },
    { id: 100, tagName: 'dev-build-0' },
  ])
})

test('release notes expose machine-readable partial-success provenance', () => {
  const notes = formatDevReleaseNotes({
    packageVersion: '0.3.11-dev.12345.1',
    sourceSha: 'b'.repeat(40),
    commitTitle: 'Fix desktop integration',
    selectedPlatforms: ['macos-arm64', 'windows-x64'],
    successfulPlatforms: ['macos-arm64'],
    failedPlatforms: ['windows-x64'],
    sourceRun: { id: '77', attempt: '1', url: 'https://example.test/source/77' },
    publicRun: { id: '12345', attempt: '1', url: 'https://example.test/public/12345' },
  })

  assert.match(notes, /<!-- windflow-dev-release/)
  assert.match(notes, /"status":"partial"/)
  assert.match(notes, /"failedPlatforms":\["windows-x64"\]/)
  assert.match(notes, /Source SHA/)
})
