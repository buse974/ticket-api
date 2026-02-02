import { describe, it, expect, beforeEach } from 'vitest'
import { createApp } from '../src/app.js'
import { getTestDatabase, cleanDatabase } from './setup.js'
import type { Database } from '../src/db/index.js'

describe('Auth API', () => {
  let app: ReturnType<typeof createApp>
  let database: Database

  beforeEach(async () => {
    database = await getTestDatabase()
    await cleanDatabase(database)
    const broadcast = () => {}
    app = createApp(database, broadcast)
  })

  describe('POST /api/auth/register', () => {
    it('should register a new professional', async () => {
      const res = await app.request('/api/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'test@example.com',
          password: 'password123',
          name: 'Test Professional',
        }),
      })

      expect(res.status).toBe(201)

      const data = await res.json()
      expect(data.token).toBeDefined()
      expect(data.professional.email).toBe('test@example.com')
      expect(data.professional.name).toBe('Test Professional')
    })

    it('should create a queue for the new professional', async () => {
      const res = await app.request('/api/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'test@example.com',
          password: 'password123',
          name: 'Test Professional',
        }),
      })

      const data = await res.json()

      const queueRes = await app.request('/api/professional/queue', {
        headers: { 'Authorization': `Bearer ${data.token}` },
      })

      expect(queueRes.status).toBe(200)
      const queueData = await queueRes.json()
      expect(queueData.queue).toBeDefined()
      expect(queueData.queue.currentNumber).toBe(0)
      expect(queueData.queue.nextTicket).toBe(1)
    })

    it('should reject duplicate email', async () => {
      await app.request('/api/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'test@example.com',
          password: 'password123',
          name: 'Test Professional',
        }),
      })

      const res = await app.request('/api/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'test@example.com',
          password: 'password456',
          name: 'Another Professional',
        }),
      })

      expect(res.status).toBe(409)
    })

    it('should validate email format', async () => {
      const res = await app.request('/api/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'invalid-email',
          password: 'password123',
          name: 'Test Professional',
        }),
      })

      expect(res.status).toBe(400)
    })

    it('should require minimum password length', async () => {
      const res = await app.request('/api/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'test@example.com',
          password: '12345',
          name: 'Test Professional',
        }),
      })

      expect(res.status).toBe(400)
    })
  })

  describe('POST /api/auth/login', () => {
    beforeEach(async () => {
      await app.request('/api/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'test@example.com',
          password: 'password123',
          name: 'Test Professional',
        }),
      })
    })

    it('should login with valid credentials', async () => {
      const res = await app.request('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'test@example.com',
          password: 'password123',
        }),
      })

      expect(res.status).toBe(200)
      const data = await res.json()
      expect(data.token).toBeDefined()
      expect(data.professional.email).toBe('test@example.com')
    })

    it('should reject invalid password', async () => {
      const res = await app.request('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'test@example.com',
          password: 'wrongpassword',
        }),
      })

      expect(res.status).toBe(401)
    })

    it('should reject non-existent email', async () => {
      const res = await app.request('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'nonexistent@example.com',
          password: 'password123',
        }),
      })

      expect(res.status).toBe(401)
    })
  })

  describe('Protected routes', () => {
    it('should reject requests without token', async () => {
      const res = await app.request('/api/professional/me')
      expect(res.status).toBe(401)
    })

    it('should reject requests with invalid token', async () => {
      const res = await app.request('/api/professional/me', {
        headers: { 'Authorization': 'Bearer invalid-token' },
      })
      expect(res.status).toBe(401)
    })

    it('should accept requests with valid token', async () => {
      const registerRes = await app.request('/api/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'test@example.com',
          password: 'password123',
          name: 'Test Professional',
        }),
      })

      const { token } = await registerRes.json()

      const res = await app.request('/api/professional/me', {
        headers: { 'Authorization': `Bearer ${token}` },
      })

      expect(res.status).toBe(200)
      const data = await res.json()
      expect(data.email).toBe('test@example.com')
    })
  })
})
