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

const RINV = `w => w.sent === w.ok + w.e401 + w.e404 + w.e429 + w.e502 + w.econn + w.cached + w.inFlight`;
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
  check(r.a.econn > 0 && r.a.e502 === 0, `proxy caído: econn=${r.a.econn} e502=${r.a.e502}`);
  check(r.a.ok <= r.ok0 + 4, `siguió respondiendo con el proxy caído: ${r.ok0} → ${r.a.ok}`);
  check(r.b.econn === r.a.econn, `econn con dos instancias: ${r.a.econn} → ${r.b.econn}`);
});

test('route: servicio caído da 502 del proxy, no error de conexión al cliente', async page => {
  await open(page);
  const r = await engine(page, (svg, RULES, RINV) => {
    const s = new RouteKit.RouteSim(svg, { mode: 'proxy', seed: 2, rules: eval(RULES) });
    s.svcs.find(x => x.id === 'pagos').up = false;
    s.fastForward(20);
    const w = s.window(60);
    return { w, inv: eval(RINV)(w), pagos502: s.log.filter(e => e.to === 'pagos' && e.status === 502).length };
  }, RULES, RINV);
  check(r.w.e502 > 0 && r.w.econn === 0, `e502=${r.w.e502} econn=${r.w.econn}`);
  check(r.pagos502 === r.w.e502, `502 sólo de pagos: ${r.pagos502}/${r.w.e502}`);
  check(r.inv, `invariante: ${JSON.stringify(r.w)}`);
});

test('route: returns lleva la respuesta al cliente', async page => {
  await open(page);
  const r = await engine(page, (svg, RINV) => {
    const s = new RouteKit.RouteSim(svg, { mode: 'proxy', seed: 3, returns: true });
    s.fastForward(10);
    const w = s.window(60);
    s.setClientRate('web', 0); s.setClientRate('movil', 0);
    s.fastForward(5);
    const w2 = s.window(60);
    return { ok: w.ok, inv: eval(RINV)(w), inv2: eval(RINV)(w2), left: w2.inFlight };
  }, RINV);
  check(r.ok > 0 && r.inv && r.inv2, `ok=${r.ok} invariante=${r.inv}/${r.inv2}`);
  check(r.left === 0, `quedaron en vuelo: ${r.left}`);
});

test('route: compresión baja KB/s', async page => {
  await open(page);
  const r = await engine(page, () => {
    const run = compress => {
      const s = new RouteKit.RouteSim(svg2(), { mode: 'proxy', seed: 4, returns: true, features: { compress } });
      s.fastForward(12);
      return s.window(5).kbps;
    };
    function svg2() { const e = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); document.body.appendChild(e); return e; }
    return { plain: run(false), gz: run(true) };
  });
  check(r.plain > 0 && r.gz < r.plain * 0.5, `KB/s sin=${r.plain} con=${r.gz}`);
});

test('route: sin token rebota a su cliente', async page => {
  await open(page);
  const r = await engine(page, (svg, RINV) => {
    const s = new RouteKit.RouteSim(svg, { mode: 'proxy', seed: 5, returns: true, colorBy: 'client', features: { auth: true } });
    s.fastForward(15);
    const e401 = s.log.filter(e => e.status === 401);
    return { n: e401.length, tokens: e401.every(e => !e.token), clients: [...new Set(e401.map(e => e.client))], inv: eval(RINV)(s.window(60)) };
  }, RINV);
  check(r.n > 0 && r.tokens, `401=${r.n} todos sin token=${r.tokens}`);
  check(r.clients.length === 2, `clientes rechazados=${r.clients}`);
  check(r.inv, 'invariante');
});

test('route: regla al servicio equivocado da 404 del servicio', async page => {
  await open(page);
  const r = await engine(page, (svg, RINV) => {
    const s = new RouteKit.RouteSim(svg, { mode: 'proxy', seed: 6 });
    s.setRule(0, { match: { path: '/usuarios' }, to: 'pagos' });
    s.fastForward(20);
    const e = s.log.filter(x => x.status === 404);
    return { n: e.length, fromPagos: e.every(x => x.to === 'pagos' && x.path === '/usuarios'), pagosOk: s.log.filter(x => x.status === 200 && x.path === '/pagos').length, inv: eval(RINV)(s.window(60)) };
  }, RINV);
  check(r.n > 0 && r.fromPagos, `404=${r.n} desde pagos=${r.fromPagos}`);
  check(r.pagosOk > 0, `pagos sigue atendiendo /pagos: ${r.pagosOk}`);
  check(r.inv, 'invariante');
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

test('route: quitar réplicas no resta pedidos', async page => {
  await open(page);
  const r = await engine(page, svg => {
    const svcs = RouteKit.DEFAULT_SERVICES.map(x => Object.assign({}, x, x.id === 'ordenes' ? { replicas: 3 } : {}));
    const s = new RouteKit.RouteSim(svg, { mode: 'proxy', seed: 1, services: svcs });
    s.fastForward(10);
    const a = s.window(60).byService.ordenes;
    s.setReplicas('ordenes', 2);
    return { a, b: s.window(60).byService.ordenes, reps: s.replicaCounts('ordenes').length };
  });
  check(r.reps === 2, `réplicas=${r.reps}`);
  check(r.b >= r.a, `el total bajó: ${r.a} → ${r.b}`);
});

test('route: el LB no dice que round robin es por carga', async page => {
  await open(page);
  const t = await engine(page, svg => {
    const s = new RouteKit.RouteSim(svg, { mode: 'lb', seed: 1 });
    s._frame();
    return s.instances[0].sub.textContent;
  });
  check(t === 'Round Robin · entre iguales', `texto=${t}`);
});

test('mobile: el select de reglas mide 16px o más', async page => {
  await open(page, 0, true);
  const px = await page.evaluate(async i => {
    const sec = window.__sec(i);
    sec.scrollIntoView();
    for (let k = 0; k < 40 && !sec.querySelector('.rules-table select'); k++) await new Promise(r => setTimeout(r, 100));
    const sel = sec.querySelector('.rules-table select');
    return sel ? parseFloat(getComputedStyle(sel).fontSize) : -1;
  }, SL.routing);
  check(px >= 16, `font-size=${px}`);
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

test('escena: edge caché', async page => {
  await open(page);
  const r = await evalScene(page, SL.edge, sec => {
    const sim = sec._scene.sim;
    const box = sec.querySelector('input[data-feature=cache]');
    box.checked = true;
    box.dispatchEvent(new Event('change'));
    const web0 = sim.window(60).byService.web;
    sim.fastForward(10);
    const w = sim.window(60);
    return { cache: sim.o.features.cache, web: w.byService.web - web0, cached: w.cached };
  });
  check(r.cache === true, 'caché no se prendió');
  check(r.web === 0, `web recibió ${r.web} con caché`);
  check(r.cached > 0, `cached=${r.cached}`);
});

test('escena: replicas ＋', async page => {
  await open(page);
  const r = await evalScene(page, SL.replicas, sec => {
    const sim = sec._scene.sim;
    for (let i = 0; i < 2; i++) sec.querySelector('[data-act=add]').click();
    sim.fastForward(20);
    return sim.replicaCounts('ordenes');
  });
  check(r.length === 5, `réplicas=${r.length}`);
  check(r.every(x => x > 0), `reparto=${r}`);
});

test('escena: risks apagar y segunda instancia', async page => {
  await open(page);
  const r = await evalScene(page, SL.risks, sec => {
    const sim = sec._scene.sim;
    sim.instances[0].g.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    sim.fastForward(5);
    const a = sim.window(60).econn;
    sim.setProxyUp(0, true);
    sec.querySelector('[data-act=second]').click();
    sim.fastForward(1);
    const pas = sim.instances[1].g.classList.contains('passive') && !sim.instances[0].g.classList.contains('passive');
    sim.instances[0].g.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    sim.fastForward(5);
    return { a, pas, b: sim.window(60).econn, n: sim.instances.length, up0: sim.instances[0].up, act1: !sim.instances[1].g.classList.contains('passive') };
  });
  check(r.a > 0, `econn=${r.a}`);
  check(r.n === 2 && r.up0 === false, `instancias=${r.n} up0=${r.up0}`);
  check(r.b === r.a, `econn con dos instancias: ${r.a} → ${r.b}`);
  check(r.pas && r.act1, `activo/pasivo: pasiva=${r.pas} toma el rol=${r.act1}`);
});

test('escena: gateway medidor por cliente', async page => {
  await open(page);
  const r = await evalScene(page, SL.gateway, sec => {
    const sim = sec._scene.sim;
    const b = sec.querySelector('input[data-feature=rateLimit]'); b.checked = true; b.dispatchEvent(new Event('change'));
    sec.querySelector('.seg[data-group=abuse] button[data-v=flood]').click();
    sim.fastForward(4);
    const [web, movil] = sim.clients;
    return { webOver: web.g.classList.contains('over'), movilOver: movil.g.classList.contains('over'), abuse: movil.g.classList.contains('abuse'), sub: movil.sub.textContent };
  });
  check(r.movilOver && r.abuse && !r.webOver, JSON.stringify(r));
  check(/^\d+\/5 por seg$/.test(r.sub), `medidor=${r.sub}`);
});

test('escena: gateway tipos de abuso', async page => {
  await open(page);
  const r = await evalScene(page, SL.gateway, sec => {
    const sim = sec._scene.sim;
    const tog = f => { const b = sec.querySelector(`input[data-feature=${f}]`); b.checked = true; b.dispatchEvent(new Event('change')); };
    const pick = v => sec.querySelector(`.seg[data-group=abuse] button[data-v=${v}]`).click();
    const by = (st, t0) => sim.log.filter(e => e.status === st && e.t >= t0 && e.client === 'movil').length;
    tog('auth');
    pick('notoken'); let t0 = sim.now; sim.fastForward(10);
    const nt = { e401: by(401, t0), ok: by(200, t0 + 2), shown: !sec.querySelector('[data-mode=notoken]').hidden };
    pick('scan'); t0 = sim.now; sim.fastForward(10);
    const sc = { e404: by(404, t0), web404: sim.log.filter(e => e.status === 404 && e.client === 'web').length };
    sec.querySelector('[data-act=reset]').click();
    const rs = { active: sec.querySelector('.seg[data-group=abuse] .active').dataset.v, beh: sim.o.clients[1].behavior || 'normal' };
    return { nt, sc, rs };
  });
  check(r.nt.e401 > 0 && r.nt.ok === 0 && r.nt.shown, `sin token: ${JSON.stringify(r.nt)}`);
  check(r.sc.e404 > 0 && r.sc.web404 === 0, `escanea: ${JSON.stringify(r.sc)}`);
  check(r.rs.active === 'normal' && r.rs.beh === 'normal', `reset: ${JSON.stringify(r.rs)}`);
});

test('escena: gateway 401 y 429', async page => {
  await open(page);
  const r = await evalScene(page, SL.gateway, sec => {
    const sim = sec._scene.sim;
    const tog = f => { const b = sec.querySelector(`input[data-feature=${f}]`); b.checked = true; b.dispatchEvent(new Event('change')); };
    tog('auth');
    sim.fastForward(10);
    const e401 = sim.window(60).e401;
    tog('rateLimit');
    sec.querySelector('.seg[data-group=abuse] button[data-v=flood]').click();
    sim.fastForward(10);
    const w = sim.window(60);
    return { e401, e429: w.e429, clients: [...new Set(sim.log.filter(e => e.status === 429).map(e => e.client))] };
  });
  check(r.e401 > 0, `e401=${r.e401}`);
  check(r.e429 > 0, `e429=${r.e429}`);
  check(r.clients.length === 1 && r.clients[0] === 'movil', `429 de: ${r.clients}`);
});

test('estática: frase del gateway', async page => {
  await open(page);
  const t = await page.evaluate(i => window.__sec(i) ? window.__sec(i).textContent : '', SL.gateway);
  check(t.includes('no todo proxy reverso es un API gateway'), 'falta la frase');
});

test('estática: resumen nombra Nginx y Kong', async page => {
  await open(page);
  const t = await page.evaluate(i => window.__sec(i) ? window.__sec(i).textContent : '', SL.summary);
  check(t.includes('Nginx') && t.includes('Kong'), 'faltan Nginx / Kong');
});

test('notas: las 9 slides con pregunta', async page => {
  await open(page);
  const r = await page.evaluate(() => [...document.querySelectorAll('.reveal .slides > section')]
    .map((s, i) => (s.querySelector('aside.notes') && s.querySelector('aside.notes').textContent.includes('?') ? 0 : i + 1)));
  check(r.length === 9, `slides=${r.length}`);
  check(!r.filter(Boolean).length, `sin pregunta: ${r.filter(Boolean)}`);
});

test('escena: portada anima en escritorio', async page => {
  await open(page);
  await page.waitForFunction(() => window.__sec(0)._scene, { timeout: 4000 });
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
