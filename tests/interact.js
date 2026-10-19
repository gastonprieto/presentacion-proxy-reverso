// Pruebas de interacción con Chrome headless: motor de mensajería y escenas.
// Uso: node tests/interact.js [filtro]   (filtro = parte del nombre de la prueba)
// Requiere `npm i` en presentaciones-guideline/tools (usa su puppeteer-core).
const path = require('path');
const puppeteer = require(path.resolve(__dirname, '../../presentaciones-guideline/tools/node_modules/puppeteer-core'));

const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const ROOT = path.resolve(__dirname, '..');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const filter = process.argv[2] || '';

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

/* ---------- helpers ---------- */

async function open(page, idx = 0, mobile = false) {
  await page.goto(`file://${ROOT}/index.html?mobile=${mobile ? 1 : 0}#/${idx}`);
  await sleep(600);
}

// Va a la slide idx y espera a que su escena exista (section._scene)
async function goto(page, idx) {
  await page.evaluate(i => Reveal.slide(i, 0, 99), idx);
  await page.waitForFunction(i => window.__sec(i)._scene, { timeout: 4000 }, idx);
}

// Ejecuta fn(section, ...args) en la página sobre la slide idx
async function evalScene(page, idx, fn, ...args) {
  await goto(page, idx);
  return page.evaluate(`(${fn})(window.__sec(${idx}), ...${JSON.stringify(args)})`);
}

// Ejecuta fn(svg, ...args) con un <svg> nuevo en la página (para probar motores sin slide)
async function engine(page, fn, ...args) {
  return page.evaluate(`(() => {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('style', 'position:fixed;left:0;top:0;width:900px;height:590px;opacity:0;pointer-events:none');
    document.body.appendChild(svg);
    try { return (${fn})(svg, ...${JSON.stringify(args)}); } finally { svg.remove(); }
  })()`);
}

function check(cond, msg) { if (!cond) throw new Error(msg); }

/* ---------- pruebas ---------- */

test('base: carga sin errores de consola', async (page, errors) => {
  await open(page, 0);
  check(errors.length === 0, `errores: ${errors.join(' | ')}`);
});

/* ---------- motor RouteKit ---------- */

const RINV = `w => w.sent === w.ok + w.e401 + w.e404 + w.e429 + w.e502 + w.cached + w.inFlight`;
const RULES = `[
  { match: { path: '/usuarios' }, to: 'usuarios' },
  { match: { path: '/ordenes' }, to: 'ordenes' },
  { match: { path: '/pagos' }, to: 'pagos' },
  { match: { path: '/static' }, to: 'web' }
]`;

test('route: lb reparte parejo', async page => {
  await open(page);
  const by = await engine(page, svg => {
    const s = new RouteKit.RouteSim(svg, { mode: 'lb', seed: 1 });
    s.fastForward(30);
    return s.window(60).byService;
  });
  const v = Object.values(by), avg = v.reduce((a, b) => a + b, 0) / v.length;
  check(v.length === 3, `servicios=${v.length}`);
  check(v.every(x => Math.abs(x - avg) <= avg * 0.1), `reparto=${JSON.stringify(by)}`);
});

test('route: proxy enruta por path', async page => {
  await open(page);
  const r = await engine(page, (svg, RULES) => {
    const s = new RouteKit.RouteSim(svg, { mode: 'proxy', seed: 1, rules: eval(RULES) });
    s.fastForward(20);
    const want = { '/usuarios': 'usuarios', '/ordenes': 'ordenes', '/pagos': 'pagos', '/static': 'web' };
    const bad = s.log.filter(e => e.to && want[e.path] !== e.to);
    return { n: s.log.filter(e => e.to).length, bad: bad.length, paths: new Set(s.log.map(e => e.path)).size };
  }, RULES);
  check(r.n > 20, `ruteados=${r.n}`);
  check(r.paths === 4, `rutas distintas=${r.paths}`);
  check(r.bad === 0, `mal ruteados=${r.bad}`);
});

test('route: ruta sin regla da 404', async page => {
  await open(page);
  const r = await engine(page, (svg, RULES, RINV) => {
    const s = new RouteKit.RouteSim(svg, { mode: 'proxy', seed: 1, rules: eval(RULES).filter(x => x.to !== 'pagos') });
    s.fastForward(20);
    const w = s.window(60);
    return { w, inv: eval(RINV)(w) };
  }, RULES, RINV);
  check(r.w.e404 > 0, `e404=${r.w.e404}`);
  check(r.inv, `invariante: ${JSON.stringify(r.w)}`);
});

test('route: cambio de regla en caliente', async page => {
  await open(page);
  const r = await engine(page, (svg, RULES, RINV) => {
    const s = new RouteKit.RouteSim(svg, { mode: 'proxy', seed: 1, rules: eval(RULES) });
    s.fastForward(5);
    s.addService({ id: 'pagos2', label: 'Pagos v2', icon: '💳' });
    s.setRule(2, { match: { path: '/pagos' }, to: 'pagos2' });
    s.fastForward(10);
    const w = s.window(60);
    return { w, inv: eval(RINV)(w) };
  }, RULES, RINV);
  check(r.w.byService.pagos2 > 0, `pagos2=${r.w.byService.pagos2}`);
  check(r.inv, `invariante: ${JSON.stringify(r.w)}`);
});

test('route: caché descarga al servicio', async page => {
  await open(page);
  const w = await engine(page, (svg, RULES) => {
    const s = new RouteKit.RouteSim(svg, { mode: 'proxy', seed: 1, rules: eval(RULES), features: { cache: true } });
    s.fastForward(20);
    return s.window(60);
  }, RULES);
  check(w.byService.web === 0, `web=${w.byService.web}`);
  check(w.cached > 0, `cached=${w.cached}`);
});

test('route: orden de filtros', async page => {
  await open(page);
  const r = await engine(page, (svg, RULES, RINV) => {
    const s = new RouteKit.RouteSim(svg, { mode: 'proxy', seed: 1, rules: eval(RULES), features: { auth: true, rateLimit: { perClient: 1 }, cache: true } });
    s.setClientRate('web', 5);
    s.fastForward(20);
    const w = s.window(60);
    return { w, inv: eval(RINV)(w), tokenless429: s.log.filter(e => e.status === 429 && !e.token).length };
  }, RULES, RINV);
  check(r.w.e401 > 0 && r.w.e429 > 0 && r.w.cached > 0, `e401=${r.w.e401} e429=${r.w.e429} cached=${r.w.cached}`);
  check(r.tokenless429 === 0, `429 sin token=${r.tokenless429}`);
  check(r.inv, `invariante: ${JSON.stringify(r.w)}`);
});

test('route: instancias de proxy', async page => {
  await open(page);
  const r = await engine(page, (svg, RULES) => {
    const s = new RouteKit.RouteSim(svg, { mode: 'proxy', seed: 1, rules: eval(RULES) });
    s.fastForward(3);
    const ok0 = s.window(60).ok;
    s.setProxyUp(0, false);
    s.fastForward(5);
    const a = s.window(60);
    s.setProxies(2);
    s.fastForward(5);
    const b = s.window(60);
    return { ok0, a, b };
  }, RULES);
  check(r.a.e502 > 0, `e502 con el proxy caído=${r.a.e502}`);
  check(r.a.ok <= r.ok0 + 4, `siguió respondiendo con el proxy caído: ${r.ok0} → ${r.a.ok}`);
  check(r.b.e502 === r.a.e502, `e502 con dos instancias: ${r.a.e502} → ${r.b.e502}`);
});

test('route: réplicas round robin', async page => {
  await open(page);
  const c = await engine(page, (svg, RULES) => {
    const svcs = RouteKit.DEFAULT_SERVICES.map(x => Object.assign({}, x, x.id === 'ordenes' ? { replicas: 3 } : {}));
    const s = new RouteKit.RouteSim(svg, { mode: 'proxy', seed: 1, rules: eval(RULES), services: svcs });
    s.fastForward(30);
    return s.replicaCounts('ordenes');
  }, RULES);
  const sum = c.reduce((a, b) => a + b, 0);
  check(c.length === 3, `réplicas=${c.length}`);
  check(c.every(x => Math.abs(x - sum / 3) <= 1), `reparto=${c}`);
});

test('route: reset limpia', async page => {
  await open(page);
  const r = await engine(page, (svg, RULES) => {
    const s = new RouteKit.RouteSim(svg, { mode: 'proxy', seed: 1, rules: eval(RULES) });
    s.fastForward(3);
    const before = svg.querySelectorAll('.pk').length;
    s.reset(s.o);
    const w = s.window(60);
    return { before, after: svg.querySelectorAll('.pk').length, sent: w.sent };
  }, RULES);
  check(r.after === 0 && r.sent === 0, `después del reset: pk=${r.after} sent=${r.sent}`);
});

test('route: resultados independientes de la velocidad', async page => {
  await open(page);
  const [a, b] = await engine(page, (svg, RULES) => [0.25, 1.5].map(v => {
    NetKit.Speed.value = v;
    const s = new RouteKit.RouteSim(svg, { mode: 'proxy', seed: 5, rules: eval(RULES) });
    s.fastForward(15);
    const w = s.window(60);
    return { sent: w.sent, ok: w.ok };
  }), RULES);
  check(a.sent === b.sent && a.ok === b.ok, `0,25×=${JSON.stringify(a)} 1,5×=${JSON.stringify(b)}`);
});

/* ---------- escenas ---------- */
// índices de slide (0 = portada)
const SL = { lb2proxy: 1, routing: 2, door: 3, edge: 4, replicas: 5, risks: 6, gateway: 7, summary: 8 };

test('escena: lb2proxy cambia de modo', async page => {
  await open(page);
  const r = await evalScene(page, SL.lb2proxy, sec => {
    const sim = sec._scene.sim;
    const lb = { mode: sim.o.mode, n: sim.svcs.length };
    sec.querySelector('.seg[data-group=mode] button[data-v=proxy]').click();
    return { lb, mode: sim.o.mode, labels: sim.svcs.map(s => s.label) };
  });
  check(r.lb.mode === 'lb' && r.lb.n === 3, `inicio: ${JSON.stringify(r.lb)}`);
  check(r.mode === 'proxy', `mode=${r.mode}`);
  check(r.labels.length === 4 && new Set(r.labels).size === 4, `servicios=${r.labels}`);
});

test('escena: routing select cambia regla', async page => {
  await open(page);
  const r = await evalScene(page, SL.routing, sec => {
    const sim = sec._scene.sim;
    sec.querySelector('[data-act=add]').click();
    const sel = sec.querySelector('.rules-table select[data-path="/pagos"]');
    sel.value = 'pagos2';
    sel.dispatchEvent(new Event('change'));
    sim.fastForward(10);
    return { pagos2: sim.window(60).byService.pagos2, rule: sim.o.rules.find(x => x.match.path === '/pagos').to };
  });
  check(r.rule === 'pagos2', `regla=${r.rule}`);
  check(r.pagos2 > 0, `pagos2=${r.pagos2}`);
});

test('escena: door separar', async page => {
  await open(page);
  const r = await evalScene(page, SL.door, sec => {
    const sim = sec._scene.sim;
    sec.querySelector('[data-act=split]').click();
    sim.fastForward(10);
    return { envios: sim.window(60).byService.envios, host: sim.clients.map(c => c.sub.textContent) };
  });
  check(r.envios > 0, `envios=${r.envios}`);
  check(r.host.every(h => h === 'tienda.com'), `dirección de los clientes: ${r.host}`);
});

/* ---------- runner ---------- */

(async () => {
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new' });
  let fails = 0, ran = 0;
  for (const t of tests.filter(t => t.name.includes(filter))) {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 720 });
    await page.evaluateOnNewDocument(() => {
      window.__sec = i => document.querySelectorAll('.reveal .slides > section')[i];
    });
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    page.on('console', m => m.type() === 'error' && errors.push(m.text()));
    ran++;
    try {
      await t.fn(page, errors);
      check(errors.length === 0, `errores de consola: ${errors.join(' | ')}`);
      console.log(`  ok   ${t.name}`);
    } catch (e) {
      fails++;
      console.log(`  FAIL ${t.name}\n       ${e.message.split('\n')[0]}`);
    }
    await page.close();
  }
  console.log(`${ran - fails}/${ran} ok`);
  await browser.close();
  process.exit(fails ? 1 : 0);
})();

module.exports = { open, goto, evalScene, engine, check, sleep };
