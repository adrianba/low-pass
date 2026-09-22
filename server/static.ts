import { accessSync, constants, readdirSync, realpathSync, statSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import express from 'express';
import type { ErrorRequestHandler, RequestHandler } from 'express';
import compression from 'compression';
import { ServiceConfigurationError } from './config.js';

const csp = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'; worker-src 'self' blob:; font-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'";

export function validateStaticRoot(root: string): string {
  try {
    const canonical = realpathSync(root);
    const inspect = (directory: string): void => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile())) {
          throw new ServiceConfigurationError('Static build output must contain only regular files and directories.');
        }
        if (entry.isDirectory()) inspect(join(directory, entry.name));
      }
    };
    inspect(canonical);
    for (const name of ['index.html', 'assets']) accessSync(join(canonical, name), constants.R_OK);
    if (!statSync(join(canonical, 'index.html')).isFile() ||
      statSync(join(canonical, 'index.html')).size === 0 || !statSync(join(canonical, 'assets')).isDirectory()) {
      throw new ServiceConfigurationError('Static build output requires index.html and an assets directory.');
    }
    return canonical;
  } catch (error) {
    if (error instanceof ServiceConfigurationError) throw error;
    throw new ServiceConfigurationError('Static build output is missing or unreadable; run npm run build.');
  }
}

export const securityHeaders: RequestHandler = (_request, response, next) => {
  response.set({
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'same-origin',
    'Content-Security-Policy': csp,
  });
  next();
};

export const compress = compression({
  filter: (request, response) => !request.headers.range && compression.filter(request, response),
});

export function staticFiles(root: string, privateFiles: readonly string[] = []): RequestHandler[] {
  const blocked = new Set(privateFiles.map(path => resolve(path)));
  for (const path of privateFiles) {
    try { blocked.add(realpathSync(path)); }
    catch (error) {
      if (!(error instanceof Error) || !('code' in error) ||
        !['ENOENT', 'ENOTDIR', 'EACCES', 'ELOOP', 'ENAMETOOLONG'].includes(String(error.code))) {
        throw new ServiceConfigurationError('Cannot establish private-file exclusions.');
      }
    }
  }
  const guard: RequestHandler = async (request, response, next) => {
    let path: string;
    try { path = decodeURIComponent(request.path); }
    catch { response.status(400).json({ error: 'invalid_path' }); return; }
    if (path.includes('\0') || path.includes('\\') || path.split('/').some(part => part === '..')) {
      response.status(400).json({ error: 'invalid_path' });
      return;
    }
    if (path.split('/').some(part => part.startsWith('.')) ||
      /^\/(?:node_modules|server|shared|dist-server|src|tests)(?:\/|$)/.test(path)) {
      response.status(404).json({ error: 'not_found' });
      return;
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.set('Allow', 'GET, HEAD').status(405).json({ error: 'method_not_allowed' });
      return;
    }
    if (path === '/') { request.url = '/index.html'; path = '/index.html'; }
    try {
      const target = await realpath(join(root, path));
      if (blocked.has(target)) { response.status(404).json({ error: 'not_found' }); return; }
      const local = relative(root, target);
      if (local === '..' || local.startsWith(`..${sep}`)) {
        response.status(403).json({ error: 'forbidden' });
        return;
      }
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error) ||
        !['ENOENT', 'ENOTDIR'].includes(String(error.code))) { next(error); return; }
    }
    next();
  };
  return [guard, express.static(root, {
    index: false, redirect: false, fallthrough: false, dotfiles: 'deny', extensions: false,
    setHeaders: (response, path) => {
      const local = '/' + relative(root, path).split(sep).join('/');
      response.setHeader('Cache-Control', /^\/assets\/[^/]+-[A-Za-z0-9_-]{8}\.(js|css)$/.test(local)
        ? 'public, max-age=31536000, immutable' : 'no-cache');
      if (path.endsWith('.glb')) response.setHeader('Content-Type', 'model/gltf-binary');
    },
  })];
}

export function httpErrors(warn: (message: string) => void): ErrorRequestHandler {
  return (error: unknown, _request, response, next) => {
    void next; // Express recognizes error middleware by its four-argument signature.
    if (response.destroyed) return;
    const status = error instanceof Error && 'status' in error && typeof error.status === 'number' &&
      [400, 403, 404, 405, 413, 415, 416].includes(error.status) ? error.status : 500;
    if (status === 500) warn('Application HTTP request failed.');
    if (response.headersSent) { response.destroy(); return; }
    response.removeHeader('Content-Length');
    response.removeHeader('Content-Encoding');
    response.setHeader('Cache-Control', 'no-store');
    response.status(status).json({ error: status === 404 ? 'not_found' : `http_${status}` });
  };
}
