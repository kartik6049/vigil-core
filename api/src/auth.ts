import { createHash, timingSafeEqual } from 'node:crypto';
import type { RequestHandler } from 'express';
import jwt from 'jsonwebtoken';
import type { Config } from './config.js';
import { HttpError } from './errors.js';
import type { AuthUser, Role } from './types.js';

const TOKEN_TTL = '1h';

export function signToken(config: Config, user: AuthUser): string {
  return jwt.sign({ role: user.role, email: user.email }, config.jwtSecret, {
    subject: user.id,
    expiresIn: TOKEN_TTL,
    algorithm: 'HS256',
  });
}

function bearer(header: string | undefined): string | null {
  if (!header) return null;
  const [scheme, token] = header.split(' ');
  return scheme?.toLowerCase() === 'bearer' && token ? token : null;
}

function userFromToken(config: Config, token: string): AuthUser {
  try {
    // Pin the algorithm so a forged "alg: none" token is rejected.
    const payload = jwt.verify(token, config.jwtSecret, { algorithms: ['HS256'] });
    if (typeof payload === 'string' || !payload.sub) throw new Error('bad payload');
    const role = payload.role as Role;
    if (role !== 'analyst' && role !== 'admin') throw new Error('bad role');
    return { id: payload.sub, role, email: String(payload.email ?? '') };
  } catch {
    throw new HttpError(401, 'unauthorized', 'Missing, invalid or expired token');
  }
}

export function requireAuth(config: Config): RequestHandler {
  return (req, _res, next) => {
    const token = bearer(req.header('authorization'));
    if (!token) return next(new HttpError(401, 'unauthorized', 'Missing, invalid or expired token'));
    try {
      req.user = userFromToken(config, token);
      next();
    } catch (err) {
      next(err);
    }
  };
}

export function requireRole(...roles: Role[]): RequestHandler {
  return (req, _res, next) => {
    if (!req.user) return next(new HttpError(401, 'unauthorized', 'Not signed in'));
    if (!roles.includes(req.user.role)) {
      return next(new HttpError(403, 'forbidden', `Requires role: ${roles.join(' or ')}`));
    }
    next();
  };
}

function sha(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

function serviceKeyValid(config: Config, provided: string | undefined): boolean {
  if (!provided) return false;
  // Hash both sides so the comparison is constant-time even when lengths differ.
  return timingSafeEqual(sha(provided), sha(config.serviceKey));
}

/** For machine callers (the simulator). Header: X-Service-Key. */
export function requireServiceKey(config: Config): RequestHandler {
  return (req, _res, next) => {
    if (serviceKeyValid(config, req.header('x-service-key'))) return next();
    next(new HttpError(401, 'unauthorized', 'Invalid or missing service key'));
  };
}

/** Accepts either a valid service key or a valid user token. */
export function requireUserOrServiceKey(config: Config): RequestHandler {
  const auth = requireAuth(config);
  return (req, res, next) => {
    if (serviceKeyValid(config, req.header('x-service-key'))) return next();
    auth(req, res, next);
  };
}
