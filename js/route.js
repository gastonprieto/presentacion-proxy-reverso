/* Motor de ruteo para las slides: clientes → proxy reverso (o LB) → servicios (con réplicas).
   Modos: 'lb' (reparte entre copias iguales, round robin) y 'proxy' (elige el servicio por la ruta).
   En la puerta, en este orden: proxy caído → error de conexión · sin token → 401 · límite por cliente → 429 ·
   caché de /static → respuesta desde el proxy · sin regla → 404 · si no, al servicio de la regla.
   Usa el Clock y la geometría de NetKit. Expone window.RouteKit = { RouteSim, rng, ROUTE_COLORS, DEFAULT_SERVICES }. */
(function () {
  'use strict';

  const { Clock, Speed, svgEl, cubic, curve, edge, pop, C, MOBILE, W, H } = window.NetKit;
  const PINK = '#f472b6';

  const ROUTE_COLORS = { '/usuarios': '#60a5fa', '/ordenes': '#fb923c', '/pagos': '#2dd4bf', '/static': '#e2e8f0', '/ordenes/envios': '#a3e635' };

  function rng(seed) {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6D2B79F5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  const DEFAULT_SERVICES = [
    { id: 'usuarios', label: 'Usuarios', icon: '👤', replicas: 1, workTime: 0.5 },
    { id: 'ordenes', label: 'Órdenes', icon: '🧾', replicas: 1, workTime: 0.5 },
    { id: 'pagos', label: 'Pagos', icon: '💳', replicas: 1, workTime: 0.5 },
    { id: 'web', label: 'Web', icon: '🖼', replicas: 1, workTime: 0.3 }
  ];
  const LB_SERVICES = [1, 2, 3].map(i => ({ id: `app${i}`, label: `App ${i}`, icon: '🖥', replicas: 1, workTime: 0.5 }));
  const DEFAULT_RULES = [
    { match: { path: '/usuarios' }, to: 'usuarios' },
    { match: { path: '/ordenes' }, to: 'ordenes' },
    { match: { path: '/pagos' }, to: 'pagos' },
    { match: { path: '/static' }, to: 'web' }
  ];

  const DEFAULTS = {
    mode: 'proxy', seed: 1, travel: 0.35, noTokenRatio: 0.2, proxies: 1, host: 'tienda.com',
    clients: [{ id: 'web', label: 'Navegador', icon: '💻', rate: 2 }, { id: 'movil', label: 'App móvil', icon: '📱', rate: 1 }],
    mix: { '/usuarios': 1, '/ordenes': 1, '/pagos': 1, '/static': 1 },
    services: null, rules: null,
    features: { cache: false, tls: false, compress: false, auth: false, rateLimit: null },
    clickProxy: false, clickServices: false, pops: true, proxyLabel: 'Proxy reverso'
  };

  const clone = x => JSON.parse(JSON.stringify(x));
  const quant = (arr, q) => {
    if (!arr.length) return null;
    const s = arr.slice().sort((a, b) => a - b);
    return s[Math.min(s.length - 1, Math.floor(q * s.length))];
  };

  class RouteSim {
    constructor(svg, opts) {
      this.svg = svg;
      this.v = MOBILE;
      svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
      svg.classList.add('netsim', 'routesim');
      this.clock = new Clock();
      this.clock.onTick = () => this._frame();
      this.listeners = {};
      this.reset(opts);
    }

    on(ev, fn) { (this.listeners[ev] = this.listeners[ev] || []).push(fn); }
    emit(ev, ...a) { (this.listeners[ev] || []).forEach(f => f(...a)); }
    start() { this.clock.start(); }
    stop() { this.clock.stop(); }
    get now() { return this.clock.now; }

    reset(opts) {
      if (opts) {
        const o = Object.assign({}, DEFAULTS, clone(opts));
        o.features = Object.assign({}, DEFAULTS.features, o.features);
        o.clients = clone(o.clients || DEFAULTS.clients);
        o.services = clone(o.services || (o.mode === 'lb' ? LB_SERVICES : DEFAULT_SERVICES));
        o.rules = clone(o.rules || (o.mode === 'lb' ? [] : DEFAULT_RULES));
        if (o.mode === 'lb' && !opts.mix) o.mix = { '/usuarios': 1, '/ordenes': 1, '/pagos': 1 };
        this.base = clone(o);
      }
      this.o = clone(this.base);
      this.gen = (this.gen || 0) + 1;
      this.rand = rng(this.o.seed);
      this.clock.clear();
      this.svg.innerHTML = '';
      this.gLinks = svgEl('g', {}, this.svg);
      this.gNodes = svgEl('g', {}, this.svg);
      this.gPk = svgEl('g', {}, this.svg);
      this.gTop = svgEl('g', {}, this.svg);
      this.links = [];
      this.c = { sent: 0, ok: 0, e401: 0, e404: 0, e429: 0, e502: 0, econn: 0, cached: 0 };
      this.log = []; this.lat = []; this.flying = new Set(); this.seq = 0; this.rr = 0;
      this.hits = {};
      this._build();
      this.o.clients.forEach(c => this._schedule(c));
      this._frame();
      this.emit('reset');
    }

    /* ---------- topología ---------- */

    _build() {
      const v = this.v, n = this.o.clients.length;
      this.clients = this.o.clients.map((c, i) => {
        const node = v ? { x: W * (i + 0.5) / n, y: 38, hw: Math.min(90, W / n / 2 - 8), hh: 24 } : { x: 95, y: H * (i + 1) / (n + 1), hw: 78, hh: 30 };
        Object.assign(node, { def: c, kind: 'client' });
        node.g = svgEl('g', { class: 'client', transform: `translate(${node.x},${node.y})` }, this.gNodes);
        node.g.style.setProperty('--c', '#7dd3fc');
        svgEl('rect', { class: 'node-box', x: -node.hw, y: -node.hh, width: node.hw * 2, height: node.hh * 2, rx: 10 }, node.g);
        svgEl('text', { x: 0, y: -3, class: 't-title small', 'text-anchor': 'middle' }, node.g).textContent = `${c.icon} ${c.label}`;
        node.sub = svgEl('text', { x: 0, y: 13, class: 't-sub', 'text-anchor': 'middle' }, node.g);
        node.sub.textContent = this.o.host;
        return node;
      });
      this.proxyBox = v ? { x: W / 2, y: 140, hw: 150, hh: 40 } : { x: 360, y: H / 2, hw: 96, hh: 64 };
      this.proxyG = svgEl('g', { class: 'lb proxy' }, this.gNodes);
      this.instances = [];
      this._buildProxies();
      this.svcs = [];
      this.o.services.forEach(s => this._addSvc(s, false));
      this._layoutSvcs(false);
      this.clients.forEach(c => this._link(c, this.proxyBox));
    }

    _buildProxies() {
      this.proxyG.innerHTML = '';
      const b = this.proxyBox, n = this.o.proxies;
      const prev = this.instances;
      this.instances = [];
      for (let i = 0; i < n; i++) {
        const gap = this.v ? 0 : 10;
        const node = this.v
          ? { x: b.x + (n === 1 ? 0 : (i - 0.5) * (b.hw + 4)), y: b.y, hw: n === 1 ? b.hw : b.hw / 2 - 2, hh: b.hh }
          : { x: b.x, y: n === 1 ? b.y : b.y + (i - 0.5) * (b.hh + gap / 2), hw: b.hw, hh: n === 1 ? b.hh : b.hh / 2 - gap / 2 };
        node.up = prev[i] ? prev[i].up : true;
        node.g = svgEl('g', { class: 'inst', transform: `translate(${node.x},${node.y})` }, this.proxyG);
        node.box = svgEl('rect', { class: 'node-box', x: -node.hw, y: -node.hh, width: node.hw * 2, height: node.hh * 2, rx: 12 }, node.g);
        const big = n === 1;
        node.title = svgEl('text', { x: 0, y: big ? -16 : -4, class: 't-title', 'text-anchor': 'middle' }, node.g);
        node.title.textContent = this.o.mode === 'lb' ? 'Load Balancer' : `🔀 ${this.o.proxyLabel}${n > 1 ? ` ${i + 1}` : ''}`;
        node.sub = svgEl('text', { x: 0, y: big ? 4 : 12, class: 't-lb', 'text-anchor': 'middle' }, node.g);
        node.badges = svgEl('text', { x: 0, y: big ? 28 : 12, class: 't-sub', 'text-anchor': 'middle' }, node.g);
        if (this.o.clickProxy) {
          node.g.classList.add('clickable');
          node.g.addEventListener('click', () => this.setProxyUp(i, !node.up));
        }
        this.instances.push(node);
      }
    }

    _addSvc(def, fresh) {
      const s = Object.assign({ replicas: 1, workTime: 0.5 }, def, { x: 0, y: 0, hw: 110, hh: 30, scale: fresh ? 0 : 1, n: 0, total: 0, active: 0, up: true });
      s.counts = Array(s.replicas).fill(0);
      s.g = svgEl('g', { class: 'srv svc' }, this.gNodes);
      s.inner = svgEl('g', {}, s.g);
      s.stripe = svgEl('rect', { class: 'stripe', width: 6, rx: 3 }, s.inner);
      s.box = svgEl('rect', { class: 'node-box', rx: 10 }, s.inner);
      s.title = svgEl('text', { class: 't-title small' }, s.inner);
      s.sub = svgEl('text', { class: 't-sub' }, s.inner);
      s.reps = svgEl('g', {}, s.inner);
      s.link = this._link(this.proxyBox, s);
      if (this.o.clickServices) {
        s.g.classList.add('clickable');
        s.g.addEventListener('click', () => { s.up = !s.up; });
      }
      this.svcs.push(s);
      return s;
    }

    _layoutSvcs(animate) {
      const n = this.svcs.length, v = this.v;
      this.svcs.forEach((s, i) => {
        let t;
        if (v) {
          const rows = n > 4 ? 2 : 1, per = Math.ceil(n / rows);
          const row = Math.floor(i / per), col = i % per, inRow = row === rows - 1 ? n - per * (rows - 1) : per;
          t = { x: W * (col + 0.5) / inRow, y: rows === 1 ? 320 : row === 0 ? 285 : 375, hw: Math.min(80, W / inRow / 2 - 4), hh: rows === 1 ? 38 : 32 };
        } else {
          const gap = Math.min(118, (H - 110) / n);
          t = { x: 720, y: H / 2 + (i - (n - 1) / 2) * gap, hw: 112, hh: Math.min(36, gap / 2 - 6) };
        }
        if (s.scale === 0) { Object.assign(s, t); gsap.to(s, { scale: 1, duration: 0.45, ease: 'back.out(1.7)' }); }
        else if (animate) gsap.to(s, Object.assign({ duration: 0.45, ease: 'power2.inOut' }, t));
        else Object.assign(s, t);
      });
    }

    _link(a, b) {
      const l = { a, b, el: svgEl('path', { class: 'link' }, this.gLinks) };
      this.links.push(l);
      return l;
    }

    /* ---------- tráfico ---------- */

    _schedule(c) {
      if (c.timer) this.clock.cancel(c.timer);
      const r = c.rate;
      if (r <= 0) { c.timer = this.clock.after(0.25, () => this._schedule(c)); return; }
      c.timer = this.clock.after(-Math.log(1 - this.rand()) / r, () => { this._arrive(c); this._schedule(c); });
    }

    setClientRate(id, r) {
      const c = this.o.clients.find(x => x.id === id);
      if (!c) return;
      c.rate = r;
      this._schedule(c);
    }

    _pickPath() {
      const entries = Object.entries(this.o.mix).filter(e => e[1] > 0);
      const total = entries.reduce((a, e) => a + e[1], 0);
      let u = this.rand() * total;
      for (const [p, w] of entries) { if ((u -= w) < 0) return p; }
      return entries[entries.length - 1][0];
    }

    _arrive(c) {
      const node = this.clients[this.o.clients.indexOf(c)];
      const path = this._pickPath();
      const req = { id: ++this.seq, client: c.id, path, token: this.rand() >= this.o.noTokenRatio };
      this.c.sent++;
      this.flying.add(req);
      const color = this.o.mode === 'lb' ? C.req : ROUTE_COLORS[path] || C.req;
      this._fly(node, this.instances.find(x => x.up) || this.proxyBox, color, () => this._atProxy(req, node));
    }

    _fly(a, b, color, done, dur) {
      const gen = this.gen;
      const el = svgEl('circle', { r: 6, fill: color, class: 'pk' }, this.gPk);
      const d = dur || this.o.travel;
      this.clock.animate(d, p => {
        const P = cubic(edge(a, b, this.v), edge(b, a, this.v), p, this.v);
        el.setAttribute('cx', P.x); el.setAttribute('cy', P.y);
      }, () => { el.remove(); if (gen === this.gen) done(); });
    }

    _pop(n, text, color) {
      if (this.o.pops) pop(this.gTop, n.x, n.y - n.hh - 8, text, color);
    }

    _end(req, status, extra) {
      this.flying.delete(req);
      this.log.push(Object.assign({ t: this.now, client: req.client, path: req.path, token: req.token, status }, extra));
      if (this.log.length > 3000) this.log.splice(0, 1000);
    }

    _atProxy(req, client) {
      const f = this.o.features;
      const inst = this.instances.find(x => x.up);
      const at = inst || this.proxyBox;
      if (!inst) { this.c.econn++; this._pop(this.proxyBox, '✕ conexión', C.err); this._end(req, 'conn'); return; }
      if (f.auth && !req.token) { this.c.e401++; this._pop(at, '401', C.err); this._end(req, 401); return; }
      if (f.rateLimit) {
        const h = (this.hits[req.client] = (this.hits[req.client] || []).filter(t => t > this.now - 1));
        if (h.length >= f.rateLimit.perClient) { this.c.e429++; this._pop(at, '429', C.err); this._end(req, 429); return; }
        h.push(this.now);
      }
      if (f.cache && req.path.startsWith('/static')) {
        this.c.cached++;
        this._pop(at, 'HIT', PINK);
        this._end(req, 200, { cached: true });
        this._fly(at, client, PINK, () => {}, this.o.travel * 0.8);
        return;
      }
      let svc;
      if (this.o.mode === 'lb') svc = this.svcs[this.rr++ % this.svcs.length];
      else {
        const rule = this.o.rules.find(r => r.match.path && req.path.startsWith(r.match.path));
        svc = rule && this.svcs.find(s => s.id === rule.to);
      }
      if (!svc) { this.c.e404++; this._pop(at, '404', C.err); this._end(req, 404); return; }
      const color = this.o.mode === 'lb' ? C.req : ROUTE_COLORS[req.path] || C.req;
      this._fly(at, svc, color, () => this._atService(req, svc), this.o.travel * 0.9);
    }

    _atService(req, svc) {
      if (!svc.up) {
        // el proxy no logra conectar con el servicio caído y le contesta 502 al cliente
        const at = this.instances.find(x => x.up) || this.proxyBox;
        this._pop(svc, '✕ conexión', C.err);
        this._fly(svc, at, C.err, () => { this.c.e502++; this._pop(at, '502', C.err); this._end(req, 502, { to: svc.id }); }, this.o.travel * 0.6);
        return;
      }
      const r = svc.rr = ((svc.rr == null ? -1 : svc.rr) + 1) % svc.replicas;
      svc.counts[r] = (svc.counts[r] || 0) + 1;
      svc.total++;
      svc.active++;
      const d = svc.workTime * (0.85 + 0.3 * this.rand());
      this.clock.after(d, () => {
        svc.active--;
        svc.n++;
        this.c.ok++;
        this.lat.push([this.now, d]);
        this._pop(svc, '✔', C.ok);
        this._end(req, 200, { to: svc.id });
      });
    }

    /* ---------- controles ---------- */

    setRule(i, rule) {
      if (i >= this.o.rules.length) this.o.rules.push(rule); else this.o.rules[i] = rule;
      this.emit('rules');
    }
    insertRule(i, rule) { this.o.rules.splice(i, 0, rule); this.emit('rules'); }

    addService(def) {
      if (this.svcs.some(s => s.id === def.id)) return false;
      const full = Object.assign({ replicas: 1, workTime: 0.5 }, def);
      this.o.services.push(full);
      this._addSvc(full, true);
      this._layoutSvcs(true);
      this.emit('rules');
      return true;
    }

    setReplicas(id, n) {
      const s = this.svcs.find(x => x.id === id);
      if (!s) return;
      s.replicas = Math.max(1, Math.min(5, n));
      while (s.counts.length < s.replicas) s.counts.push(0);
      s.counts.length = s.replicas;
      s.rr = -1;
    }

    replicaCounts(id) { const s = this.svcs.find(x => x.id === id); return s ? s.counts.slice() : null; }

    setFeature(name, value) { this.o.features[name] = value; }

    setProxyUp(i, up) { if (this.instances[i]) this.instances[i].up = up; this.emit('proxy'); }

    setProxies(n) {
      this.o.proxies = Math.max(1, Math.min(2, n));
      this._buildProxies();
      this.emit('proxy');
    }

    /* ---------- métricas ---------- */

    window(sec) {
      const t0 = this.now - sec;
      const byService = {};
      this.svcs.forEach(s => { byService[s.id] = s.total; });
      return Object.assign({}, this.c, {
        inFlight: this.flying.size, byService,
        p95: quant(this.lat.filter(e => e[0] >= t0).map(e => e[1]), 0.95)
      });
    }

    fastForward(sec) {
      const sp = Speed.value;
      Speed.value = 1;
      try { for (let i = 0, n = Math.round(sec / 0.05); i < n; i++) this.clock._tick(0, 50); }
      finally { Speed.value = sp; }
    }

    /* ---------- render ---------- */

    _frame() {
      if (this.lat.length > 3000) this.lat.splice(0, 1000);
      for (const l of this.links) l.el.setAttribute('d', curve(edge(l.a, l.b, this.v), edge(l.b, l.a, this.v), this.v));
      const f = this.o.features;
      const badges = [f.tls && '🔒 TLS', f.cache && '💾 caché', f.compress && '🗜 gzip', f.auth && '🔑 auth', f.rateLimit && '⏱ límite'].filter(Boolean);
      const active = this.instances.find(x => x.up), ha = this.instances.length > 1;
      this.instances.forEach(inst => {
        inst.g.classList.toggle('down', !inst.up);
        inst.g.classList.toggle('passive', ha && inst.up && inst !== active);
        inst.sub.textContent = !inst.up ? 'caído' : this.o.mode === 'lb' ? 'Round Robin · entre iguales' : ha ? (inst === active ? 'activo' : this.v ? 'pasivo' : 'pasivo · en espera') : 'por ruta';
        inst.badges.textContent = this.instances.length === 1 ? badges.join(' · ') : '';
      });
      this.proxyG.classList.toggle('down', this.instances.every(x => !x.up));
      this.svcs.forEach(s => this._drawSvc(s));
      this.emit('tick', this.now);
    }

    _svcColor(s) {
      if (this.o.mode === 'lb') return '#38bdf8';
      const r = this.o.rules.find(x => x.to === s.id);
      return r ? ROUTE_COLORS[r.match.path] || '#94a3b8' : '#475569';
    }

    _drawSvc(s) {
      s.g.setAttribute('transform', `translate(${s.x},${s.y}) scale(${s.scale})`);
      s.g.classList.toggle('down', !s.up);
      s.box.setAttribute('x', -s.hw); s.box.setAttribute('y', -s.hh);
      s.box.setAttribute('width', s.hw * 2); s.box.setAttribute('height', s.hh * 2);
      s.stripe.setAttribute('x', -s.hw + 4); s.stripe.setAttribute('y', -s.hh + 6);
      s.stripe.setAttribute('height', s.hh * 2 - 12); s.stripe.setAttribute('fill', this._svcColor(s));
      const narrow = s.hw < 80;
      const tx = narrow ? 2 : -s.hw + 18;
      s.title.setAttribute('x', tx); s.title.setAttribute('y', s.replicas > 1 ? -s.hh + 18 : -3);
      s.title.setAttribute('text-anchor', narrow ? 'middle' : 'start');
      s.sub.setAttribute('x', tx); s.sub.setAttribute('y', s.replicas > 1 ? -s.hh + 33 : 13);
      s.sub.setAttribute('text-anchor', narrow ? 'middle' : 'start');
      s.title.textContent = narrow ? (s.label.length > 8 ? s.label.slice(0, 7) + '.' : s.label) : `${s.icon} ${s.label}`;
      const total = s.total;
      s.sub.textContent = !s.up ? 'caído' : narrow ? `${s.icon} ✓ ${total}` : `✓ ${total}${s.replicas > 1 ? ` · ${s.replicas} réplicas` : ''}`;
      // réplicas como cajitas, con su contador
      const sig = s.replicas + ':' + s.counts.join(',') + ':' + s.hw;
      if (s.reps._sig !== sig) {
        s.reps._sig = sig;
        s.reps.innerHTML = '';
        if (s.replicas > 1) {
          const rw = Math.min(34, (s.hw * 2 - 30) / s.replicas - 4);
          s.counts.forEach((n, i) => {
            const x = -s.hw + 16 + i * (rw + 4);
            svgEl('rect', { class: 'rep', x, y: s.hh - 22, width: rw, height: 15, rx: 3 }, s.reps);
            const t = svgEl('text', { class: 't-rep', x: x + rw / 2, y: s.hh - 11, 'text-anchor': 'middle' }, s.reps);
            t.textContent = n;
          });
        }
      }
    }
  }

  window.RouteKit = { RouteSim, rng, ROUTE_COLORS, DEFAULT_SERVICES, DEFAULT_RULES };
})();
