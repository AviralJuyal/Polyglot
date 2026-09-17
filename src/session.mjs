import fs from 'node:fs';
import path from 'node:path';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { dataDirectory } from './storage.mjs';

const keyFile = path.join(dataDirectory(), 'session.key');
let secret = process.env.SESSION_SECRET;
if (!secret || secret.startsWith('replace-with-')) {
  if (fs.existsSync(keyFile)) secret = fs.readFileSync(keyFile, 'utf8');
  else {
    secret = randomBytes(48).toString('base64url');
    fs.writeFileSync(keyFile, secret, { mode: 0o600 });
  }
}

const demoUsers = new Map([
  ['tenant-a', { tenant: 'tenant-a', password: process.env.DEMO_TENANT_A_PASSWORD || 'tenant-a-demo' }],
  ['tenant-b', { tenant: 'tenant-b', password: process.env.DEMO_TENANT_B_PASSWORD || 'tenant-b-demo' }]
]);

function signature(payload) { return createHmac('sha256', secret).update(payload).digest('base64url'); }

export function authenticate(username, password) {
  if (typeof username !== 'string' || typeof password !== 'string') return null;
  const user = demoUsers.get(username);
  if (!user) return null;
  const left = Buffer.from(password);
  const right = Buffer.from(user.password);
  if (left.length !== right.length || !timingSafeEqual(left, right)) return null;
  return user.tenant;
}

export function sessionCookie(tenant) {
  const payload = Buffer.from(JSON.stringify({ tenant, exp: Date.now() + 12 * 60 * 60 * 1000 })).toString('base64url');
  const value = `${payload}.${signature(payload)}`;
  return `polyglot_session=${value}; HttpOnly; SameSite=Lax; Path=/; Max-Age=43200${process.env.NODE_ENV === 'production' ? '; Secure' : ''}`;
}

export function clearSessionCookie() {
  return 'polyglot_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0';
}

export function tenantFromRequest(req) {
  const cookie = (req.headers.cookie || '').split(';').map(part => part.trim()).find(part => part.startsWith('polyglot_session='));
  if (!cookie) return null;
  const value = cookie.slice('polyglot_session='.length);
  const [payload, supplied] = value.split('.');
  if (!payload || !supplied) return null;
  const expected = Buffer.from(signature(payload));
  const actual = Buffer.from(supplied);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;
  try {
    const session = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return session.exp > Date.now() && demoUsers.has(session.tenant) ? session.tenant : null;
  } catch { return null; }
}
