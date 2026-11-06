// Released rc.5 JSONL and projection-cache formats. Only writes under the fresh
// smoke-test home passed by the caller; no user sessions or model requests.
// Based on upstream session-persistence-jsonl/tests/catalog-migration.spec.ts.
import assert from 'node:assert/strict'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'

export async function prepareTaskFixtures(home, workspace) {
  const originals = new Map()
  const legacyDirectories = []
  // DSH's projectKey: separator runs become '-', other unsafe UTF-16 units
  // use '~XXXX'. A cwd is required for the read-only session/follow route.
  const slug = workspace.replace(/[/\\:]+/g, '-').replace(/[^A-Za-z0-9._-]/g,
    char => '~' + char.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')).replace(/^-+/, '') || 'root'
  const project = `--${slug.slice(0, 251)}--`
  const header = (id, version, parent) => ({ type: 'session', version, id, createdAt: 1, isSeeded: false, cwd: workspace,
    delegationDepth: parent ? 1 : 0, ...(parent ? { origin: 'subagent', parentSession: parent } : {}) })
  const catalog = (id, mode = 'one-shot') => ({ version: mode === 'external' ? 2 : 0, childId: id, childCreatedAt: 1, mode, label: id })
  const write = async (id, version, parent, events = []) => {
    const path = join(home, 'sessions', project, id, `session.v${version}.jsonl.zstd`)
    await mkdir(dirname(path), { recursive: true })
    const content = Buffer.concat([
      zstdCompressSync(JSON.stringify(header(id, version, parent)) + '\n'),
      ...(events.length ? [zstdCompressSync(events.map(row => JSON.stringify(row) + '\n').join(''))] : []),
    ])
    await writeFile(path, content)
    originals.set(path, content)
    if (version === 3) legacyDirectories.push(dirname(path))
  }
  const descriptor = { type: 'subagent/descriptor', seq: 0, time: 1,
    data: { version: 3, mode: 'one-shot', provider: 'spawn', label: 'Old child' } }
  await write('fixture-root', 4, undefined, [
    catalog('fixture-old'), catalog('fixture-external', 'external'), catalog('fixture-empty'), catalog('fixture-missing'),
  ].map((data, seq) => ({ type: 'subagent/catalog', seq, time: 1, data })))
  await write('fixture-old', 3, 'fixture-root', [descriptor])
  await write('fixture-empty', 4, 'fixture-root')
  await write('fixture-uncached', 3)
  await write('fixture-cached', 3)
  await write('fixture-cached-child', 3, 'fixture-cached', [descriptor])
  const cache = join(home, 'storages', 'session_projcache', 'sessions', 'fixture-cached.json')
  await mkdir(dirname(cache), { recursive: true })
  await writeFile(cache, JSON.stringify({ version: 7, record: {
    // Match the current-format header returned by stat(), as in the upstream
    // projection-discovery fixture; an old-format checkpoint is not usable.
    identity: { formatVersion: 4, createdAt: 1, cwd: workspace, isSeeded: false, inheritedEventCount: 0 },
    rows: { subagentCatalog: { ver: 6, seq: 0, val: { inheritedEventCount: 0, head: {
      values: [catalog('fixture-cached-child')],
    } } } },
  } }))
  return { originals, legacyDirectories }
}

export async function verifyTaskFixtures(client, connection, fixture) {
  const calls = []
  const original = connection.call
  connection.call = function (endpoint, args, ...rest) {
    calls.push({ endpoint, args })
    return original.call(this, endpoint, args, ...rest)
  }
  try {
    const tasks = await client.inspectTasks('fixture-root')
    assert.equal(tasks.readState, 'ready')
    assert.equal(tasks.tasks.length, 4)
    const old = tasks.tasks.find(task => task.id === 'fixture-old')
    assert.equal(old.readState, 'migration-required')
    assert.equal(old.status, 'unknown')
    assert.equal(old.elapsedMs, undefined)
    assert.equal(tasks.tasks.find(task => task.id === 'fixture-external').kind, 'external')
    assert.equal(tasks.tasks.find(task => task.id === 'fixture-empty').readState, 'ready')
    assert.equal(tasks.tasks.find(task => task.id === 'fixture-missing').readState, 'missing')
    assert(calls.every(call => call.endpoint === 'session/projections'))
    assert(!calls.some(call => call.args.request.sessionId === 'fixture-external'))

    calls.length = 0
    const uncached = await client.inspectTasks('fixture-uncached')
    assert.equal(uncached.readState, 'migration-required')
    assert.equal(uncached.tasks.length, 0)
    const cached = await client.inspectTasks('fixture-cached')
    assert.equal(cached.readState, 'migration-required')
    assert.equal(cached.tasks.length, 1)
    assert.equal(cached.tasks[0].status, 'unknown')
    assert.deepEqual(calls.map(call => call.args.request.sessionId), ['fixture-uncached', 'fixture-cached'])
    assert.equal((await client.inspectTasks('fixture-absent')).readState, 'missing')

    await assert.rejects(client.inspectTasks('fixture-root', 'fixture-external'), /no local session history/)
    const detail = await client.inspectTasks('fixture-cached', 'fixture-cached-child')
    assert.equal(detail.detail.childSessionId, 'fixture-cached-child')
    assert.equal(detail.readState, 'migration-required', 'Reading history must not claim persistent migration')
    const sessions = (await client.listSessions()).items
    assert(sessions.filter(session => session.sessionId.startsWith('fixture-')).every(session => !session.running))
    for (const [path, content] of fixture.originals) assert.deepEqual(await readFile(path), content)
    for (const dir of fixture.legacyDirectories) {
      assert(!(await readdir(dir)).some(name => /^session\.v[4-9]/.test(name)), 'Read-only inspection published a migrated successor')
    }
  } finally { connection.call = original }
}
