import crypto from 'crypto';
import express, { type Express, type RequestHandler } from 'express';
import fs from 'fs';
import path from 'path';
import { getConfig } from '../config';
import { cspDirectives } from './security';

export interface FrontendOptions {
  /** Directory with the built single-page app. Default: DIST_DIR from the configuration. */
  distDir?: string;
}

/** Files that must never be served to a browser, even if someone points DIST_DIR at a folder that holds them. */
const NEVER_SERVED = /\.(?:cjs|mjs|map|ts|tsx)$/i;

/** sha256 source-expressions for the inline <script> and <style> blocks of a static page, so it can run without 'unsafe-inline'. */
function inlineHashes(html: string): { script: string[]; style: string[] } {
  const hash = (body: string) => `'sha256-${crypto.createHash('sha256').update(body).digest('base64')}'`;
  const collect = (tag: 'script' | 'style') =>
    [...html.matchAll(new RegExp(`<${tag}(?![^>]*\\ssrc=)[^>]*>([\\s\\S]*?)</${tag}>`, 'gi'))].map(m => m[1]).filter(b => b.trim() !== '').map(hash);
  return { script: collect('script'), style: collect('style') };
}

function pageCsp(html: string, base: Record<string, string[] | null>): string {
  const { script, style } = inlineHashes(html);
  const merged = { ...base, scriptSrc: [...(base.scriptSrc ?? []), ...script], styleSrc: [...(base.styleSrc ?? []), ...style] };
  const kebab = (k: string) => k.replace(/[A-Z]/g, c => '-' + c.toLowerCase());
  return Object.entries(merged).filter(([, v]) => v !== null && v.length).map(([k, v]) => `${kebab(k)} ${(v as string[]).join(' ')}`).join('; ');
}

/**
 * Serves the single-page app: the Vite dev server only when NODE_ENV=development, the built files otherwise.
 *  - only DIST_DIR is served; the server bundle lives in dist-server/, outside it
 *  - a request for a file that does not exist is a 404, not index.html (the single-page-app fallback is for routes)
 *  - index.html is never cached, so an upgraded installation does not keep running yesterday's scripts
 *  - a static page other than index.html that carries inline script (public/backup.html) gets a CSP that allows
 *    exactly those blocks by hash
 */
export async function mountFrontend(app: Express, opts: FrontendOptions = {}) {
  const config = getConfig();

  if (config.isDevelopment) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({ server: { middlewareMode: true }, appType: 'spa' });
    app.use(vite.middlewares as unknown as RequestHandler);
    return;
  }

  const distPath = path.resolve(opts.distDir ?? config.distDir);

  app.use((req, res, next) => (NEVER_SERVED.test(req.path) ? res.status(404).type('text/plain').send('Not found') : next()));

  const pageCspCache = new Map<string, string>();
  app.use(express.static(distPath, {
    index: false,
    dotfiles: 'ignore',
    setHeaders(res, file) {
      if (!file.endsWith('.html')) return;
      if (path.basename(file) === 'index.html') { res.setHeader('Cache-Control', 'no-cache'); return; }
      let csp = pageCspCache.get(file);
      if (csp === undefined) {
        csp = pageCsp(fs.readFileSync(file, 'utf8'), cspDirectives);
        pageCspCache.set(file, csp);
      }
      res.setHeader('Content-Security-Policy', csp);
    },
  }));

  app.get('*', (req, res) => {
    if (path.extname(req.path) || !req.accepts('html')) return res.status(404).type('text/plain').send('Not found');
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(path.join(distPath, 'index.html'), (err) => { if (err && !res.headersSent) res.status(404).type('text/plain').send('Not found'); });
  });
}
