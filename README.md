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

## Laboratorio con Docker

Lo mismo que muestran las simulaciones, con servicios reales: **nginx** como proxy reverso de tienda.com delante de Usuarios, Órdenes (2 réplicas), Pagos, Pagos v2, Envíos y Web (estáticos). Sólo el proxy publica puertos: los servicios no se pueden alcanzar desde afuera. Hace falta Docker con Compose.

```bash
docker compose up -d --build          # levanta todo
docker compose logs -f proxy          # en otra terminal: cada pedido, a qué servicio fue y qué volvió
docker compose logs -f usuarios ordenes pagos pagos-v2 envios web   # lo que ve cada servicio
docker compose down                   # al terminar
```

| Puerto | Qué es | Slide |
|---|---|---|
| `localhost:8080` | proxy reverso por HTTP | Reglas · Una sola puerta · En la puerta · Proxy + LB · Riesgos |
| `localhost:8443` | el mismo proxy por HTTPS (certificado autofirmado: `curl -k`) | En la puerta (TLS) |
| `localhost:8090` | API gateway: token + límite por cliente | API gateway |

Cada servicio responde quién lo atendió (nombre y réplica) y con qué datos le llegó el pedido:

```
Órdenes (réplica 9680c7) atendió GET /ordenes · pedido #3 · llegó por http desde 192.168.107.1
```

La configuración está en `lab/nginx/`: `reglas.conf` es la tabla ruta → servicio y `nginx.conf` el resto (servicios, TLS, caché, compresión y gateway). Después de editar cualquiera de las dos:

```bash
docker compose exec proxy nginx -s reload
```

### Recorrido

**Reglas: ruta → servicio.** Mismo puerto, servicios distintos según la ruta. Una ruta sin regla la corta el proxy; una regla hacia el servicio equivocado llega al servicio y el 404 lo da él.

```bash
curl localhost:8080/usuarios/42
curl localhost:8080/ordenes
curl localhost:8080/pagos
curl -H 'X-Version: 2' localhost:8080/pagos     # enrutar por header: va a Pagos v2
curl localhost:8080/carrito                     # 404 del proxy: no hay regla
```

Para el 404 del servicio, cambiá en `reglas.conf` el `proxy_pass` de `/usuarios` a `http://pagos`, recargá y pedí `/usuarios`: el pedido llega a Pagos y Pagos contesta que no conoce la ruta.

**Una sola puerta: separar Envíos de Órdenes.** Hoy `/ordenes/envios` lo atiende Órdenes (la regla `/ordenes` coincide por prefijo). Descomentá el bloque de Envíos en `reglas.conf`, recargá y repetí: ahora lo atiende Envíos, y el cliente no cambió nada.

```bash
curl localhost:8080/ordenes/envios/7     # Órdenes
# descomentar "location /ordenes/envios" en lab/nginx/reglas.conf
docker compose exec proxy nginx -s reload
curl localhost:8080/ordenes/envios/7     # Envíos
```

Los servicios no tienen puertos publicados: la única forma de llegar desde afuera es el proxy. Desde adentro de la red sí se ven:

```bash
docker compose exec usuarios wget -qO- localhost:3000/usuarios
```

**Lo que se resuelve una sola vez, adelante.**

```bash
# 🔒 TLS: el cliente habla HTTPS con el proxy; el servicio recibe HTTP y se entera por X-Forwarded-Proto
curl -k https://localhost:8443/usuarios                 # "llegó por https"
curl -kv https://localhost:8443/usuarios 2>&1 | grep -E "subject|SSL connection"

# 💾 Caché: el primer pedido va a Web (MISS), los siguientes los responde el proxy (HIT) y Web no se entera
curl -s -o /dev/null -D - localhost:8080/static/app.js | grep X-Cache
curl -s -o /dev/null -D - localhost:8080/static/app.js | grep X-Cache
docker compose logs web --tail 5                        # sólo llegó el primero

# 🗜 Compresión: el mismo archivo, ~178 KB sin comprimir y ~11 KB con gzip
curl -s -o /dev/null -w "%{size_download} bytes\n" localhost:8080/static/app.js
curl -s -o /dev/null -w "%{size_download} bytes\n" -H 'Accept-Encoding: gzip' localhost:8080/static/app.js
```

**Primero la ruta, después la carga.** Órdenes tiene 2 réplicas y nginx balancea entre ellas (round robin). Sumá réplicas y el proxy las incorpora solo (vuelve a consultar el DNS de Docker cada 2 s):

```bash
for i in $(seq 6); do curl -s localhost:8080/ordenes; done      # alterna entre 2 réplicas
docker compose up -d --scale ordenes=4
for i in $(seq 8); do curl -s localhost:8080/ordenes; done      # ahora entre 4
```

**API gateway.** Un proxy reverso que además sabe quién es el cliente: cada token es un cliente (`token-navegador`, `token-app-movil`) y cada uno tiene su propio límite de 5 pedidos por segundo (más una ráfaga de 5).

```bash
curl localhost:8090/ordenes                                              # 401: sin token
curl -H 'Authorization: Bearer token-app-movil' localhost:8090/ordenes   # 200
curl -H 'Authorization: Bearer token-app-movil' localhost:8090/.env      # 404 en el gateway (escanea)
# Inunda: 10 pedidos de golpe → los primeros pasan, el resto 429
for i in $(seq 10); do curl -s -o /dev/null -w "%{http_code} " -H 'Authorization: Bearer token-app-movil' localhost:8090/ordenes; done; echo
# El límite es por cliente: el navegador sigue pasando aunque la app móvil esté bloqueada
curl -H 'Authorization: Bearer token-navegador' localhost:8090/usuarios
docker compose logs usuarios --tail 1        # el servicio recibe X-Cliente: navegador
```

### Romper cosas

En una terminal dejá pedidos continuos para ver el efecto en vivo:

```bash
while true; do for p in usuarios ordenes pagos; do curl -s -o /dev/null -w "/$p %{http_code}   " localhost:8080/$p; done; echo; sleep 1; done
```

| Qué romper | Comando | Qué se ve | Volver |
|---|---|---|---|
| Un servicio | `docker compose stop pagos` | `/pagos` da **502** (lo devuelve el proxy: hay regla pero nadie contesta); `/usuarios` y `/ordenes` siguen en 200 | `docker compose start pagos` |
| Una réplica de Órdenes | `docker compose up -d --scale ordenes=1` | Puede aparecer algún 502 suelto durante un par de segundos, hasta que el proxy vuelve a consultar el DNS y deja de mandarle a la que se fue; después todo en 200 | `docker compose up -d --scale ordenes=2` |
| Todas las réplicas de Órdenes | `docker compose stop ordenes` | Sólo `/ordenes` da 502 | `docker compose start ordenes` |
| El proxy (la puerta) | `docker compose stop proxy` | Todo da `Failed to connect` (no hay nadie para contestar un código HTTP), aunque los servicios están perfectos: `docker compose exec usuarios wget -qO- localhost:3000/usuarios` sigue respondiendo | `docker compose start proxy` |
| Una regla mal escrita | borrá un `;` en `reglas.conf` y recargá | La recarga se rechaza (el error aparece en `docker compose logs proxy`) y el proxy **sigue con la configuración anterior**: no se cae. Para validar antes de recargar: `docker compose exec proxy nginx -t -c /etc/nginx/lab/nginx.conf` | arreglar y recargar |
| Pagos v2 durante una migración | `docker compose stop pagos-v2` | Sólo los pedidos con `X-Version: 2` dan 502 | `docker compose start pagos-v2` |

El esquema activo/pasivo de la slide de riesgos (una IP compartida que se mueve con keepalived) no está en el laboratorio: necesita una red que Docker Desktop/OrbStack no simula bien en una sola máquina.
