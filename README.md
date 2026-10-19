# Proxy reverso

Presentación interactiva (reveal.js + simulaciones en SVG) sobre proxy reverso: en qué se diferencia de un load balancer (ruta vs. carga), reglas de enrutamiento, una sola puerta, lo que se resuelve en la puerta, riesgos y, como detalle, el API gateway.

**Verla:** https://gastonprieto.github.io/presentacion-proxy-reverso/ (en el celular se ve como documento vertical).

Teclas: `→` avanzar · `S` notas del orador · `F` pantalla completa · `O` vista general · `-` / `+` velocidad de las simulaciones.

## Probar

Desde `presentaciones-guideline/tools` (después de `npm i`):

```bash
node smoke.js ../../presentacion-proxy-reverso    # escritorio
node mobile.js ../../presentacion-proxy-reverso   # celular
```

Y desde esta carpeta: `node tests/interact.js` (motor de ruteo y escenas).

Basada en [presentaciones-guideline](../presentaciones-guideline).
