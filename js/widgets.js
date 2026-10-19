/* Widgets HTML que leen una Sim: contadores, gráfico en vivo y barra de disponibilidad. */
(function () {
  'use strict';

  const fmtLat = v => (v == null ? '—' : v < 1 ? `${Math.round(v * 1000)} ms` : `${v.toFixed(1)} s`);

  const LABELS = {
    sent: 'Enviadas', ok: 'OK', slow: 'Lentas', err: 'Errores',
    p50: 'Latencia p50', p95: 'Latencia p95', p99: 'Latencia p99',
    errPct: '% error (5 s)', rps: 'Respuestas/s'
  };

  // Ejecuta fn cada `every` segundos de tiempo de simulación
  function throttle(sim, every, fn) {
    let last = -Infinity;
    sim.on('tick', now => { if (now - last >= every) { last = now; fn(); } });
    sim.on('reset', () => { last = -Infinity; fn(true); });
  }

  function stats(el, sim, fields, win = 5) {
    fields = fields || ['sent', 'ok', 'slow', 'err', 'p95', 'errPct'];
    el.innerHTML = fields
      .map(f => `<div class="stat s-${f}"><b data-f="${f}">0</b><span>${LABELS[f]}</span></div>`)
      .join('');
    const cells = {};
    fields.forEach(f => { cells[f] = el.querySelector(`[data-f="${f}"]`); });
    const update = () => {
      const w = sim.window(win);
      const v = Object.assign({}, sim.stats, {
        p50: fmtLat(w.p50), p95: fmtLat(w.p95), p99: fmtLat(w.p99), errPct: `${w.errPct.toFixed(0)}%`, rps: w.rps.toFixed(1)
      });
      fields.forEach(f => { cells[f].textContent = v[f]; });
    };
    throttle(sim, 0.25, update);
    update();
  }

  function chart(canvas, sim) {
    const N = 60;
    const blank = () => Array(N).fill(null);
    const ch = new Chart(canvas, {
      type: 'line',
      data: {
        labels: Array(N).fill(''),
        datasets: [
          {
            label: 'Latencia p95 (s)', data: blank(), yAxisID: 'y',
            borderColor: '#facc15', backgroundColor: 'rgba(250,204,21,.12)',
            fill: true, tension: 0.35, pointRadius: 0, borderWidth: 2, spanGaps: true
          },
          {
            label: '% errores', data: blank(), yAxisID: 'y1',
            borderColor: '#f87171', backgroundColor: 'rgba(248,113,113,.12)',
            fill: true, tension: 0.35, pointRadius: 0, borderWidth: 2, spanGaps: true
          }
        ]
      },
      options: {
        animation: false, responsive: true, maintainAspectRatio: false,
        plugins: { legend: { labels: { color: '#cbd5e1', boxWidth: 10, boxHeight: 10, font: { size: 12 } } } },
        scales: {
          x: { display: false },
          y: {
            position: 'left', min: 0, suggestedMax: 3,
            ticks: { color: '#facc15', font: { size: 11 }, callback: v => `${v}s` },
            grid: { color: 'rgba(148,163,184,.12)' }
          },
          y1: {
            position: 'right', min: 0, max: 100,
            ticks: { color: '#f87171', font: { size: 11 }, callback: v => `${v}%` },
            grid: { display: false }
          }
        }
      }
    });
    const [lat, err] = ch.data.datasets;
    throttle(sim, 0.5, isReset => {
      if (isReset) { lat.data = blank(); err.data = blank(); ch.update('none'); return; }
      const w = sim.window(3);
      lat.data.push(w.p95); lat.data.shift();
      err.data.push(w.n ? w.errPct : null); err.data.shift();
      ch.update('none');
    });
    return ch;
  }

  // Histograma de latencias (requests exitosas de los últimos `win` s) con marcas de p50 / p95 / p99
  function histogram(canvas, sim, win = 30) {
    const BIN = 0.2, MAX = 5;
    const nb = Math.round(MAX / BIN);
    const centers = Array.from({ length: nb }, (_, i) => +(i * BIN + BIN / 2).toFixed(3));
    const marks = [['p50', '#4ade80'], ['p95', '#facc15'], ['p99', '#f87171']];
    let pct = {};

    const markers = {
      id: 'pmarks',
      afterDatasetsDraw(chart) {
        const { ctx, chartArea: a, scales: { x } } = chart;
        ctx.save();
        ctx.font = '700 12px ui-monospace, Menlo, monospace';
        ctx.textAlign = 'center';
        marks.forEach(([k, color], i) => {
          const v = pct[k];
          if (v == null) return;
          const px = x.getPixelForValue(Math.min(v, MAX));
          ctx.strokeStyle = color; ctx.fillStyle = color; ctx.lineWidth = 2;
          ctx.setLineDash([5, 4]);
          ctx.beginPath(); ctx.moveTo(px, a.top + 14 + i * 14); ctx.lineTo(px, a.bottom); ctx.stroke();
          ctx.setLineDash([]);
          ctx.fillText(k, px, a.top + 10 + i * 14);
        });
        ctx.restore();
      }
    };

    const ch = new Chart(canvas, {
      type: 'bar',
      data: {
        datasets: [{
          data: centers.map(c => ({ x: c, y: 0 })),
          backgroundColor: 'rgba(56,189,248,.65)', borderRadius: 2,
          barPercentage: 1, categoryPercentage: 1
        }]
      },
      options: {
        animation: false, responsive: true, maintainAspectRatio: false,
        plugins: { legend: { display: false }, tooltip: { enabled: false } },
        scales: {
          x: {
            type: 'linear', min: 0, max: MAX, offset: false,
            ticks: { color: '#94a3b8', stepSize: 1, callback: v => `${v}s` },
            grid: { color: 'rgba(148,163,184,.08)' },
            title: { display: true, text: 'latencia', color: '#64748b', font: { size: 11 } }
          },
          y: {
            beginAtZero: true, ticks: { color: '#64748b', precision: 0 },
            grid: { color: 'rgba(148,163,184,.12)' },
            title: { display: true, text: 'requests', color: '#64748b', font: { size: 11 } }
          }
        }
      },
      plugins: [markers]
    });

    throttle(sim, 0.5, isReset => {
      const counts = Array(nb).fill(0);
      if (!isReset) {
        const from = sim.now - win;
        for (let i = sim.log.length - 1; i >= 0; i--) {
          const e = sim.log[i];
          if (e.t < from) break;
          if (e.status !== 'err') counts[Math.min(nb - 1, Math.floor(e.lat / BIN))]++;
        }
      }
      const w = sim.window(win);
      pct = isReset ? {} : { p50: w.p50, p95: w.p95, p99: w.p99 };
      ch.data.datasets[0].data = centers.map((c, i) => ({ x: c, y: counts[i] }));
      ch.update('none');
    });
    return ch;
  }

  function strip(el, sim) {
    const N = 80;
    throttle(sim, 0.5, isReset => {
      if (isReset) { el.innerHTML = ''; return; }
      const w = sim.window(0.5);
      const i = document.createElement('i');
      i.className = w.n === 0 ? 'idle' : w.err === 0 ? 'up' : w.err === w.n ? 'down' : 'partial';
      el.appendChild(i);
      while (el.children.length > N) el.firstChild.remove();
    });
  }

  window.Widgets = { stats, chart, histogram, strip, fmtLat };
})();
