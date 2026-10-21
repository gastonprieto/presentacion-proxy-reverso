// Servicio de la tienda para el laboratorio de proxy reverso. Sin dependencias.
// Sólo entiende las rutas que empiezan con PREFIJO; el resto lo contesta con 404
// (así se distingue un 404 del servicio de uno del proxy).
const http = require('node:http');
const os = require('node:os');

const NOMBRE = process.env.NOMBRE || 'Servicio';
const PREFIJO = process.env.PREFIJO || '/';
const PORT = 3000;
const replica = os.hostname().slice(0, 6);
let atendidos = 0;

// Un "bundle" grande para que se note la compresión y la caché del proxy.
const bundle = '// app.js de la tienda\n' + Array.from({ length: 2000 }, (_, i) =>
  `export function componente${i}() { return 'tienda.com: componente ${i} de la interfaz'; }`).join('\n') + '\n';

const log = (...a) => console.log(`[${NOMBRE} ${replica}]`, ...a);

http.createServer((req, res) => {
  const path = new URL(req.url, 'http://x').pathname;
  const h = req.headers;
  const ip = req.socket.remoteAddress.replace('::ffff:', '');
  log(`${req.method} ${req.url} · desde ${ip} · X-Forwarded-For: ${h['x-forwarded-for'] || '-'} · proto: ${h['x-forwarded-proto'] || 'http'}${h['x-cliente'] ? ' · cliente: ' + h['x-cliente'] : ''}`);
  res.setHeader('X-Servicio', `${NOMBRE} ${replica}`);

  if (path === '/health') return res.end('ok\n');
  if (path !== PREFIJO && !path.startsWith(PREFIJO.replace(/\/?$/, '/'))) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end(`404 de ${NOMBRE}: el pedido llegó, pero ${NOMBRE} no conoce ${path}\n`);
  }
  atendidos++;
  if (path.startsWith('/static/')) {
    res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8' });
    return res.end(bundle);
  }
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(`${NOMBRE} (réplica ${replica}) atendió ${req.method} ${path} · pedido #${atendidos} · llegó por ${h['x-forwarded-proto'] || 'http'} desde ${h['x-forwarded-for'] || ip}\n`);
}).listen(PORT, () => log(`escuchando en :${PORT}, atiendo ${PREFIJO}`));

process.on('SIGTERM', () => process.exit(0));
