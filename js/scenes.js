/* Una función por slide interactiva. Cada una recibe el <section> y devuelve { start, stop }.
   main.js las crea la primera vez que se visita la slide y las pausa al salir.
   Para una slide nueva: <section data-scene="nombre"> en index.html + S.nombre = slide => { … } acá. */
(function () {
  'use strict';

  const { Sim, Clock, svgEl, cubic, curve, edge, pop, C } = window.NetKit;
  const S = {};

  /* ---------- helpers ---------- */

  // Crea la Sim sobre <svg class="sim"> y conecta los widgets que haya en la slide:
  // .stats (data-fields, data-window), .strip, canvas.chart, canvas.histo
  function setup(slide, opts) {
    const sim = new Sim(slide.querySelector('svg.sim'), opts);
    const st = slide.querySelector('.stats');
    if (st) Widgets.stats(st, sim, st.dataset.fields ? st.dataset.fields.split(',') : null, +(st.dataset.window || 5));
    const strip = slide.querySelector('.strip');
    if (strip) Widgets.strip(strip, sim);
    const cv = slide.querySelector('canvas.chart');
    if (cv) Widgets.chart(cv, sim);
    const hist = slide.querySelector('canvas.histo');
    if (hist) Widgets.histogram(hist, sim);
    return sim;
  }

  function on(slide, sel, fn) {
    slide.querySelectorAll(sel).forEach(b => b.addEventListener('click', e => { fn(b, e); b.blur(); }));
  }

  // Control segmentado: <div class="seg" data-group="x"><button data-v="a">…
  function seg(slide, group, fn) {
    const root = slide.querySelector(`.seg[data-group="${group}"]`);
    root.querySelectorAll('button').forEach(b => b.addEventListener('click', () => {
      root.querySelectorAll('button').forEach(x => x.classList.toggle('active', x === b));
      b.blur();
      fn(b.dataset.v);
    }));
  }

  // Muestra solo los elementos [data-mode] que coinciden
  function showMode(slide, mode) {
    slide.querySelectorAll('[data-mode]').forEach(el => { el.hidden = el.dataset.mode !== mode; });
  }

  const life = sim => ({ start: () => sim.start(), stop: () => sim.stop(), sim });

  // Crea un RouteSim sobre <svg class="sim"> y conecta .rstats y .rules-table si existen
  function rsetup(slide, opts, editable) {
    const sim = new RouteKit.RouteSim(slide.querySelector('svg.sim'), opts);
    const st = slide.querySelector('.rstats');
    if (st) Widgets.rstats(st, sim, st.dataset.fields.split(','), +(st.dataset.window || 5));
    const rt = slide.querySelector('.rules-table');
    if (rt) Widgets.rules(rt, sim, editable);
    return sim;
  }

  /* ---------- 2. del LB al proxy: mismo lugar, otro criterio ---------- */

  S.lb2proxy = slide => {
    const sim = rsetup(slide, { mode: 'lb', seed: 2 });
    showMode(slide, 'lb');
    seg(slide, 'mode', v => { showMode(slide, v); sim.reset({ mode: v, seed: 2 }); });
    return life(sim);
  };

  /* ---------- 3. enrutamiento: tabla de reglas editable ---------- */

  S.routing = slide => {
    const base = { mode: 'proxy', seed: 3 };
    const sim = rsetup(slide, base, true);
    const add = slide.querySelector('[data-act=add]');
    on(slide, '[data-act=add]', () => { sim.addService({ id: 'pagos2', label: 'Pagos v2', icon: '💳' }); add.disabled = true; });
    on(slide, '[data-act=reset]', () => { sim.reset(base); add.disabled = false; });
    return life(sim);
  };

  /* ---------- 4. una sola puerta: separar un servicio sin que el cliente se entere ---------- */

  S.door = slide => {
    const base = { mode: 'proxy', seed: 4, mix: { '/usuarios': 1, '/ordenes': 1, '/ordenes/envios': 1.5, '/pagos': 1 },
      services: RouteKit.DEFAULT_SERVICES.filter(x => x.id !== 'web'),
      rules: RouteKit.DEFAULT_RULES.filter(x => x.to !== 'web') };
    const sim = rsetup(slide, base, false);
    const btn = slide.querySelector('[data-act=split]');
    on(slide, '[data-act=split]', () => {
      sim.addService({ id: 'envios', label: 'Envíos', icon: '🚚' });
      sim.insertRule(1, { match: { path: '/ordenes/envios' }, to: 'envios' });
      btn.disabled = true;
    });
    on(slide, '[data-act=reset]', () => { sim.reset(base); btn.disabled = false; });
    return life(sim);
  };

  // Checkboxes <input data-feature="x"> → sim.setFeature
  function toggles(slide, sim, values) {
    slide.querySelectorAll('input[data-feature]').forEach(box => {
      const f = box.dataset.feature;
      box.checked = !!sim.o.features[f];
      box.addEventListener('change', () => { sim.setFeature(f, box.checked ? (values && values[f]) || true : (f === 'rateLimit' ? null : false)); box.blur(); });
    });
    sim.on('reset', () => slide.querySelectorAll('input[data-feature]').forEach(box => { box.checked = !!sim.o.features[box.dataset.feature]; }));
  }

  /* ---------- 5. en la puerta: TLS, caché, compresión ---------- */

  S.edge = slide => {
    const sim = rsetup(slide, { mode: 'proxy', seed: 5, returns: true, scheme: true, mix: { '/usuarios': 1, '/ordenes': 1, '/pagos': 1, '/static': 2 } });
    toggles(slide, sim);
    return life(sim);
  };

  /* ---------- 6. proxy + LB: réplicas dentro de cada servicio ---------- */

  S.replicas = slide => {
    const reps = { usuarios: 2, ordenes: 3, pagos: 2 };
    const base = { mode: 'proxy', seed: 6, mix: { '/usuarios': 1, '/ordenes': 2, '/pagos': 1 },
      services: RouteKit.DEFAULT_SERVICES.filter(x => x.id !== 'web').map(x => Object.assign({}, x, { replicas: reps[x.id] })),
      rules: RouteKit.DEFAULT_RULES.filter(x => x.to !== 'web') };
    const sim = rsetup(slide, base);
    const n = () => sim.replicaCounts('ordenes').length;
    on(slide, '[data-act=add]', () => sim.setReplicas('ordenes', n() + 1));
    on(slide, '[data-act=remove]', () => sim.setReplicas('ordenes', n() - 1));
    on(slide, '[data-act=reset]', () => sim.reset(base));
    return life(sim);
  };

  /* ---------- 7. riesgos: punto único de falla ---------- */

  S.risks = slide => {
    const base = { mode: 'proxy', seed: 7, clickProxy: true };
    const sim = rsetup(slide, base);
    const btn = slide.querySelector('[data-act=second]');
    on(slide, '[data-act=second]', () => { sim.setProxies(2); btn.disabled = true; });
    on(slide, '[data-act=reset]', () => { sim.reset(base); btn.disabled = false; });
    return life(sim);
  };

  /* ---------- 1. portada: proxy decorativo de fondo ---------- */

  S.title = slide => life(new RouteKit.RouteSim(slide.querySelector('svg.bg'), { mode: 'proxy', seed: 11, pops: false }));

  /* ---------- 8. API gateway: autenticación y límite por cliente ---------- */

  S.gateway = slide => {
    const base = { mode: 'proxy', seed: 8, clients: [{ id: 'web', label: 'Navegador', icon: '💻', rate: 1 }, { id: 'movil', label: 'App móvil', icon: '📱', rate: 1 }], proxyLabel: 'API gateway', returns: true, colorBy: 'client' };
    const sim = rsetup(slide, base);
    toggles(slide, sim, { rateLimit: { perClient: 5 } });
    const pick = v => {
      slide.querySelectorAll('.seg[data-group=abuse] button').forEach(b => b.classList.toggle('active', b.dataset.v === v));
      showMode(slide, v);
    };
    pick('normal');
    seg(slide, 'abuse', v => { sim.setClientBehavior('movil', v); showMode(slide, v); });
    on(slide, '[data-act=reset]', () => { sim.reset(base); pick('normal'); });
    return life(sim);
  };

  window.Scenes = S;
})();
