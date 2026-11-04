// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { chatHtml } from '../src/webview.js'

function fixture() {
  const uri = { toString: () => 'asset' } as any
  const html = chatHtml({ cspSource: 'vscode-webview:' } as any, uri, { script: uri, style: uri, scroll: uri })
  const document = new DOMParser().parseFromString(html, 'text/html')
  const nodeStart = html.indexOf('function node(')
  const nodeEnd = html.indexOf('function relativeSessionTime(', nodeStart)
  const start = html.indexOf('function taskStatus(')
  const end = html.indexOf('function requestTasks(', start)
  expect(start).toBeGreaterThan(0); expect(end).toBeGreaterThan(start)
  const requested: string[] = []
  const render = new Function('document', 'requested', `
    let taskChild, taskSnapshot, taskSignature;
    const state = { jobs: [] };
    const tasksContent = document.getElementById('tasksContent');
    const tasksBack = document.getElementById('tasksBack');
    const array = value => Array.isArray(value) ? value : [];
    const string = (value, fallback = '') => typeof value === 'string' ? value : fallback;
    const liveJob = job => job.status === 'running';
    const jobDuration = () => '1s';
    const requestTasks = () => requested.push(taskChild);
    ${html.slice(nodeStart, nodeEnd)}
    ${html.slice(start, end)}
    return (snapshot, child, jobs = []) => { taskSnapshot = snapshot; taskChild = child; state.jobs = jobs; renderTasks(); };
  `)(document, requested)
  return { document, requested, render, content: document.getElementById('tasksContent')! }
}

const external = { kind: 'external', id: 'remote', label: 'Remote build', depth: 0 }
const local = { kind: 'local', id: 'local', label: 'Local check', depth: 0,
  address: { kind: 'subagent', parentSessionId: 'root', childSessionId: 'local', mode: 'continuable' }, status: 'running', elapsedMs: 2100 }
const snapshot = (tasks: unknown[]) => ({ sessionId: 'root', tasks, truncated: false })

describe('Tasks panel capabilities', () => {
  it('renders external-only tasks as noninteractive rows without invented status or duration', () => {
    const h = fixture(); h.render(snapshot([external]))
    const row = h.content.querySelector<HTMLElement>('.task-row')!
    expect(row.tagName).toBe('DIV'); row.click()
    expect(h.requested).toEqual([])
    expect(row.textContent).toBe('Remote buildExternal · No local history')
    expect(h.content.textContent).toContain('Subagents · 1')
    expect(h.content.textContent).not.toMatch(/Unavailable|Inactive|completed|recorded|No subagents/)
    expect(row.querySelector('a, button')).toBeNull()
  })
  it('keeps local detail navigation and background jobs alongside external tasks', () => {
    const h = fixture(); h.render(snapshot([external, local]), undefined, [{ id: 'job', kind: 'bash', label: 'Local server', status: 'running' }])
    expect(h.content.textContent).toContain('Subagents · 2')
    expect(h.content.textContent).toContain('Background jobs · 1')
    const row = h.content.querySelector<HTMLButtonElement>('button.task-row')!
    expect(row.textContent).toContain('Running · continuable · 2s recorded')
    row.click(); expect(h.requested).toEqual(['local'])
    h.render({ ...snapshot([external, local]), detail: { childSessionId: 'local', truncated: false, messages: [{ id: 'm', role: 'assistant', text: 'Recorded result' }] } }, 'local')
    expect(h.content.textContent).toContain('Recorded result')
  })
  it('escapes external labels as text and never turns provider IDs into links', () => {
    const h = fixture(); h.render(snapshot([{ ...external, label: '<img src=x onerror=alert(1)>', id: 'https://example.com' }]))
    expect(h.content.textContent).toContain('<img src=x onerror=alert(1)>')
    expect(h.content.querySelector('img, a')).toBeNull()
  })
})
