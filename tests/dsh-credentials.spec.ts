import { describe, expect, it, vi } from 'vitest'
import { DshCredentials } from '../src/dsh-credentials.js'
import { DshConnectionError } from '../src/dsh-connection.js'

describe('DSH credential Remote', () => {
  it('uses named credential arguments and returns only safe status fields', async () => {
    const call = vi.fn(async (): Promise<unknown> => ({ DEEPSEEK_API_KEY: { configured: true, source: 'file', writable: true, value: 'private' } }))
    const credentials = new DshCredentials(call)
    expect(await credentials.describe()).toEqual({ configured: true, source: 'file', writable: true })
    expect(call).toHaveBeenLastCalledWith('credentials/describe', { refs: ['DEEPSEEK_API_KEY'] })
    expect(await credentials.set(' sk-new ')).toBeUndefined()
    expect(call).toHaveBeenLastCalledWith('credentials/set', { ref: 'DEEPSEEK_API_KEY', value: 'sk-new' })
    expect(await credentials.unset()).toBeUndefined()
    expect(call).toHaveBeenLastCalledWith('credentials/unset', { ref: 'DEEPSEEK_API_KEY' })
  })
  it('does not expose arbitrary source strings from a custom provider', async () => {
    const credentials = new DshCredentials(async () => ({ DEEPSEEK_API_KEY: { configured: true, writable: true, source: 'secret-text' } }))
    expect(await credentials.describe()).toEqual({ configured: true, writable: true, source: 'runtime' })
  })
  it('falls back only on an HTTP 404 from the describe endpoint, never from a write', async () => {
    const call = vi.fn().mockRejectedValue(new DshConnectionError('http-error', 'absent', 404))
    const credentials = new DshCredentials(call)
    expect(await credentials.describe()).toBeUndefined()
    expect(call).toHaveBeenCalledExactlyOnceWith('credentials/describe', { refs: ['DEEPSEEK_API_KEY'] })
    await expect(credentials.set('sk-test')).rejects.toThrow('could not be confirmed')
    await expect(credentials.unset()).rejects.toThrow('could not be confirmed')
  })
  it.each(['authentication-required', 'transport-error', 'gateway/internal', 'gateway/lookup-not-found', 'gateway/definition-unavailable', 'credential/rejected', 'invalid-response'])(
    'does not treat %s as an old runtime or leak provider messages', async code => {
      const call = vi.fn().mockRejectedValue(new DshConnectionError(code, 'echoes secret-text', 404))
      const credentials = new DshCredentials(call)
      for (const action of [() => credentials.describe(), () => credentials.set('secret-text'), () => credentials.unset()]) {
        const error = await action().catch(error => error)
        expect(error).toBeInstanceOf(Error); expect(error.message).not.toContain('secret-text')
      }
      expect(call).toHaveBeenCalledTimes(3)
    },
  )
  it.each([undefined, 401, 403, 405, 429, 500, 503])('does not treat HTTP %s as an absent Remote', async status => {
    const credentials = new DshCredentials(vi.fn().mockRejectedValue(new DshConnectionError('http-error', 'secret-text', status)))
    await expect(credentials.describe()).rejects.toThrow('Could not read DSH credential configuration')
  })
  it.each([null, {}, { configured: true }, { configured: 'yes', writable: true }, { configured: true, writable: true, source: 1 }])(
    'rejects malformed status without echoing its body', async info => {
      const credentials = new DshCredentials(async () => ({ DEEPSEEK_API_KEY: info, value: 'secret-text' }))
      await expect(credentials.describe()).rejects.toThrow('Invalid DSH credential configuration response.')
    },
  )
  it('rejects invalid pasted values before any request', async () => {
    const call = vi.fn(), credentials = new DshCredentials(call)
    await expect(credentials.set('DEEPSEEK_API_KEY=sk-test')).rejects.toThrow('only the API key value')
    expect(call).not.toHaveBeenCalled()
  })
})
