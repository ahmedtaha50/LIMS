import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import fs from 'fs';
import path from 'path';
import {defineConfig, Plugin} from 'vite';

// LINT.IfChange(aistudio_media_plugin)
function aistudioMediaPlugin(): Plugin {
  return {
    name: 'vite-plugin-aistudio-media',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.url && req.url.startsWith('/assets/aistudio/')) {
          const rawPath = req.url.split('?')[0].split('#')[0];
          try {
            const decodedPath = decodeURIComponent(rawPath);
            const relativePath = decodedPath.replace(/^\//, '');
            const aistudioDir = path.resolve(
              __dirname,
              'public',
              'assets',
              'aistudio',
            );
            const filePath = path.resolve(__dirname, 'public', relativePath);
            if (
              filePath.startsWith(aistudioDir + path.sep) &&
              fs.existsSync(filePath) &&
              fs.statSync(filePath).isFile()
            ) {
              const ext = path.extname(filePath).toLowerCase();
              const mimeMap: Record<string, string> = {
                '.jpg': 'image/jpeg',
                '.jpeg': 'image/jpeg',
                '.png': 'image/png',
                '.gif': 'image/gif',
                '.webp': 'image/webp',
                '.svg': 'image/svg+xml',
                '.bmp': 'image/bmp',
                '.ico': 'image/x-icon',
                '.mp4': 'video/mp4',
                '.webm': 'video/webm',
                '.ogv': 'video/ogg',
                '.mp3': 'audio/mpeg',
                '.wav': 'audio/wav',
                '.ogg': 'audio/ogg',
                '.pdf': 'application/pdf',
              };
              res.setHeader(
                'Content-Type',
                mimeMap[ext] || 'application/octet-stream',
              );
              res.setHeader('Cache-Control', 'no-cache');
              fs.createReadStream(filePath).pipe(res);
              return;
            }
          } catch {
            // Fall through if URI decoding or file access fails
          }
        }
        next();
      });
    },
  };
}
// LINT.ThenChange(//depot/google3/java/com/google/alkali/boq/makersuite/applet_dev_service/templates/initializers/react_theme/vite.config.ts:aistudio_media_plugin)

/**
 * Chunking (roadmap M43, r3-search-perf). The screens are split by React.lazy (src/App.tsx, src/components/shell/ext); this puts the large
 * libraries into chunks of their own so that
 *   - the first load does not carry code that only a click needs (the PDF stack with jsPDF and html2canvas, the QR/barcode decoder, the charts),
 *   - a release that changes only the application's own code keeps the libraries' file names, so a browser that has them does not fetch them again.
 * Only libraries that are imported by several screens, or are large, are named here; everything else follows its importer.
 */
function manualChunks(id: string): string | undefined {
  // Vite's dynamic-import helper is used by the entry; left alone it lands inside the first manual chunk that imports it (the PDF stack).
  if (id.includes('vite/preload-helper') || id.includes('commonjsHelpers')) return 'vendor-react';
  if (!id.includes('node_modules')) return undefined;
  const pkg = id.split('node_modules/').pop()!.split('/');
  const name = pkg[0].startsWith('@') ? `${pkg[0]}/${pkg[1]}` : pkg[0];
  if (['react', 'react-dom', 'scheduler'].includes(name)) return 'vendor-react';
  if (['jspdf', 'jspdf-autotable', 'html2canvas', 'dompurify', 'canvg'].includes(name)) return 'vendor-pdf';
  if (name === 'html5-qrcode') return 'vendor-scanner';
  if (name === 'recharts' || name.startsWith('d3-') || name === 'd3' || name === 'victory-vendor' || name === 'internmap' || name === 'decimal.js-light') return 'vendor-charts';
  if (name === 'zod') return 'vendor-zod';
  return undefined;
}

export default defineConfig(() => {
  return {
    plugins: [react(), tailwindcss(), aistudioMediaPlugin()],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    build: {
      rollupOptions: { output: { manualChunks } },
      // The PDF stack is about 600 KB and is fetched only when the Reports screen is opened; it is not part of the first load (tests/perf/bundle.cjs).
      chunkSizeWarningLimit: 700,
    },
    server: {
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      // Do not modifyâfile watching is disabled to prevent flickering during agent edits.
      hmr: process.env.DISABLE_HMR !== 'true',
      // Disable file watching when DISABLE_HMR is true to save CPU during agent edits.
      watch: process.env.DISABLE_HMR === 'true' ? null : {},
    },
  };
});
