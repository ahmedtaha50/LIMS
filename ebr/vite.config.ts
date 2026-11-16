// The client build (r1-shell adds the client, its plugins and dependencies through a gate patch).
export default {
  root: 'client',
  build: { outDir: '../dist/client', emptyOutDir: true },
  server: { proxy: { '/api': 'http://127.0.0.1:4100' } },
};
