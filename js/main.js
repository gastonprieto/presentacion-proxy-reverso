/* Inicializa la presentación y prende/apaga la simulación de cada slide al entrar/salir.
   Escritorio: reveal.js. Celular (html.mobile): documento vertical con scroll nativo, sin reveal. */
(function () {
  'use strict';

  const MOBILE = window.NetKit.MOBILE;
  const instances = new Map();

  function activate(slide) {
    const name = slide && slide.dataset.scene;
    if (!name || !window.Scenes[name]) return;
    let inst = instances.get(slide);
    if (!inst) {
      inst = window.Scenes[name](slide);
      instances.set(slide, inst);
      slide._scene = inst;
    }
    inst.start();
  }

  function deactivate(slide) {
    const inst = slide && instances.get(slide);
    if (inst) inst.stop();
  }

  // slides visibles ahora mismo (en escritorio, solo la actual)
  let visible = () => [];

  if (MOBILE) {
    const sections = [...document.querySelectorAll('.slides > section')];
    const shown = new Set();
    visible = () => [...shown];

    // número de slide arriba de cada sección y barra de progreso según el scroll
    sections.forEach((s, i) => {
      const num = document.createElement('div');
      num.className = 'm-num';
      num.textContent = `${i + 1} / ${sections.length}`;
      s.prepend(num);
    });
    const bar = document.createElement('div');
    bar.className = 'm-progress';
    document.body.appendChild(bar);
    const onScroll = () => {
      const max = document.documentElement.scrollHeight - window.innerHeight;
      bar.style.width = `${max > 0 ? (window.scrollY / max) * 100 : 0}%`;
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    onScroll();

    // cada simulación corre solo mientras su slide está en pantalla (la portada no anima en celular)
    const io = new IntersectionObserver(entries => {
      entries.forEach(e => {
        if (e.isIntersecting) { shown.add(e.target); activate(e.target); }
        else { shown.delete(e.target); deactivate(e.target); }
      });
    }, { threshold: 0.25 });
    sections.filter(s => s.dataset.scene && s.dataset.scene !== 'title').forEach(s => io.observe(s));
  } else {
    visible = () => [Reveal.getCurrentSlide()];
    Reveal.initialize({
      hash: true,
      width: 1280,
      height: 720,
      margin: 0.03,
      center: false,
      controls: true,
      progress: true,
      slideNumber: 'c/t',
      transition: 'slide',
      backgroundTransition: 'fade',
      plugins: [RevealNotes]
    }).then(() => activate(Reveal.getCurrentSlide()));

    Reveal.on('slidechanged', e => {
      deactivate(e.previousSlide);
      activate(e.currentSlide);
    });
  }

  // Control de velocidad de las simulaciones: botones (y en escritorio, teclas - / +)
  const STEPS = [0.25, 0.4, 0.6, 0.8, 1, 1.5];
  const Speed = window.NetKit.Speed;
  try {
    const saved = parseFloat(localStorage.getItem('sim-speed'));
    if (STEPS.includes(saved)) Speed.value = saved;
  } catch (e) { /* sin storage */ }

  const ui = document.createElement('div');
  ui.className = 'speed-ctl';
  ui.innerHTML = '<button data-d="-1" title="Más lento (-)">🐢</button><span></span><button data-d="1" title="Más rápido (+)">🐇</button>';
  document.body.appendChild(ui);
  const label = ui.querySelector('span');

  function setSpeed(v) {
    Speed.value = v;
    label.textContent = `${String(v).replace('.', ',')}×`;
    try { localStorage.setItem('sim-speed', v); } catch (e) { /* sin storage */ }
  }
  function step(d) {
    const i = STEPS.indexOf(Speed.value);
    setSpeed(STEPS[Math.max(0, Math.min(STEPS.length - 1, (i < 0 ? 2 : i) + d))]);
  }
  ui.querySelectorAll('button').forEach(b => b.addEventListener('click', () => { step(+b.dataset.d); b.blur(); }));
  if (!MOBILE) {
    Reveal.addKeyBinding({ keyCode: 189, key: '-', description: 'Simulación más lenta' }, () => step(-1));
    Reveal.addKeyBinding({ keyCode: 187, key: '+', description: 'Simulación más rápida' }, () => step(1));
  }
  setSpeed(Speed.value);

  // Si la pestaña queda oculta, pausar para no acumular tiempo
  document.addEventListener('visibilitychange', () => {
    visible().forEach(s => (document.hidden ? deactivate(s) : activate(s)));
  });
})();
