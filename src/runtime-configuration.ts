import * as vscode from 'vscode'
import { DEEPSEEK_API_KEY_SECRET, normalizeDeepSeekApiKey } from './credentials.js'
import type { RuntimeCredentials } from './dsh-credentials.js'
import {
  isCurrentRuntimeTarget,
  restartAfterRuntimeChange,
  runtimeChangeTarget,
  type RuntimeChangeController,
} from './runtime-change.js'

interface ConfigurationController extends RuntimeChangeController {
  start(): Promise<void>
  readonly runtimeCredentials: RuntimeCredentials | undefined
}

// One credential dialog per controller, including Clear, to avoid competing writes.
const credentialOperations = new WeakSet<ConfigurationController>()

async function credentialOperation(controller: ConfigurationController, action: () => Promise<void>): Promise<void> {
  if (controller.isDisposed || credentialOperations.has(controller)) return
  credentialOperations.add(controller)
  try { await action() }
  catch (error) { if (!controller.isDisposed) await vscode.window.showErrorMessage(error instanceof Error ? error.message : 'Could not configure the DeepSeek API key.') }
  finally { credentialOperations.delete(controller) }
}

function keyInput(prompt: string): Thenable<string | undefined> {
  return vscode.window.showInputBox({
    title: 'Configure DeepSeek API Key', prompt,
    placeHolder: 'sk-…', password: true, ignoreFocusOut: true,
    validateInput: candidate => {
      try { normalizeDeepSeekApiKey(candidate); return undefined }
      catch (error) { return error instanceof Error ? error.message : 'Invalid API key.' }
    },
  })
}

function credentialTarget(controller: ConfigurationController) {
  const target = runtimeChangeTarget(controller)
  const credentials = controller.runtimeCredentials
  const current = () => isCurrentRuntimeTarget(controller, target) && credentials === controller.runtimeCredentials
    && controller.state.phase !== 'loading'
  const check = async (submitted = false) => {
    if (current()) return true
    if (!controller.isDisposed) await vscode.window.showWarningMessage(submitted
      ? 'The runtime connection changed after the credential request was sent. Check the original runtime; no request was replayed on the new connection.'
      : 'The runtime connection changed. No credential change was submitted; reopen the command for the intended runtime.')
    return false
  }
  return { target, credentials, check }
}

export async function configureApiKey(
  controller: ConfigurationController, secrets: vscode.SecretStorage, output: vscode.OutputChannel,
): Promise<void> {
  await credentialOperation(controller, async () => {
    if (controller.runtimeOwnership === undefined && controller.state.phase !== 'loading') await controller.start()
    if (controller.isDisposed) return
    if (controller.runtimeOwnership === 'external') {
      await vscode.window.showInformationMessage('This sidebar is using an external DeepSeek Harness runtime. Configure its API key where that process is started.')
      return
    }
    const { target, credentials, check } = credentialTarget(controller)
    if (controller.runtimeOwnership !== 'managed' || credentials === undefined || controller.state.phase === 'loading') {
      throw new Error('Connect to a managed DSH runtime before configuring its API key.')
    }
    const description = await credentials.describe()
    if (!await check()) return
    if (description === undefined) {
      const value = await keyInput('This DSH version has no credential configuration API. Save an environment fallback in VS Code SecretStorage; DSH decides which credential takes precedence after restart.')
      if (value === undefined || !await check()) return
      try { await secrets.store(DEEPSEEK_API_KEY_SECRET, normalizeDeepSeekApiKey(value)) }
      catch { throw new Error('Could not save the API key in VS Code SecretStorage.') }
      output.appendLine('[credentials] DeepSeek environment fallback saved in VS Code SecretStorage.')
      await restartAfterRuntimeChange(controller, target, 'DeepSeek environment fallback saved; effective credentials are determined by DSH')
      return
    }
    if (!description.writable) throw new Error('This DSH credential provider is read-only. Configure the API key in DSH instead.')
    const choice = await vscode.window.showWarningMessage(
      'Save the API key in DSH’s credential store? This is not VS Code SecretStorage and is shared by clients using the same DSH home. Any key already stored for DeepSeek will be replaced.',
      { modal: true }, 'Save to DSH',
    )
    if (choice !== 'Save to DSH' || !await check()) return
    const value = await keyInput('DSH will save this key for subsequent requests. Existing requests are not restarted; this does not verify the key with DeepSeek.')
    if (value === undefined || !await check()) return
    await credentials.set(normalizeDeepSeekApiKey(value))
    if (!await check(true)) return
    let updated
    try { updated = await credentials.describe() }
    catch { throw new Error('DSH accepted the key change, but its current credential state could not be confirmed. Check DSH settings before retrying.') }
    if (!await check(true)) return
    if (updated?.configured !== true) throw new Error('DSH accepted the key change but did not report a configured credential. Check its credential provider.')
    output.appendLine('[credentials] DeepSeek API key saved by the DSH credential provider.')
    await vscode.window.showInformationMessage('DeepSeek API key saved to DSH for subsequent requests. The key has not been tested with DeepSeek.')
  })
}

export async function clearApiKey(
  controller: ConfigurationController, secrets: vscode.SecretStorage, output: vscode.OutputChannel,
): Promise<void> {
  await credentialOperation(controller, async () => {
    const { target, credentials, check } = credentialTarget(controller)
    let destination: 'runtime' | 'legacy' = 'legacy'
    if (controller.runtimeOwnership === 'managed') {
      if (credentials === undefined || controller.state.phase === 'loading') throw new Error('Wait for the DSH connection before clearing credentials.')
      const description = await credentials.describe()
      if (!await check()) return
      if (description !== undefined) {
        const choice = await vscode.window.showQuickPick([
          ...(description.writable ? [{ label: 'DSH saved key', description: 'Shared runtime credential; environment fallbacks are kept', destination: 'runtime' as const }] : []),
          { label: 'VS Code fallback key', description: 'Only this extension’s SecretStorage entry; DSH credentials are kept', destination: 'legacy' as const },
        ], { title: 'Clear DeepSeek API Key', placeHolder: 'Choose which stored key to remove' })
        if (choice === undefined || !await check()) return
        destination = choice.destination
      }
    }
    if (destination === 'runtime' && credentials !== undefined) {
      const choice = await vscode.window.showWarningMessage(
        'Remove the DeepSeek key saved in DSH’s shared credential store? Other clients using the same DSH home are affected. Environment and VS Code fallback keys are not removed, and the key is not revoked at DeepSeek.',
        { modal: true }, 'Remove from DSH',
      )
      if (choice !== 'Remove from DSH' || !await check()) return
      await credentials.unset()
      if (!await check(true)) return
      let updated
      try { updated = await credentials.describe() }
      catch { throw new Error('DSH accepted the removal, but its remaining credential state could not be confirmed. Check DSH settings.') }
      if (!await check(true)) return
      if (updated === undefined) throw new Error('DSH accepted the removal, but its remaining credential state could not be confirmed.')
      output.appendLine('[credentials] DSH accepted removal of its saved DeepSeek key.')
      await vscode.window.showInformationMessage(updated.configured
        ? 'DSH accepted the removal. A credential is still configured; an environment fallback or another stored key may remain. The API key was not revoked.'
        : 'DSH accepted the removal and reports no configured DeepSeek credential. The API key was not revoked.')
      return
    }
    const choice = await vscode.window.showWarningMessage(
      'Remove only the DeepSeek environment fallback stored by this extension? DSH’s own saved key and other environment credentials will not be changed.', { modal: true }, 'Remove',
    )
    if (choice !== 'Remove' || !await check()) return
    try { await secrets.delete(DEEPSEEK_API_KEY_SECRET) }
    catch { throw new Error('Could not remove the VS Code fallback key.') }
    output.appendLine('[credentials] DeepSeek environment fallback removed from VS Code SecretStorage.')
    if (controller.isDisposed) return
    if (isCurrentRuntimeTarget(controller, target) && controller.runtimeOwnership === 'external') {
      await vscode.window.showInformationMessage('VS Code fallback key removed. The external DSH keeps its own credentials.')
      return
    }
    if (target.identity === undefined && isCurrentRuntimeTarget(controller, target)) {
      await vscode.window.showInformationMessage('VS Code fallback key removed. DSH credentials were not changed.')
      return
    }
    await restartAfterRuntimeChange(controller, target, 'VS Code fallback key removed; DSH credentials were not changed')
  })
}

export function watchDebugConfiguration(
  controller: RuntimeChangeController, workspace: vscode.Uri, output: vscode.OutputChannel,
): vscode.Disposable {
  let timer: NodeJS.Timeout | undefined
  let revision = 0
  let disposed = false
  const listener = vscode.workspace.onDidChangeConfiguration(event => {
    const resource = controller.cwd === '' ? workspace : vscode.Uri.file(controller.cwd)
    if (!event.affectsConfiguration('deepseekHarness.autonomousDebugging', resource)) return
    const enabled = vscode.workspace.getConfiguration('deepseekHarness', resource).get<boolean>('autonomousDebugging', false)
    const target = runtimeChangeTarget(controller)
    const request = ++revision
    if (timer !== undefined) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = undefined
      if (disposed || controller.isDisposed || request !== revision) return
      const message = `VS Code debugging ${enabled ? 'enabled' : 'disabled'}`
      output.appendLine(`[debug] ${message}; checking whether DSH can restart to apply the setting.`)
      if (target.identity === undefined && isCurrentRuntimeTarget(controller, target)) {
        void vscode.window.showInformationMessage(`${message}. The setting will apply the next time a managed DSH runtime starts.`)
        return
      }
      if (isCurrentRuntimeTarget(controller, target) && controller.runtimeOwnership === 'external') {
        void vscode.window.showInformationMessage(`${message}. VS Code debugging integration applies to managed DSH runtimes; the connected external runtime was not changed.`)
        return
      }
      void restartAfterRuntimeChange(controller, target, message, () => !disposed && request === revision).catch(error => {
        if (disposed || controller.isDisposed || request !== revision) return
        const detail = error instanceof Error ? error.message : String(error)
        output.appendLine(`[debug] Could not apply the setting: ${detail}`)
        void vscode.window.showErrorMessage(detail)
      })
    }, 200)
  })
  return { dispose: () => { disposed = true; ++revision; if (timer !== undefined) clearTimeout(timer); listener.dispose() } }
}
