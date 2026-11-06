import { DshConnectionError } from './dsh-connection.js'
import { wireRecord } from './dsh-streams.js'
import { normalizeDeepSeekApiKey } from './credentials.js'

const ref = 'DEEPSEEK_API_KEY'
type CredentialSource = 'file' | 'env' | 'project-env' | 'user-env' | 'runtime'
export interface CredentialDescription {
  configured: boolean
  writable: boolean
  source?: CredentialSource
}

/** A connection-bound, write-only credential API. Undefined means the Remote is absent. */
export interface RuntimeCredentials {
  describe(): Promise<CredentialDescription | undefined>
  set(value: string): Promise<void>
  unset(): Promise<void>
}

/** Never forward provider error text: a custom provider may echo the submitted secret. */
function failure(error: unknown, write: boolean): Error {
  if (error instanceof DshConnectionError) {
    if (error.code === 'authentication-required') return new Error('DSH authentication was refused. Reconnect before configuring credentials.')
    if (error.code === 'credential/rejected') return new Error('DSH refused the credential change. Check its credential store permissions and configuration.')
    if (error.code === 'gateway/internal') return new Error('DSH could not access its credential provider. Configure the provider in DSH and retry.')
  }
  return new Error(write
    ? 'The DSH credential change could not be confirmed. It may have reached the original runtime; check its settings before retrying. No fallback key was saved.'
    : 'Could not read DSH credential configuration. Check the runtime connection and retry.')
}

export class DshCredentials implements RuntimeCredentials {
  constructor(private readonly call: (endpoint: string, args: Record<string, unknown>) => Promise<unknown>) {}

  async describe(): Promise<CredentialDescription | undefined> {
    let value: unknown
    try { value = await this.call('credentials/describe', { refs: [ref] }) }
    catch (error) {
      // The official HTTP gateway leaves unregistered Remotes unclaimed (404).
      // lookup-not-found is an argument lookup failure inside an existing Remote.
      if (error instanceof DshConnectionError && error.code === 'http-error' && error.status === 404) return undefined
      throw failure(error, false)
    }
    const info = wireRecord(value) ? value[ref] : undefined
    if (!wireRecord(info) || typeof info.configured !== 'boolean' || typeof info.writable !== 'boolean'
      || (info.source !== undefined && typeof info.source !== 'string')) throw new Error('Invalid DSH credential configuration response.')
    // Do not forward extra fields or arbitrary provider strings to any UI/log.
    const source = info.source === undefined ? undefined
      : ['file', 'env', 'project-env', 'user-env'].includes(info.source as string) ? info.source as CredentialSource : 'runtime'
    return { configured: info.configured, writable: info.writable, ...(source === undefined ? {} : { source }) }
  }

  async set(value: string): Promise<void> {
    const normalized = normalizeDeepSeekApiKey(value)
    try { await this.call('credentials/set', { ref, value: normalized }) }
    catch (error) { throw failure(error, true) }
  }

  async unset(): Promise<void> {
    try { await this.call('credentials/unset', { ref }) }
    catch (error) { throw failure(error, true) }
  }
}
