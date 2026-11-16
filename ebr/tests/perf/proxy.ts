import http from 'node:http';

/**
 * A round-robin reverse proxy for the capacity test, doing what the production proxy (deploy/proxy/nginx.conf) does:
 * spread requests over the instances and, when an instance does not accept the connection, send the request to the next
 * one. Only a refused connection is retried: the request never reached a server, so it cannot be recorded twice.
 */
export function startProxy(port: number, upstreams: number[]) {
  let next = 0;
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      // a retry goes to the NEXT instance after the one that refused (as nginx proxy_next_upstream does), not to the next one
      // in the global rotation, which may be the same stopped instance again
      const first = next++;
      const tryUpstream = (attempt: number) => {
        const target = upstreams[(first + attempt - 1) % upstreams.length]!;
        const up = http.request({ agent: false, host: '127.0.0.1', port: target, method: req.method, path: req.url, headers: { ...req.headers, 'x-forwarded-for': req.socket.remoteAddress ?? '' } }, (r) => {
          res.writeHead(r.statusCode ?? 502, r.headers);
          r.pipe(res);
        });
        up.on('error', (e: NodeJS.ErrnoException) => {
          if (e.code === 'ECONNREFUSED' && attempt < upstreams.length) return tryUpstream(attempt + 1);
          if (!res.headersSent) { res.writeHead(502, { 'content-type': 'application/json' }); res.end(JSON.stringify({ code: 'bad_gateway', message: e.message })); }
        });
        up.end(body);
      };
      tryUpstream(1);
    });
  });
  server.keepAliveTimeout = 5000;
  return new Promise<http.Server>(r => server.listen(port, '127.0.0.1', () => r(server)));
}
