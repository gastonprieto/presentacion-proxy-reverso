/* Motor de simulación para las slides: clientes → (load balancer) → servidores.
   Usa el ticker de GSAP como reloj (pausable por slide) y GSAP para los efectos.
   Expone window.NetKit = { Clock, Sim, svgEl, cubic, curve, edge, pop, C }. */
(function () {
  'use strict';

  const NS = 'http://www.w3.org/2000/svg';
  // En celular (html.mobile) los diagramas son verticales y en un lienzo más angosto
  const MOBILE = document.documentElement.classList.contains('mobile');
  const W = MOBILE ? 400 : 900, H = MOBILE ? 440 : 590;

  const C = {
    req: '#7dd3fc', ok: '#4ade80', slow: '#facc15', err: '#f87171',
    hc: '#c084fc', redis: '#fb7185', db: '#2dd4bf', text: '#e2e8f0', muted: '#94a3b8'
  };
  const CLIENT_COLORS = ['#38bdf8', '#f472b6', '#a3e635', '#fb923c', '#a78bfa', '#2dd4bf'];
  const LOST = { lost: true };

  const ALGO_NAMES = {
    rr: 'Round Robin', lc: 'Least Connections', random: 'Random',
    iphash: 'IP Hash', weighted: 'Weighted RR'
  };

  function svgEl(tag, attrs, parent) {
    const e = document.createElementNS(NS, tag);
    if (attrs) for (const k in attrs) e.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(e);
    return e;
  }

  // Curva cúbica entre a y b. Horizontal: los puntos de control comparten la x media;
  // vertical (v = true): comparten la y media.
  function cubic(a, b, t, v) {
    const u = 1 - t;
    const k0 = u * u * u, k1 = 3 * u * u * t, k2 = 3 * u * t * t, k3 = t * t * t;
    if (v) {
      const my = (a.y + b.y) / 2;
      return { x: (k0 + k1) * a.x + (k2 + k3) * b.x, y: k0 * a.y + (k1 + k2) * my + k3 * b.y };
    }
    const mx = (a.x + b.x) / 2;
    return { x: k0 * a.x + (k1 + k2) * mx + k3 * b.x, y: (k0 + k1) * a.y + (k2 + k3) * b.y };
  }
  function curve(a, b, v) {
    if (v) {
      const my = (a.y + b.y) / 2;
      return `M${a.x},${a.y} C${a.x},${my} ${b.x},${my} ${b.x},${b.y}`;
    }
    const mx = (a.x + b.x) / 2;
    return `M${a.x},${a.y} C${mx},${a.y} ${mx},${b.y} ${b.x},${b.y}`;
  }
  // Punto del borde del nodo n que mira hacia m (bordes de arriba/abajo si v = true)
  function edge(n, m, v) {
    if (v ? Math.abs(m.y - n.y) >= 1 : Math.abs(m.x - n.x) < 1) {
      return { x: n.x, y: n.y + Math.sign(m.y - n.y) * n.hh };
    }
    return { x: n.x + Math.sign(m.x - n.x) * n.hw, y: n.y };
  }
  const ease = p => (p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2) * 0.6 + p * 0.4;

  // Etiqueta que sube y se desvanece (503, 401, ✔ healthy…)
  function pop(layer, x, y, text, color) {
    const t = svgEl('text', { x, y, class: 'pop', fill: color, 'text-anchor': 'middle' }, layer);
    t.textContent = text;
    gsap.fromTo(t, { y: 0, opacity: 1 }, {
      y: -30, opacity: 0, duration: 1.2, ease: 'power1.out', onComplete: () => t.remove()
    });
  }

  // Velocidad global de todas las simulaciones (1 = tiempo real). La cambia main.js.
  const Speed = { value: 0.6 };

  /* Reloj propio montado sobre gsap.ticker: se puede pausar sin perder estado. */
  class Clock {
    constructor() {
      this.now = 0;
      this.running = false;
      this.timers = [];
      this.anims = [];
      this.onTick = null;
      this._tick = this._tick.bind(this);
    }
    start() { if (!this.running) { this.running = true; gsap.ticker.add(this._tick); } }
    stop() { this.running = false; gsap.ticker.remove(this._tick); }
    clear() { this.timers = []; this.anims = []; }

    _tick(time, deltaTime) {
      this.now += (Math.min(deltaTime, 100) / 1000) * Speed.value;
      const due = [];
      this.timers = this.timers.filter(t => (t.at <= this.now ? (due.push(t), false) : true));
      due.sort((a, b) => a.at - b.at).forEach(t => t.fn());

      const done = [];
      this.anims = this.anims.filter(a => {
        const p = (this.now - a.t0) / a.dur;
        if (p >= 1) { a.update(1); done.push(a); return false; }
        a.update(p);
        return true;
      });
      done.forEach(a => a.done && a.done());
      if (this.onTick) this.onTick();
    }

    after(sec, fn) { const t = { at: this.now + sec, fn }; this.timers.push(t); return t; }
    cancel(t) { this.timers = this.timers.filter(x => x !== t); }
    every(sec, fn) {
      const h = { on: true, cancel() { h.on = false; } };
      const loop = () => { if (!h.on) return; fn(); if (h.on) this.after(sec, loop); };
      this.after(sec, loop);
      return h;
    }
    wait(sec) { return new Promise(r => this.after(sec, r)); }
    animate(dur, update, done) {
      const a = { t0: this.now, dur, update, done };
      this.anims.push(a);
      update(0);
      return a;
    }
  }

  const DEFAULTS = {
    clients: 1, lb: true, servers: 3, algorithm: 'rr',
    rate: 3, arrival: 'uniform', capacity: 4, serviceTime: 0.8, serviceJitter: 0.25,
    heavyRatio: 0, heavyFactor: 6, queueMax: 8, travel: 0.45, slowThreshold: 1.5,
    healthChecks: false, hcInterval: 1, hcFall: 2,
    weights: null, colorByClient: false, clickToKill: false,
    sessions: null, maxServers: 8, showHandled: true, showVersion: false,
    // 'h' fuerza el diagrama horizontal también en celular (por defecto ahí es vertical)
    orient: null,
    // capa de datos detrás de los servidores: { mode: 'single' | 'cache', ... } (ver DB_DEFAULTS)
    db: null
  };

  const DB_DEFAULTS = {
    mode: 'single', capacity: 4, queryTime: 0.5, travel: 0.3, queueMax: 40,
    cacheHit: 0.8, cacheCapacity: 16, cacheTime: 0.06
  };

  class Sim {
    constructor(svg, opts) {
      this.svg = svg;
      this.W = W; this.H = H;
      svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
      svg.classList.add('netsim');
      this.clock = new Clock();
      this.clock.onTick = () => this._frame();
      this.listeners = {};
      this.reset(opts);
    }

    on(ev, fn) { (this.listeners[ev] = this.listeners[ev] || []).push(fn); }
    emit(ev, ...args) { (this.listeners[ev] || []).forEach(f => f(...args)); }
    start() { this.clock.start(); }
    stop() { this.clock.stop(); }
    get now() { return this.clock.now; }

    reset(opts) {
      if (opts) this.o = Object.assign({}, DEFAULTS, opts);
      this.v = MOBILE && this.o.orient !== 'h';
      this.gen = (this.gen || 0) + 1;
      this.clock.clear();
      this.svg.innerHTML = '';
      this.gLinks = svgEl('g', { class: 'links' }, this.svg);
      this.gNodes = svgEl('g', { class: 'nodes' }, this.svg);
      this.gPk = svgEl('g', { class: 'packets' }, this.svg);
      this.gTop = svgEl('g', { class: 'overlay' }, this.svg);
      this._banner = null;
      this.seq = 0; this.rr = 0; this.arrTimer = null; this.hc = null;
      this.stats = { sent: 0, ok: 0, slow: 0, err: 0 };
      this.log = [];
      this.clients = []; this.servers = []; this.lb = null; this.redis = null; this.data = null;
      this.db = this.o.db ? Object.assign({}, DB_DEFAULTS, this.o.db) : null;

      for (let i = 0; i < this.o.clients; i++) this._addClient(i);
      if (this.o.lb) this._addLB();
      if (this.o.sessions === 'shared') this._addRedis();
      if (this.db) this._addData();
      for (let i = 0; i < this.o.servers; i++) this._addServer(false);
      this._layout(false);
      this._buildLinks();
      this._scheduleArrival();
      if (this.o.healthChecks) this._startHC();
      this._frame();
      this.emit('reset');
    }

    /* ---------- construcción de nodos ---------- */

    _addClient(i) {
      const multi = this.o.clients > 1;
      const c = {
        kind: 'client', id: i, color: CLIENT_COLORS[i % CLIENT_COLORS.length],
        name: multi ? `C${i + 1}` : 'Usuarios', ip: multi ? `10.0.0.${11 + i * 17}` : 'internet',
        octet: 11 + i * 17, x: 0, y: 0, hw: 46, hh: 27, session: null
      };
      // vertical con varios clientes: cajas angostas, sin emoji
      const slim = this.v && multi;
      if (slim) { c.hw = Math.min(40, W / (this.o.clients + 1) / 2 - 4); c.hh = 22; }
      else if (MOBILE) c.hw = 56; // en celular la letra es relativamente más grande: «Usuarios» necesita más ancho
      const g = svgEl('g', { class: 'client' }, this.gNodes);
      g.style.setProperty('--c', this.o.colorByClient || multi ? c.color : '#7dd3fc');
      svgEl('rect', { class: 'node-box', x: -c.hw, y: -c.hh, width: c.hw * 2, height: c.hh * 2, rx: 10 }, g);
      const tx = slim ? -c.hw + 8 : -c.hw + 34;
      if (!slim) svgEl('text', { x: -c.hw + 18, y: 7, class: 't-emoji', 'text-anchor': 'middle' }, g).textContent = multi ? '💻' : '👥';
      svgEl('text', { x: tx, y: slim ? -3 : -2, class: 't-title small' }, g).textContent = c.name;
      svgEl('text', { x: tx, y: slim ? 13 : 14, class: 't-sub' }, g).textContent = c.ip;
      c.view = { g };
      this.clients.push(c);
    }

    _addLB() {
      const lb = { kind: 'lb', x: 0, y: H / 2, hw: 72, hh: 46 };
      const g = svgEl('g', { class: 'lb' }, this.gNodes);
      const inner = svgEl('g', {}, g);
      lb.view = {
        g, inner,
        box: svgEl('rect', { class: 'node-box', x: -lb.hw, y: -lb.hh, width: lb.hw * 2, height: lb.hh * 2, rx: 14 }, inner),
        title: svgEl('text', { x: 0, y: -14, class: 't-title', 'text-anchor': 'middle' }, inner),
        algo: svgEl('text', { x: 0, y: 6, class: 't-lb', 'text-anchor': 'middle' }, inner),
        next: svgEl('text', { x: 0, y: 26, class: 't-sub', 'text-anchor': 'middle' }, inner),
        heart: svgEl('text', { x: lb.hw - 14, y: -lb.hh + 19, class: 't-heart', 'text-anchor': 'middle' }, inner)
      };
      lb.view.title.textContent = 'Load Balancer';
      lb.view.heart.textContent = '♥';
      this.lb = lb;
    }

    _addRedis() {
      const r = { kind: 'redis', x: 818, y: H / 2, hw: 56, hh: 62, sessions: new Set(), sig: '' };
      // vertical: caja ancha abajo, con las sesiones en fila a la derecha
      if (this.v) Object.assign(r, { x: W / 2, y: H - 40, hw: 100, hh: 30 });
      const g = svgEl('g', { class: 'redis' }, this.gNodes);
      svgEl('rect', { class: 'node-box', x: -r.hw, y: -r.hh, width: r.hw * 2, height: r.hh * 2, rx: 12 }, g);
      const t = this.v ? { x: -r.hw + 14, anchor: 'start', y1: -3, y2: 14 } : { x: 0, anchor: 'middle', y1: -r.hh + 22, y2: -r.hh + 40 };
      svgEl('text', { x: t.x, y: t.y1, class: 't-title', 'text-anchor': t.anchor }, g).textContent = 'Redis';
      svgEl('text', { x: t.x, y: t.y2, class: 't-sub', 'text-anchor': t.anchor }, g).textContent = 'sesiones';
      r.view = { g, chips: svgEl('g', {}, g) };
      this.redis = r;
    }

    _serverName() {
      const used = new Set(this.servers.map(s => s.name));
      let n = 1;
      while (used.has(`S${n}`)) n++;
      return `S${n}`;
    }

    _addServer(fresh) {
      const idx = this.servers.length;
      const w = this.o.weights ? this.o.weights[idx % this.o.weights.length] : 1;
      const s = {
        kind: 'server', name: this._serverName(), x: 0, y: H / 2, hw: 86, hh: 30,
        scale: fresh ? 0 : 1, fresh,
        up: true, healthy: true, draining: false, removing: false, gone: false,
        status: null, progress: null, version: 'v1',
        weight: w, capacity: this.o.capacity * w,
        active: 0, queue: [], inProc: new Set(), conns: 0, handled: 0, fails: 0, cw: 0,
        sessions: new Set(), sig: ''
      };
      this._makeView(s);
      if (this.o.clickToKill) s.view.g.addEventListener('click', () => this.toggleServer(s));
      this.servers.push(s);
      return s;
    }

    // Vista de una caja tipo servidor (también la usan los nodos de datos)
    _makeView(s) {
      const g = svgEl('g', { class: 'srv' }, this.gNodes);
      const inner = svgEl('g', {}, g);
      s.view = {
        g, inner,
        qg: svgEl('g', {}, inner),
        box: svgEl('rect', { class: 'node-box', rx: 10 }, inner),
        title: svgEl('text', { class: 't-title' }, inner),
        info: svgEl('text', { class: 't-info', 'text-anchor': 'end' }, inner),
        sub: svgEl('text', { class: 't-sub' }, inner),
        chips: svgEl('g', {}, inner),
        barBg: svgEl('rect', { class: 'bar-bg', rx: 2.5, height: 5 }, inner),
        bar: svgEl('rect', { class: 'bar', rx: 2.5, height: 5 }, inner),
        prog: svgEl('rect', { class: 'prog', rx: 2.5, height: 5 }, inner)
      };
    }

    _addData() {
      const d = this.db;
      const node = (name, role, desc, capacity, queryTime) => {
        const n = {
          kind: 'db', role, name, desc, x: 0, y: 0, hw: 84, hh: 40, scale: 1,
          up: true, healthy: true, version: 'v1', capacity, queryTime,
          active: 0, queue: [], inProc: new Set(), conns: 0, handled: 0, sessions: new Set(), sig: ''
        };
        this._makeView(n);
        return n;
      };
      const primary = node('DB', 'primary', 'PostgreSQL', d.capacity, d.queryTime);
      this.data = { primary, cache: null, nodes: [primary] };
      if (d.mode === 'cache') {
        this.data.cache = node('Caché', 'cache', `Redis · hit ${Math.round(d.cacheHit * 100)}%`, d.cacheCapacity, d.cacheTime);
        this.data.nodes = [this.data.cache, primary];
      }
    }

    _layout(animate) {
      if (this.v) { this._layoutV(animate); return; }
      const n = this.clients.length;
      const clientX = this.lb ? 70 : 120;
      if (this.data) {
        const k = this.data.nodes.length;
        this.data.nodes.forEach((d, i) => { d.x = 800; d.y = H * (i + 1) / (k + 1); });
      }
      this.clients.forEach((c, i) => {
        c.x = clientX; c.y = H * (i + 1) / (n + 1);
        c.view.g.setAttribute('transform', `translate(${c.x},${c.y})`);
      });
      if (this.lb) {
        this.lb.x = this.redis ? 280 : this.data ? 250 : 330;
        this.lb.view.g.setAttribute('transform', `translate(${this.lb.x},${this.lb.y})`);
      }
      if (this.redis) this.redis.view.g.setAttribute('transform', `translate(${this.redis.x},${this.redis.y})`);

      const m = this.servers.length;
      const sx = this.redis ? 570 : this.data ? 505 : (this.lb ? 700 : 560);
      const gap = H / (m + 1);
      const hh = Math.min(44, gap / 2 - 6);
      this.servers.forEach((s, i) => {
        const y = gap * (i + 1);
        if (s.fresh) {
          Object.assign(s, { x: sx, y, hh });
          s.fresh = false;
          gsap.to(s, { scale: 1, duration: 0.5, ease: 'back.out(1.7)' });
        } else if (animate) {
          gsap.to(s, { x: sx, y, hh, duration: 0.5, ease: 'power2.inOut' });
        } else {
          Object.assign(s, { x: sx, y, hh });
        }
      });
    }

    // Celular: clientes arriba, LB al medio, servidores en filas de hasta 4 y la capa de datos (o Redis) abajo
    _layoutV(animate) {
      const n = this.clients.length;
      this.clients.forEach((c, i) => {
        c.x = W * (i + 1) / (n + 1); c.y = this.lb ? 36 : 50;
        c.view.g.setAttribute('transform', `translate(${c.x},${c.y})`);
      });
      if (this.lb) {
        this.lb.x = W / 2; this.lb.y = 128;
        this.lb.view.g.setAttribute('transform', `translate(${this.lb.x},${this.lb.y})`);
      }
      const bottom = this.data || this.redis;
      if (this.redis) this.redis.view.g.setAttribute('transform', `translate(${this.redis.x},${this.redis.y})`);
      if (this.data) {
        const k = this.data.nodes.length;
        this.data.nodes.forEach((d, i) => {
          Object.assign(d, { x: W * (i + 1) / (k + 1), y: H - 40, hw: Math.min(84, W / (k + 1) / 2 - 6), hh: 30 });
        });
      }

      const m = this.servers.length;
      const rows = m > 4 ? 2 : 1;
      const perRow = Math.ceil(m / rows);
      const top = this.lb ? 200 : 150, bot = bottom ? H - 110 : H - 40;
      const single = !this.lb && m === 1;
      const hh = single ? 44 : rows === 2 ? 24 : this.o.sessions ? 40 : 32;
      const hw = single ? 110 : Math.min(64, W / perRow / 2 - 6);
      this.servers.forEach((s, i) => {
        const row = Math.floor(i / perRow), col = i % perRow;
        const inRow = row === rows - 1 ? m - perRow * (rows - 1) : perRow;
        const x = W * (col + 0.5) / inRow;
        const y = rows === 1 ? (top + bot) / 2 : top + (bot - top) * (row === 0 ? 0.22 : 0.78);
        if (s.fresh) {
          Object.assign(s, { x, y, hh, hw });
          s.fresh = false;
          gsap.to(s, { scale: 1, duration: 0.5, ease: 'back.out(1.7)' });
        } else if (animate) {
          gsap.to(s, { x, y, hh, hw, duration: 0.5, ease: 'power2.inOut' });
        } else {
          Object.assign(s, { x, y, hh, hw });
        }
      });
    }

    _buildLinks() {
      this.gLinks.innerHTML = '';
      this.links = [];
      const add = (a, b, cls) => {
        const l = { a, b, el: svgEl('path', { class: 'link ' + (cls || '') }, this.gLinks) };
        this.links.push(l);
        return l;
      };
      this.clients.forEach(c => add(c, this.lb || this.servers[0]));
      if (this.lb) this.servers.forEach(s => { s.link = add(this.lb, s); });
      if (this.redis) this.servers.forEach(s => add(s, this.redis, 'redis-link'));
      if (this.data) this.servers.forEach(s => this.data.nodes.forEach(d => add(s, d, 'db-link')));
    }

    /* ---------- render por frame ---------- */

    _frame() {
      for (const l of this.links) {
        l.el.setAttribute('d', curve(edge(l.a, l.b, this.v), edge(l.b, l.a, this.v), this.v));
        if (l.a.kind === 'lb') {
          const s = l.b;
          l.el.classList.toggle('off', !s.healthy || s.draining || s.removing);
        }
      }
      this.servers.forEach(s => this._drawServer(s));
      if (this.data) this.data.nodes.forEach(d => this._drawServer(d));
      if (this.lb) this._drawLB();
      if (this.redis) this._drawChips(this.redis, this.redis.view.chips, true);
      this._checkRemovals();
      this.emit('tick', this.now);
    }

    _drawLB() {
      const v = this.lb.view, o = this.o;
      v.algo.textContent = ALGO_NAMES[o.algorithm] + (o.sessions === 'sticky' ? ' + sticky' : '');
      let next = '';
      if (o.algorithm === 'rr' && o.sessions !== 'sticky') {
        const s = this._peekRR();
        next = s ? `próximo → ${s.name}` : 'sin servidores';
      } else if (o.algorithm === 'iphash') {
        next = `hash(IP) mod ${this._pool().length}`;
      }
      v.next.textContent = next;
      v.heart.style.display = o.healthChecks ? '' : 'none';
    }

    _drawServer(s) {
      const v = s.view, hw = s.hw, hh = s.hh, compact = hh < 30;
      v.g.setAttribute('transform', `translate(${s.x},${s.y}) scale(${s.scale})`);

      let cls = 'srv';
      if (this.o.clickToKill) cls += ' clickable';
      if (!s.up) cls += s.status ? ' deploying' : ' down';
      else if (s.draining || s.removing) cls += ' draining';
      else if (!s.healthy) cls += ' unhealthy';
      if (s.version !== 'v1') cls += ' v2';
      if (compact) cls += ' compact';
      if (s.kind === 'db') cls += ` data ${s.role}`;
      v.g.setAttribute('class', cls);

      v.box.setAttribute('x', -hw); v.box.setAttribute('y', -hh);
      v.box.setAttribute('width', hw * 2); v.box.setAttribute('height', hh * 2);

      const ty = compact ? 5 : -hh + 22;
      // peso / versión van en el título; en cajas angostas (celular) pasan a la segunda línea
      const narrow = hw < 70;
      const extra = [];
      if (this.o.weights && s.kind === 'server') extra.push(`peso ${s.weight}`);
      if (this.o.showVersion && s.kind === 'server') extra.push(s.version);
      v.title.textContent = narrow ? s.name : [s.name, ...extra].join(' · ');
      v.title.setAttribute('x', -hw + 12); v.title.setAttribute('y', ty);

      let sub;
      if (s.status) sub = narrow ? s.status.replace('desplegando', 'deploy') : s.status;
      else if (!s.up) sub = '✖ caído';
      else if (s.removing) sub = 'retirando…';
      else if (s.draining) sub = narrow ? 'drenando…' : 'drenando conexiones…';
      else if (!s.healthy) sub = narrow ? '⚠ fuera' : '⚠ fuera de rotación';
      else if (s.kind === 'db') sub = s.desc;
      else if (narrow) sub = [...extra, this.o.showHandled ? `✓ ${s.handled}` : ''].filter(Boolean).join(' · ');
      else sub = this.o.showHandled ? `atendidas: ${s.handled}` : '';

      const q = s.queue.length;
      v.info.textContent = !s.up ? (compact ? '✖' : '') : `${s.active}/${s.capacity}${q ? ` +${q}` : ''}`;
      v.info.setAttribute('x', hw - 12); v.info.setAttribute('y', ty);
      v.sub.textContent = compact ? '' : sub;
      v.sub.setAttribute('x', -hw + 12); v.sub.setAttribute('y', -hh + 41);

      const bw = hw * 2 - 24, by = hh - (compact ? 9 : 12);
      const load = s.up ? Math.min(1, s.active / s.capacity) : 0;
      v.barBg.setAttribute('x', -hw + 12); v.barBg.setAttribute('y', by); v.barBg.setAttribute('width', bw);
      v.bar.setAttribute('x', -hw + 12); v.bar.setAttribute('y', by);
      v.bar.setAttribute('width', bw * load);
      v.bar.setAttribute('fill', q > 0 ? C.err : load > 0.7 ? C.slow : C.ok);
      v.prog.setAttribute('x', -hw + 12); v.prog.setAttribute('y', by);
      v.prog.setAttribute('width', s.progress == null ? 0 : bw * s.progress);

      // cola: cuadraditos esperando sobre el link de entrada (en vertical, en fila arriba de la caja)
      const qn = Math.min(q, this.v ? Math.floor((hw * 2 - 4) / 10) : s.kind === 'db' ? 11 : 14);
      while (v.qg.childElementCount < qn) svgEl('rect', { width: 8, height: 8, rx: 1.5, class: 'qsq' }, v.qg);
      while (v.qg.childElementCount > qn) v.qg.lastChild.remove();
      for (let i = 0; i < qn; i++) {
        v.qg.children[i].setAttribute('x', this.v ? -hw + 2 + i * 10 : -hw - 14 - i * 10);
        v.qg.children[i].setAttribute('y', this.v ? -hh - 12 : -4);
      }

      if (this.o.sessions && !compact) this._drawChips(s, v.chips, false);
    }

    _drawChips(node, g, grid) {
      const list = [...node.sessions];
      const sig = list.map(c => c.id).join(',') + (grid ? '' : node.hh + ':' + node.hw);
      if (sig === node.sig) return;
      node.sig = sig;
      g.innerHTML = '';
      list.forEach((c, i) => {
        // grid = Redis: en vertical las sesiones van en fila a la derecha del título
        const x = grid ? (this.v ? -6 + i * 22 : -24 + (i % 3) * 24) : -node.hw + 26 + i * 18;
        const y = grid ? (this.v ? 0 : 6 + Math.floor(i / 3) * 24) : node.hh - 26;
        svgEl('circle', { cx: x, cy: y, r: 6.5, fill: c.color, class: 'chip' }, g);
      });
      if (!grid && list.length) {
        const t = svgEl('text', { x: -node.hw + 26 + list.length * 18, y: node.hh - 22, class: 't-sub' }, g);
        t.textContent = '🔑';
      }
    }

    /* ---------- tráfico ---------- */

    _scheduleArrival() {
      const r = this.o.rate;
      if (r <= 0) { this.arrTimer = this.clock.after(0.25, () => this._scheduleArrival()); return; }
      let gap;
      if (this.o.arrival === 'poisson') gap = -Math.log(1 - Math.random()) / r;
      else if (this.o.arrival === 'steady') gap = 1 / r;
      else gap = (1 / r) * (0.75 + Math.random() * 0.5);
      this.arrTimer = this.clock.after(gap, () => { this.spawn(); this._scheduleArrival(); });
    }

    setRate(r) {
      this.o.rate = r;
      if (this.arrTimer) this.clock.cancel(this.arrTimer);
      this._scheduleArrival();
    }

    _packet(r, color) {
      return svgEl('circle', { r, fill: color, class: 'pk', cx: -20, cy: -20 }, this.gPk);
    }

    _move(pk, a, b, done, dur) {
      this.clock.animate(dur == null ? this.o.travel : dur, p => {
        const P = cubic(edge(a, b, this.v), edge(b, a, this.v), ease(p), this.v);
        pk.setAttribute('cx', P.x);
        pk.setAttribute('cy', P.y);
      }, done);
    }

    _travel(pk, nodes, done) {
      if (nodes.length < 2) { done(); return; }
      this._move(pk, nodes[0], nodes[1], () => this._travel(pk, nodes.slice(1), done));
    }

    _back(req, from) {
      if (from === this.lb) return [this.lb, req.client];
      return this.lb ? [from, this.lb, req.client] : [from, req.client];
    }

    spawn() {
      const c = this.clients[Math.floor(Math.random() * this.clients.length)];
      const heavy = Math.random() < this.o.heavyRatio;
      const req = { id: ++this.seq, client: c, t0: this.now, heavy };
      this.stats.sent++;
      req.pk = this._packet(heavy ? 8.5 : 5.5, this.o.colorByClient ? c.color : C.req);
      if (this.lb) {
        this._move(req.pk, c, this.lb, () => this._atLB(req));
      } else {
        const s = this.servers[0];
        s.conns++;
        this._move(req.pk, c, s, () => this._atServer(req, s));
      }
    }

    _pool() {
      return this.servers.filter(s => s.healthy && !s.draining && !s.removing);
    }

    _peekRR() {
      const pool = this._pool(), all = this.servers;
      for (let i = 0; i < all.length; i++) {
        const s = all[(this.rr + i) % all.length];
        if (pool.includes(s)) return s;
      }
      return null;
    }

    _pick(req) {
      const pool = this._pool();
      if (!pool.length) return null;
      const c = req.client;
      if (this.o.sessions === 'sticky' && c.session && c.session !== LOST && pool.includes(c.session)) {
        return c.session;
      }
      switch (this.o.algorithm) {
        case 'lc': {
          const min = Math.min(...pool.map(s => s.conns / s.weight));
          const ties = pool.filter(s => s.conns / s.weight === min);
          return ties[Math.floor(Math.random() * ties.length)];
        }
        case 'random':
          return pool[Math.floor(Math.random() * pool.length)];
        case 'iphash':
          return pool[c.octet % pool.length];
        case 'weighted': {
          let total = 0, best = null;
          pool.forEach(s => { s.cw += s.weight; total += s.weight; if (!best || s.cw > best.cw) best = s; });
          best.cw -= total;
          return best;
        }
        default: {
          const s = this._peekRR();
          this.rr = this.servers.indexOf(s) + 1;
          return s;
        }
      }
    }

    _atLB(req) {
      const s = this._pick(req);
      if (!s) { this._fail(req, this.lb, '503'); return; }
      s.conns++;
      gsap.fromTo(this.lb.view.box, { attr: { 'stroke-width': 4.5 } }, { attr: { 'stroke-width': 2 }, duration: 0.35 });
      this._move(req.pk, this.lb, s, () => this._atServer(req, s));
    }

    _atServer(req, s) {
      if (!s.up) { s.conns--; this._connFail(req, s); return; }
      req.tServer = this.now;
      const c = req.client, mode = this.o.sessions;

      if (mode === 'local' || mode === 'sticky') {
        if (c.session && c.session !== s) {
          // la sesión vive en otro servidor (o se perdió): 401 y el usuario se vuelve a loguear acá
          if (c.session !== LOST) c.session.sessions.delete(c);
          c.session = s;
          s.sessions.add(c);
          s.conns--;
          this._fail(req, s, '401');
          return;
        }
        if (!c.session) { c.session = s; s.sessions.add(c); }
      } else if (mode === 'shared') {
        if (!c.session) { c.session = this.redis; this.redis.sessions.add(c); }
        const rp = this._packet(3.5, C.redis);
        this._move(rp, s, this.redis, () => this._move(rp, this.redis, s, () => rp.remove(), 0.22), 0.22);
      }

      if (s.active < s.capacity) this._process(req, s);
      else if (s.queue.length < this.o.queueMax) { req.pk.style.opacity = 0; s.queue.push(req); }
      else { s.conns--; this._fail(req, s, '503'); }
    }

    _process(req, s) {
      s.active++;
      s.inProc.add(req);
      req.pk.style.opacity = 0;
      const j = 1 + (Math.random() * 2 - 1) * this.o.serviceJitter;
      const d = this.o.serviceTime * (req.heavy ? this.o.heavyFactor : 1) * j;
      req.timer = this.clock.after(d, () => {
        req.timer = null;
        // con capa de datos, el worker queda ocupado esperando la consulta
        if (this.data) this._query(req, s, () => this._finish(req, s));
        else this._finish(req, s);
      });
    }

    _finish(req, s) {
      s.active--; s.conns--; s.handled++;
      s.inProc.delete(req);
      this._respond(req, s);
      this._dequeue(s);
    }

    _pickData() {
      const { primary, cache } = this.data;
      if (cache) return Math.random() < this.db.cacheHit ? cache : primary;
      return primary;
    }

    _query(req, s, done) {
      const d = this._pickData();
      const pk = this._packet(3.5, C.db);
      this._move(pk, s, d, () => {
        if (req.aborted) { pk.remove(); return; }
        const q = { req, s, pk, done };
        if (d.active < d.capacity) this._dbRun(d, q);
        else if (d.queue.length < this.db.queueMax) { pk.style.opacity = 0; d.queue.push(q); }
        else {
          // la DB no da abasto: el servidor corta por timeout
          pk.remove();
          s.active--; s.conns--; s.inProc.delete(req);
          this._fail(req, s, '504');
          this._dequeue(s);
        }
      }, this.db.travel);
    }

    _dbRun(d, q) {
      d.active++;
      q.pk.style.opacity = 0;
      const j = 1 + (Math.random() * 2 - 1) * 0.25;
      this.clock.after(d.queryTime * j, () => {
        d.active--; d.handled++;
        q.pk.style.opacity = 1;
        this._move(q.pk, d, q.s, () => { q.pk.remove(); if (!q.req.aborted) q.done(); }, this.db.travel);
        while (d.active < d.capacity && d.queue.length) this._dbRun(d, d.queue.shift());
      });
    }

    _dequeue(s) {
      while (s.up && s.active < s.capacity && s.queue.length) this._process(s.queue.shift(), s);
    }

    _respond(req, s) {
      // lenta = mucho tiempo dentro del servidor (cola + proceso); el viaje animado no cuenta
      req.lat = this.now - req.tServer;
      const slow = req.lat > this.o.slowThreshold;
      req.pk.setAttribute('fill', slow ? C.slow : C.ok);
      req.pk.style.opacity = 1;
      this._travel(req.pk, this._back(req, s), () => { req.pk.remove(); this._record(req, slow ? 'slow' : 'ok'); });
    }

    _fail(req, at, code) {
      if (code) this._pop(at, code, C.err);
      req.pk.setAttribute('fill', C.err);
      req.pk.style.opacity = 1;
      this._travel(req.pk, this._back(req, at), () => { req.pk.remove(); this._record(req, 'err'); });
    }

    // Quien llama a un nodo caído no recibe un código HTTP: falla la conexión. Con LB, el que no conecta es el LB,
    // y es él quien le contesta 502 al cliente.
    _connFail(req, s) {
      this._pop(s, '✕ conexión', C.err);
      if (!this.lb) { this._fail(req, s, null); return; }
      req.pk.setAttribute('fill', C.err);
      req.pk.style.opacity = 1;
      this._move(req.pk, s, this.lb, () => this._fail(req, this.lb, '502'));
    }

    _pop(node, text, color) {
      pop(this.gTop, node.x - node.hw + 10, node.y - node.hh - 8, text, color);
    }

    _record(req, status) {
      this.stats[status]++;
      // latencia = tiempo en el servidor (cola + proceso + DB); el viaje animado de los puntos no cuenta
      this.log.push({ t: this.now, lat: req.lat != null ? req.lat : this.now - req.t0, status });
      while (this.log.length && this.log[0].t < this.now - 60) this.log.shift();
    }

    // Métricas de los últimos `sec` segundos
    window(sec) {
      const from = this.now - sec;
      let n = 0, err = 0;
      const lats = [];
      for (let i = this.log.length - 1; i >= 0; i--) {
        const e = this.log[i];
        if (e.t < from) break;
        n++;
        if (e.status === 'err') err++; else lats.push(e.lat);
      }
      lats.sort((a, b) => a - b);
      const q = p => (lats.length ? lats[Math.min(lats.length - 1, Math.floor(p * lats.length))] : null);
      return { n, err, rps: n / sec, errPct: n ? (err / n) * 100 : 0, p50: q(0.5), p95: q(0.95), p99: q(0.99) };
    }

    /* ---------- health checks ---------- */

    _startHC() {
      this._stopHC();
      this.hc = this.clock.every(this.o.hcInterval, () => this._healthCheck());
    }
    _stopHC() { if (this.hc) { this.hc.cancel(); this.hc = null; } }

    setHealthChecks(on) {
      this.o.healthChecks = on;
      if (on) this._startHC();
      else {
        this._stopHC();
        this.servers.forEach(s => { s.healthy = true; s.fails = 0; });
      }
    }

    _healthCheck() {
      if (!this.lb) return;
      gsap.fromTo(this.lb.view.heart, { scale: 1.6, transformOrigin: '50% 50%' }, { scale: 1, duration: 0.4 });
      this.servers.forEach(s => {
        if (s.removing) return;
        const pk = this._packet(3.5, C.hc);
        pk.classList.add('hc');
        this._move(pk, this.lb, s, () => {
          if (s.up) {
            s.fails = 0;
            if (!s.healthy) { s.healthy = true; this._pop(s, '✔ healthy', C.ok); }
            this._move(pk, s, this.lb, () => pk.remove(), 0.25);
          } else {
            pk.remove();
            s.fails++;
            if (s.healthy && s.fails >= this.o.hcFall) { s.healthy = false; this._pop(s, 'unhealthy', '#fb923c'); }
          }
        }, 0.25);
      });
    }

    /* ---------- control de servidores ---------- */

    setUp(s, up) {
      if (s.up === up) return;
      s.up = up;
      if (!up) {
        [...s.inProc].forEach(req => {
          if (req.timer) this.clock.cancel(req.timer);
          req.aborted = true;
          s.active--; s.conns--;
          this._connFail(req, s);
        });
        s.inProc.clear();
        s.queue.splice(0).forEach(req => { s.conns--; this._connFail(req, s); });
        s.sessions.forEach(c => { if (c.session === s) c.session = LOST; });
        s.sessions.clear();
        gsap.fromTo(s.view.inner, { x: -8 }, { x: 0, duration: 0.6, ease: 'elastic.out(1, 0.3)' });
      } else {
        gsap.fromTo(s.view.inner, { scale: 0.9, transformOrigin: '50% 50%' }, { scale: 1, duration: 0.5, ease: 'back.out(2)' });
        this._dequeue(s);
      }
      this.emit('server', s);
    }

    toggleServer(s) { if (!s.status) this.setUp(s, !s.up); }

    addServer() {
      if (this.servers.filter(s => !s.removing).length >= this.o.maxServers) return false;
      this._addServer(true);
      this._buildLinks();
      this._layout(true);
      return true;
    }

    removeServer() {
      const live = this.servers.filter(s => !s.removing);
      if (live.length <= 1) return false;
      live[live.length - 1].removing = true;
      return true;
    }

    activeServers() { return this.servers.filter(s => !s.removing).length; }

    _checkRemovals() {
      this.servers
        .filter(s => s.removing && !s.gone && s.conns === 0 && s.active === 0 && !s.queue.length)
        .forEach(s => {
          s.gone = true;
          gsap.to(s, {
            scale: 0, duration: 0.35, ease: 'back.in(1.7)', onComplete: () => {
              s.view.g.remove();
              this.servers.splice(this.servers.indexOf(s), 1);
              this._buildLinks();
              this._layout(true);
            }
          });
        });
    }

    until(cond) {
      return new Promise(res => {
        const h = this.clock.every(0.1, () => { if (cond()) { h.cancel(); res(); } });
      });
    }

    async drain(s) {
      s.draining = true;
      await this.until(() => s.conns === 0 && s.active === 0 && s.queue.length === 0);
    }

    async deployServer(s, version, secs) {
      s.status = `desplegando ${version}…`;
      this.setUp(s, false);
      this.clock.animate(secs, p => { s.progress = p; });
      await this.clock.wait(secs);
      s.progress = null;
      s.status = null;
      s.version = version;
      this.setUp(s, true);
    }

    banner(text, color) {
      if (!this._banner) {
        // en vertical va abajo (arriba están los clientes), salvo que la escena pida bannerTop
        const by = this.v ? (this.o.bannerTop ? 8 : H - 44) : 12, bh = this.v ? 32 : 40;
        const g = svgEl('g', { class: 'banner', opacity: 0 }, this.gTop);
        this._banner = {
          g,
          rect: svgEl('rect', { rx: 12, height: bh, y: by }, g),
          text: svgEl('text', { x: W / 2, y: by + (this.v ? 21 : 26), 'text-anchor': 'middle' }, g)
        };
      }
      const b = this._banner;
      if (!text) { gsap.to(b.g, { opacity: 0, duration: 0.3 }); return; }
      b.text.textContent = text;
      b.text.setAttribute('fill', color || C.text);
      b.rect.setAttribute('stroke', color || C.text);
      let w = 600;
      try { w = Math.min(W - 8, b.text.getComputedTextLength() + 40); } catch (e) { /* slide oculta */ }
      b.rect.setAttribute('x', W / 2 - w / 2);
      b.rect.setAttribute('width', w);
      gsap.fromTo(b.g, { opacity: 0, y: -10 }, { opacity: 1, y: 0, duration: 0.35 });
    }
  }

  window.NetKit = { MOBILE, Speed, Clock, Sim, svgEl, cubic, curve, edge, pop, C, W, H, CLIENT_COLORS };
})();
