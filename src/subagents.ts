import { wireRecord } from './dsh-streams.js'
import { ConversationProjector } from './conversation.js'
import type { HistoryEntry } from './dsh-client.js'

export interface SubagentAddress {
  kind: 'subagent'
  parentSessionId: string
  childSessionId: string
  mode: 'one-shot' | 'continuable' | 'unknown'
}
interface TaskIdentity {
  id: string
  label: string
  depth: number
  readState: 'ready' | 'migration-required' | 'missing' | 'error'
}
export interface LocalSubagentTask extends TaskIdentity {
  kind: 'local'
  address: SubagentAddress
  status: 'running' | 'completed' | 'interrupted' | 'inactive' | 'unavailable' | 'unknown'
  elapsedMs?: number
  error?: string
}
export interface ExternalSubagentTask extends TaskIdentity {
  kind: 'external'
}
export type SubagentTask = LocalSubagentTask | ExternalSubagentTask
export interface TaskInspection {
  sessionId: string
  readState: 'ready' | 'migration-required' | 'missing'
  tasks: SubagentTask[]
  truncated: boolean
  detail?: {
    childSessionId: string
    messages: { id: string; role: string; text: string; detail: string; failed: boolean; rawInput?: string; rawResult?: string }[]
    truncated: boolean
  }
}

export type TaskProjections =
  | { kind: 'sequenced'; asOfSeq: number; values: Record<string, unknown> }
  | { kind: 'migration-required'; values: Record<string, unknown> }

/** Keep cache hints distinct from a verified snapshot, including on older runtimes. */
export function taskProjectionsOf(value: unknown): TaskProjections | null {
  if (value === null) return null
  if (!wireRecord(value) || !wireRecord(value.values)) throw new Error('Invalid DSH task projections.')
  if (value.kind === 'migration-required') return { kind: 'migration-required', values: value.values }
  if ((value.kind === undefined || value.kind === 'sequenced')
    && typeof value.asOfSeq === 'number' && Number.isSafeInteger(value.asOfSeq) && value.asOfSeq >= -1) {
    return { kind: 'sequenced', asOfSeq: value.asOfSeq, values: value.values }
  }
  throw new Error('Invalid DSH task projections.')
}

/** Only parent-owned catalog entries establish a child relationship. */
export function subagentCatalog(value: unknown): { id: string; label: string; mode: SubagentAddress['mode'] | 'external' }[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  return value.flatMap(entry => {
    if (!wireRecord(entry) || typeof entry.id !== 'string' || !entry.id || seen.has(entry.id)
      || !['one-shot', 'continuable', 'unknown', 'external'].includes(String(entry.mode))) return []
    seen.add(entry.id)
    return [{ id: entry.id, label: typeof entry.label === 'string' && entry.label.trim() ? entry.label.slice(0, 200) : `Agent ${entry.id.slice(0, 8)}`,
      mode: entry.mode as SubagentAddress['mode'] | 'external' }]
  })
}

export function subagentProgress(values: Record<string, unknown>, running?: boolean): Pick<LocalSubagentTask, 'status' | 'elapsedMs'> {
  const timing = wireRecord(values.subagentTiming) ? values.subagentTiming : {}
  const finite = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0
  const active = wireRecord(timing.active) ? timing.active : undefined
  // Durable event timestamps, not wall-clock time: an old open turn is not proof
  // that an Agent is still running, and inactivity is not proof of success.
  const elapsedMs = finite(timing.settledMs) + (active ? Math.max(0, finite(active.through) - finite(active.since)) : 0)
  return { elapsedMs, status: running === true ? 'running' : timing.lastTurnCompleted === true ? 'completed'
    : timing.lastTurnCompleted === false ? 'interrupted' : 'inactive' }
}

export async function readSubagentTasks(root: string, read: (id: string) => Promise<unknown>,
  running: (id: string) => boolean | undefined, signal: AbortSignal): Promise<TaskInspection> {
  signal.throwIfAborted()
  const rootValues = taskProjectionsOf(await read(root))
  signal.throwIfAborted()
  const result: TaskInspection = { sessionId: root, readState: rootValues === null ? 'missing'
    : rootValues.kind === 'migration-required' ? 'migration-required' : 'ready', tasks: [], truncated: false }
  if (rootValues === null) return result
  const seen = new Set([root])
  // Bounded discovery never resumes a child and never scans unrelated sessions.
  const visit = async (parent: string, projections: TaskProjections, depth: number): Promise<void> => {
    const cached = projections.kind === 'migration-required'
    for (const child of subagentCatalog(projections.values.subagentCatalog)) {
      signal.throwIfAborted()
      if (seen.has(child.id)) continue
      if (result.tasks.length >= 40 || depth > 4) { result.truncated = true; continue }
      seen.add(child.id)
      if (child.mode === 'external') {
        // A provider's execution ID is not a local session address. The catalog
        // supplies no progress, transcript or interrupt capability for this row.
        result.tasks.push({ kind: 'external', id: child.id, label: child.label, depth, readState: cached ? 'migration-required' : 'ready' })
        continue
      }
      const task: LocalSubagentTask = { kind: 'local', id: child.id, address: { kind: 'subagent', parentSessionId: parent, childSessionId: child.id, mode: child.mode },
        label: child.label, depth, readState: cached ? 'migration-required' : 'error', status: cached ? 'unknown' : 'unavailable' }
      result.tasks.push(task)
      // Cached membership can be displayed, but polling must not hydrate or
      // recursively expand it. Explicit detail reads use the read-only address.
      if (cached) continue
      let childValues: TaskProjections | null
      try { childValues = taskProjectionsOf(await read(child.id)) } catch {
        signal.throwIfAborted()
        task.error = 'Could not read this agent. Refresh to retry.'
        continue
      }
      signal.throwIfAborted()
      if (childValues === null) { task.readState = 'missing'; task.error = 'Agent history is no longer available.'; continue }
      if (childValues.kind === 'migration-required') {
        task.readState = 'migration-required'; task.status = 'unknown'
        continue
      }
      task.readState = 'ready'
      Object.assign(task, subagentProgress(childValues.values, running(child.id)))
      await visit(child.id, childValues, depth + 1)
    }
  }
  await visit(root, rootValues, 0)
  return result
}

export function subagentDetail(childSessionId: string, entries: HistoryEntry[], hasMore: boolean): NonNullable<TaskInspection['detail']> {
  const projector = new ConversationProjector()
  projector.reset(entries)
  const messages = projector.messages()
  let budget = 60_000
  let truncated = hasMore || messages.length > 60
  // Keep the newest output, then restore chronological order. Only pass bounded
  // text, not tool views or image blocks, into the read-only panel.
  const excerpts = messages.slice(-60).reverse().map(message => {
    const take = (text: string) => {
      const size = Math.min(8_000, budget)
      const excerpt = text.slice(0, size)
      if (text.length > excerpt.length) truncated = true
      budget -= excerpt.length
      return excerpt
    }
    return {
      id: message.id, role: message.role, text: take(message.text), detail: take(message.detail ?? ''), failed: message.failed === true,
      // Give results (including errors) priority over arguments when little budget remains.
      ...(message.role === 'tool' && message.rawResult !== undefined ? { rawResult: take(message.rawResult) } : {}),
      ...(message.role === 'tool' && message.rawInput !== undefined ? { rawInput: take(message.rawInput) } : {}),
    }
  }).filter(message => message.text || message.detail || message.rawInput || message.rawResult).reverse()
  return { childSessionId, messages: excerpts, truncated }
}
