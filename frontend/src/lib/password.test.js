// Password authentication: the API helper and the client-side rules that decide
// whether a sign-in attempt is even sent.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { passwordLogin } from './api.js'
import { validatePassword, PASSWORD_MIN } from './password.js'

describe('passwordLogin', () => {
  beforeEach(() => { globalThis.fetch = vi.fn() })
  afterEach(() => { vi.restoreAllMocks() })

  it('posts the name and password to /api/login/password', async () => {
    globalThis.fetch.mockResolvedValue({
      ok: true,
      json: async () => ({ user: { id: 'u1', name: 'Ana', admin: false } })
    })
    const u = await passwordLogin('Ana', 'secreta123')
    expect(u).toEqual({ id: 'u1', name: 'Ana', admin: false })
    const [path, opts] = globalThis.fetch.mock.calls[0]
    expect(path).toBe('/api/login/password')
    expect(opts.method).toBe('POST')
    expect(JSON.parse(opts.body)).toEqual({ name: 'Ana', password: 'secreta123' })
  })

  it('throws the server error message on a rejected sign-in', async () => {
    globalThis.fetch.mockResolvedValue({
      ok: false,
      json: async () => ({ error: 'invalid name or password' })
    })
    await expect(passwordLogin('Ana', 'wrong')).rejects.toThrow('invalid name or password')
  })

  it('carries the HTTP status on the thrown error', async () => {
    globalThis.fetch.mockResolvedValue({
      ok: false,
      status: 429,
      json: async () => ({ error: 'too many failed attempts — try again in a few minutes' })
    })
    await expect(passwordLogin('Ana', 'wrong')).rejects.toMatchObject({ status: 429 })
  })
})

// The password rules the Login sheet enforces before sending anything.
describe('validatePassword', () => {
  it('rejects a password under the minimum length', () => {
    expect(validatePassword('1234567', '1234567')).toBe('Password must be at least 8 characters')
  })
  it('accepts a password at exactly the minimum length', () => {
    expect(validatePassword('12345678', '12345678')).toBeNull()
  })
  it('rejects a confirmation that does not match', () => {
    expect(validatePassword('12345678', '87654321')).toBe('Passwords do not match')
  })
  it('accepts a matching pair', () => {
    expect(validatePassword('correct horse', 'correct horse')).toBeNull()
  })
})
