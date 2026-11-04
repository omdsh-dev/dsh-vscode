import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeChangeController } from '../src/runtime-change.js'

const mocks = vi.hoisted(() => ({
  input: vi.fn(), warning: vi.fn(), pick: vi.fn(), info: vi.fn(), error: vi.fn(), config: vi.fn(), listen: vi.fn(),
}))
vi.mock('vscode', () => ({
  window: { showInputBox: mocks.input, showWarningMessage: mocks.warning, showQuickPick: mocks.pick, showInformationMessage: mocks.info, showErrorMessage: mocks.error },
  workspace: { getConfiguration: () => ({ get: mocks.config }), onDidChangeConfiguration: mocks.listen },
  Uri: { file: (fsPath: string) => ({ fsPath }) },
}))
import { configureApiKey, clearApiKey, watchDebugConfiguration } from '../src/runtime-configuration.js'
import { restartAfterRuntimeChange, runtimeChangeTarget } from '../src/runtime-change.js'
import { DEEPSEEK_API_KEY_SECRET } from '../src/credentials.js'

function harness() {
  const controller = {
    isDisposed: false, cwd: '/workspace', runtimeIdentity: {} as object | undefined,
    runtimeOwnership: 'managed' as RuntimeChangeController['runtimeOwnership'],
    hasRunningTasks: false, state: { phase: 'ready' as 'ready' | 'loading' | 'error', statusText: '' },
    restart: vi.fn(async () => true), start: vi.fn(async () => {}),
    runtimeCredentials: { describe: vi.fn(async (): Promise<any> => undefined), set: vi.fn(async (_value: string) => {}), unset: vi.fn(async () => {}) },
  }
  const secrets = { store: vi.fn(async () => {}), delete: vi.fn(async () => {}) }
  const output = { appendLine: vi.fn() }
  return { controller, secrets, output,
    configure: () => configureApiKey(controller, secrets as any, output as any),
    clear: () => clearApiKey(controller, secrets as any, output as any),
    watch: () => {
      const dispose = vi.fn(); mocks.listen.mockReturnValueOnce({ dispose })
      const subscription = watchDebugConfiguration(controller, { fsPath: '/workspace' } as any, output as any)
      return { subscription, dispose, change: (enabled = true, affects = true) => {
        mocks.config.mockReturnValue(enabled)
        mocks.listen.mock.calls.at(-1)![0]({ affectsConfiguration: () => affects })
      } }
    },
  }
}
beforeEach(() => { vi.resetAllMocks(); mocks.input.mockResolvedValue('sk-test'); mocks.warning.mockResolvedValue('Remove') })
afterEach(() => vi.useRealTimers())

describe('safe automatic runtime restarts', () => {
  it.each(['identity', 'cwd', 'loading', 'disconnected', 'busy', 'external', 'disposed'])(
    'does not restart a %s target', async reason => {
      const h = harness(), target = runtimeChangeTarget(h.controller)
      if (reason === 'identity') h.controller.runtimeIdentity = {}
      if (reason === 'cwd') h.controller.cwd = '/another'
      if (reason === 'loading') h.controller.state.phase = 'loading'
      if (reason === 'disconnected') h.controller.state.phase = 'error'
      if (reason === 'busy') h.controller.hasRunningTasks = true
      if (reason === 'external') h.controller.runtimeOwnership = 'external'
      if (reason === 'disposed') h.controller.isDisposed = true
      await restartAfterRuntimeChange(h.controller, target, 'Settings saved')
      expect(h.controller.restart).not.toHaveBeenCalled()
      expect(mocks.info).not.toHaveBeenCalled()
    },
  )

  it('does not report success for a superseded restart', async () => {
    const h = harness(); h.controller.restart.mockResolvedValue(false)
    await restartAfterRuntimeChange(h.controller, runtimeChangeTarget(h.controller), 'Settings saved')
    expect(mocks.info).not.toHaveBeenCalled()
  })

  it('surfaces a failed restart without a success notice', async () => {
    const h = harness()
    h.controller.restart.mockImplementation(async () => { h.controller.state = { phase: 'error', statusText: 'Offline' }; return true })
    await expect(restartAfterRuntimeChange(h.controller, runtimeChangeTarget(h.controller), 'Settings saved')).rejects.toThrow('Offline')
    expect(mocks.info).not.toHaveBeenCalled()
  })
})

describe('credential configuration', () => {
  it('stores a normalized key and restarts an idle runtime without logging the key', async () => {
    const h = harness(); mocks.input.mockResolvedValue(' sk-test ')
    await h.configure()
    expect(h.secrets.store).toHaveBeenCalledWith(DEEPSEEK_API_KEY_SECRET, 'sk-test')
    expect(h.controller.restart).toHaveBeenCalledTimes(1)
    expect(mocks.info).toHaveBeenCalledWith(expect.stringContaining('environment fallback saved'))
    expect(JSON.stringify(h.output.appendLine.mock.calls)).not.toContain('sk-test')
  })

  it('does not save or restart after the password dialog is cancelled', async () => {
    const h = harness(); mocks.input.mockResolvedValue(undefined)
    await h.configure()
    expect(h.secrets.store).not.toHaveBeenCalled(); expect(h.controller.restart).not.toHaveBeenCalled()
  })

  it('does not save credentials to a different runtime selected during the dialog', async () => {
    const h = harness(); mocks.input.mockImplementation(async () => { h.controller.runtimeIdentity = {}; return 'sk-test' })
    await h.configure()
    expect(h.secrets.store).not.toHaveBeenCalled(); expect(h.controller.restart).not.toHaveBeenCalled()
  })

  it.each(['configure', 'clear'] as const)('defers %s restart if a job starts during SecretStorage completion', async action => {
    const h = harness()
    h.secrets[action === 'configure' ? 'store' : 'delete'].mockImplementation(async () => { h.controller.hasRunningTasks = true })
    await h[action]()
    expect(h.controller.restart).not.toHaveBeenCalled()
    expect(mocks.warning).toHaveBeenCalledWith(expect.stringContaining('Background Jobs'))
    expect(mocks.info).not.toHaveBeenCalled()
  })

  it.each(['configure', 'clear'] as const)('does not restart a replacement runtime after %s storage completes', async action => {
    const h = harness()
    h.secrets[action === 'configure' ? 'store' : 'delete'].mockImplementation(async () => { h.controller.runtimeIdentity = {} })
    await h[action]()
    expect(h.controller.restart).not.toHaveBeenCalled()
    expect(mocks.warning).toHaveBeenCalledWith(expect.stringContaining('no runtime was restarted'))
  })

  it('does not restart a new runtime selected during the removal confirmation', async () => {
    const h = harness(); mocks.warning.mockImplementationOnce(async () => { h.controller.runtimeIdentity = {}; return 'Remove' })
    await h.clear()
    expect(h.secrets.delete).not.toHaveBeenCalled(); expect(h.controller.restart).not.toHaveBeenCalled()
  })

  it('keeps the external runtime credentials and process untouched', async () => {
    const h = harness(); h.controller.runtimeOwnership = 'external'
    await h.configure(); await h.clear()
    expect(mocks.input).not.toHaveBeenCalled(); expect(h.secrets.store).not.toHaveBeenCalled()
    expect(h.secrets.delete).toHaveBeenCalledWith(DEEPSEEK_API_KEY_SECRET)
    expect(h.controller.restart).not.toHaveBeenCalled()
    expect(mocks.info).toHaveBeenCalledWith(expect.stringContaining('external DSH keeps its own credentials'))
  })

  it('does not silently save an ineffective fallback when the runtime cannot connect', async () => {
    const h = harness(); h.controller.runtimeOwnership = undefined; h.controller.runtimeIdentity = undefined; h.controller.state.phase = 'error'
    h.controller.restart.mockImplementation(async () => { h.controller.state.phase = 'ready'; return true })
    await h.configure()
    expect(h.controller.start).toHaveBeenCalledTimes(1); expect(h.controller.restart).not.toHaveBeenCalled()
    expect(h.secrets.store).not.toHaveBeenCalled()
    expect(mocks.error).toHaveBeenCalledWith(expect.stringContaining('Connect to a managed'))
  })
})

function modernHarness() {
  const h = harness()
  const credentials = h.controller.runtimeCredentials
  credentials.describe.mockResolvedValue({ configured: true, source: 'file', writable: true })
  mocks.warning.mockImplementation(async (_message: string, _options: unknown, action: string) => action)
  mocks.pick.mockImplementation(async (items: any[]) => items[0])
  return { ...h, credentials }
}

describe('runtime-owned credentials', () => {
  it('confirms shared storage, writes through DSH and refreshes status without restarting or double-writing', async () => {
    const h = modernHarness(); mocks.input.mockResolvedValue(' sk-new ')
    let stored = 'stored-A'
    const env = 'fallback-B'
    h.credentials.set.mockImplementation(async value => { stored = value })
    await h.configure()
    expect(stored || env).toBe('sk-new')
    expect(h.credentials.set).toHaveBeenCalledWith('sk-new')
    expect(h.credentials.describe).toHaveBeenCalledTimes(2)
    expect(mocks.warning).toHaveBeenCalledWith(expect.stringContaining('shared by clients'), { modal: true }, 'Save to DSH')
    expect(h.secrets.store).not.toHaveBeenCalled(); expect(h.secrets.delete).not.toHaveBeenCalled()
    expect(h.controller.restart).not.toHaveBeenCalled()
    expect(mocks.info).toHaveBeenCalledWith(expect.stringContaining('has not been tested'))
    expect(JSON.stringify([h.output.appendLine.mock.calls, mocks.info.mock.calls])).not.toContain('sk-new')
  })

  it.each(['confirmation', 'input', 'read-only', 'unconfigured-read-only', 'loading', 'describe-failure'])(
    'does not save for %s', async reason => {
      const h = modernHarness()
      if (reason === 'confirmation') mocks.warning.mockResolvedValue(undefined)
      if (reason === 'input') mocks.input.mockResolvedValue(undefined)
      if (reason.endsWith('read-only')) h.credentials.describe.mockResolvedValue({ configured: reason === 'read-only', writable: false })
      if (reason === 'loading') h.controller.state.phase = 'loading'
      if (reason === 'describe-failure') h.credentials.describe.mockRejectedValue(new Error('Could not read credential configuration'))
      await h.configure()
      expect(h.credentials.set).not.toHaveBeenCalled(); expect(h.secrets.store).not.toHaveBeenCalled()
      expect(h.controller.restart).not.toHaveBeenCalled(); expect(mocks.info).not.toHaveBeenCalled()
    },
  )

  it.each(['describe', 'confirmation', 'input'])( 'abandons a replaced runtime after %s', async stage => {
    const h = modernHarness()
    if (stage === 'describe') h.credentials.describe.mockImplementationOnce(async () => { h.controller.runtimeIdentity = {}; return { configured: true, writable: true } })
    if (stage === 'confirmation') mocks.warning.mockImplementationOnce(async () => { h.controller.runtimeIdentity = {}; return 'Save to DSH' })
    if (stage === 'input') mocks.input.mockImplementationOnce(async () => { h.controller.runtimeIdentity = {}; return 'sk-new' })
    await h.configure()
    expect(h.credentials.set).not.toHaveBeenCalled(); expect(h.secrets.store).not.toHaveBeenCalled()
    expect(mocks.info).not.toHaveBeenCalled()
  })

  it('does not replay a write or report success when the client is replaced during set', async () => {
    const h = modernHarness(), original = h.credentials
    original.set.mockImplementationOnce(async () => { h.controller.runtimeCredentials = modernHarness().credentials })
    await h.configure()
    expect(original.describe).toHaveBeenCalledTimes(1)
    expect(h.controller.runtimeCredentials.set).not.toHaveBeenCalled()
    expect(mocks.info).not.toHaveBeenCalled()
    expect(mocks.warning).toHaveBeenLastCalledWith(expect.stringContaining('after the credential request was sent'))
  })

  it.each(['write-error', 'verification-error', 'verification-empty'])('does not store a fallback or report success after %s', async reason => {
    const h = modernHarness()
    if (reason === 'write-error') h.credentials.set.mockRejectedValue(new Error('Write result unconfirmed'))
    if (reason === 'verification-error') h.credentials.describe.mockResolvedValueOnce({ configured: true, writable: true }).mockRejectedValueOnce(new Error('offline'))
    if (reason === 'verification-empty') h.credentials.describe.mockResolvedValueOnce({ configured: true, writable: true }).mockResolvedValueOnce({ configured: false, writable: true })
    await h.configure()
    expect(h.secrets.store).not.toHaveBeenCalled(); expect(h.controller.restart).not.toHaveBeenCalled()
    expect(mocks.info).not.toHaveBeenCalled(); expect(mocks.error).toHaveBeenCalledTimes(1)
  })

  it('does not interrupt running tasks to apply a runtime-owned key', async () => {
    const h = modernHarness(); h.controller.hasRunningTasks = true
    await h.configure()
    expect(h.credentials.set).toHaveBeenCalledTimes(1); expect(h.controller.restart).not.toHaveBeenCalled()
  })

  it('does not open concurrent configure/clear dialogs', async () => {
    const h = modernHarness(), input = Promise.withResolvers<string | undefined>()
    mocks.input.mockReturnValueOnce(input.promise)
    const pending = h.configure()
    await vi.waitFor(() => expect(mocks.input).toHaveBeenCalled())
    await h.clear(); await h.configure()
    expect(mocks.input).toHaveBeenCalledTimes(1); expect(mocks.pick).not.toHaveBeenCalled()
    input.resolve(undefined); await pending
    mocks.input.mockResolvedValue('sk-next'); await h.configure()
    expect(h.credentials.set).toHaveBeenCalledWith('sk-next')
  })

  it('requires explicit removal from the shared store and reports surviving fallback credentials', async () => {
    const h = modernHarness()
    h.credentials.describe.mockResolvedValueOnce({ configured: true, writable: true, source: 'file' })
      .mockResolvedValueOnce({ configured: true, writable: true, source: 'env' })
    await h.clear()
    expect(h.credentials.unset).toHaveBeenCalledTimes(1)
    expect(mocks.warning).toHaveBeenCalledWith(expect.stringContaining('shared credential store'), { modal: true }, 'Remove from DSH')
    expect(mocks.info).toHaveBeenCalledWith(expect.stringContaining('credential is still configured'))
    expect(h.secrets.delete).not.toHaveBeenCalled(); expect(h.controller.restart).not.toHaveBeenCalled()
  })

  it('clears only the selected legacy fallback without modifying DSH storage', async () => {
    const h = modernHarness(); mocks.pick.mockImplementation(async (items: any[]) => items[1])
    await h.clear()
    expect(h.secrets.delete).toHaveBeenCalledWith(DEEPSEEK_API_KEY_SECRET)
    expect(h.credentials.unset).not.toHaveBeenCalled(); expect(h.controller.restart).toHaveBeenCalledTimes(1)
  })

  it.each(['picker', 'confirmation'])('does not remove from a new runtime selected during %s', async stage => {
    const h = modernHarness()
    if (stage === 'picker') mocks.pick.mockImplementationOnce(async (items: any[]) => { h.controller.runtimeIdentity = {}; return items[0] })
    else mocks.warning.mockImplementationOnce(async () => { h.controller.runtimeIdentity = {}; return 'Remove from DSH' })
    await h.clear()
    expect(h.credentials.unset).not.toHaveBeenCalled(); expect(h.secrets.delete).not.toHaveBeenCalled()
  })
})

describe('debug configuration watcher', () => {
  it('debounces changes and restarts only for the latest setting', async () => {
    vi.useFakeTimers(); const h = harness(), w = h.watch()
    w.change(true); w.change(false)
    await vi.advanceTimersByTimeAsync(200)
    expect(h.controller.restart).toHaveBeenCalledTimes(1)
    expect(mocks.info).toHaveBeenCalledWith('VS Code debugging disabled. DeepSeek Harness restarted.')
    w.subscription.dispose()
  })

  it.each(['busy', 'changed', 'disposed', 'external', 'stopped', 'unrelated'])(
    'does not restart for a %s debug setting change', async reason => {
      vi.useFakeTimers(); const h = harness(), w = h.watch()
      if (reason === 'stopped') { h.controller.runtimeIdentity = undefined; h.controller.runtimeOwnership = undefined }
      if (reason === 'external') h.controller.runtimeOwnership = 'external'
      w.change(true, reason !== 'unrelated')
      if (reason === 'busy') h.controller.hasRunningTasks = true
      if (reason === 'changed') h.controller.runtimeIdentity = {}
      if (reason === 'disposed') w.subscription.dispose()
      await vi.advanceTimersByTimeAsync(200)
      expect(h.controller.restart).not.toHaveBeenCalled()
      w.subscription.dispose()
    },
  )

  it('suppresses stale success notifications when a later setting arrives during restart', async () => {
    vi.useFakeTimers(); const h = harness(), w = h.watch(), restart = Promise.withResolvers<boolean>()
    h.controller.restart.mockImplementationOnce(() => { h.controller.state.phase = 'loading'; return restart.promise })
    w.change(true); await vi.advanceTimersByTimeAsync(200)
    w.change(false); await vi.advanceTimersByTimeAsync(200)
    restart.resolve(true); await vi.advanceTimersByTimeAsync(0)
    expect(h.controller.restart).toHaveBeenCalledTimes(1)
    expect(mocks.info).not.toHaveBeenCalled()
    w.subscription.dispose()
  })
})
