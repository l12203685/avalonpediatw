/**
 * Unit tests for the /api/version endpoint (P0 2026-04-23 guest stabilize).
 *
 * These tests guarantee the stable response contract the web client depends
 * on for detecting redeploys. Breaking the shape here would silently break
 * the refresh prompt on every guest's browser.
 */
import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import { versionRouter } from './version';

function makeApp(): express.Express {
  const app = express();
  app.use('/api', versionRouter);
  return app;
}

describe('/api/version', () => {
  it('returns version, builtAt, bootAt as strings', async () => {
    const res = await request(makeApp()).get('/api/version');
    expect(res.status).toBe(200);
    expect(typeof res.body.version).toBe('string');
    expect(res.body.version.length).toBeGreaterThan(0);
    expect(typeof res.body.builtAt).toBe('string');
    expect(typeof res.body.bootAt).toBe('string');
  });

  it('disables intermediate caching via Cache-Control header', async () => {
    const res = await request(makeApp()).get('/api/version');
    // Client poll-based deploy detection breaks completely if a proxy caches
    // this response, so we pin the header contract in a test.
    expect(res.headers['cache-control']).toContain('no-store');
  });

  it('returns stable version across successive calls within one process', async () => {
    // Build ID is resolved once at module load and cached for the process
    // lifetime — this keeps the client's baseline stable instead of rotating
    // per-request noise that would trigger spurious refresh prompts.
    const app = makeApp();
    const a = await request(app).get('/api/version');
    const b = await request(app).get('/api/version');
    expect(a.body.version).toBe(b.body.version);
    expect(a.body.bootAt).toBe(b.body.bootAt);
  });

  it('sanitizes version to alphanumerics + dash/underscore only', async () => {
    const res = await request(makeApp()).get('/api/version');
    // No shell metachars, no whitespace — safe to log, safe to render.
    expect(res.body.version).toMatch(/^[a-zA-Z0-9_\-.]+$/);
    expect(res.body.version.length).toBeLessThanOrEqual(40);
  });
});
