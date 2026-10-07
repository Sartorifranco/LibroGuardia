# Si se cae la PC de planta — qué hacer

MSS decide quién entra. La puerta física la abre un programa que corre en una PC de la planta. Si esa PC se apaga, o el programa queda colgado, el molinete no responde aunque el panel web siga abierto.

No se usa PM2.

## Cómo te vas a enterar

1. Entrá a https://mss-guard.web.app → **Admin → Equipos de acceso**.
2. **Lectores** y **Estaciones** muestran En línea, Sin señal o Desconectado.
3. La estación avisa a la nube cada **60 segundos** (heartbeat).
4. Si un puente que ya había reportado deja de avisar unos 30 minutos, puede llegar un mail **Puente local sin señal**. Ese aviso tiene que estar activado en las notificaciones.

## Qué hacer en el momento

1. Andá hasta la PC de planta. Confirmá que está encendida, con red y con hora de Windows automática.
2. Mirá qué falta y usá el archivo que corresponda (doble clic, va a pedir Administrador):

| Si pasa esto | Ejecutá este archivo |
|---|---|
| El lector no lee o la puerta de planta no abre | `scripts\02-reiniciar-estacion.cmd` |
| Nunca se instaló la estación en esta PC | `scripts\01-instalar-estacion.cmd` |
| El servicio de la estación quedó apuntando a un programa viejo | `scripts\01b-reinstalar-servicio-estacion.cmd` |
| Las puertas se abren a distancia (túnel) y eso dejó de andar | `scripts\03b-reiniciar-apertura-por-internet.cmd` |
| Nunca se instaló la apertura a distancia | `scripts\03-arrancar-apertura-por-internet.cmd` |
| BioStar no manda usuarios o eventos | `scripts\05b-reiniciar-servicio-biostar.cmd` |
| Nunca se instaló BioStar en el servidor | `scripts\05-instalar-servicio-biostar.cmd` |
| Querés ver BioStar en una ventana, solo para probar | `scripts\04-arrancar-puente-biostar.cmd` |

3. Volvé al panel y probá abrir la puerta.
4. Si el lector figura En línea y el relé igual no dispara, avisá a soporte. Ahí el problema ya no es “la PC apagada”.

La llave o el bypass físico del molinete lo decide la planta. El programa no lo reemplaza.

## Qué tiene que estar vivo

| Qué | Cómo corre | Nombre en Windows |
|---|---|---|
| Lectores y relé en la planta | Servicio NSSM (arranque automático) | `LibroGuardiaDoor-...` ejecuta `programa-estacion.js` |
| Apertura a distancia (túnel, puerto 5022) | Tarea programada | `BacarGuard-SR201-Bridge` |
| BioStar 2 | Tarea programada | `MSSGuard-BioStar-Bridge` |

La estación manda heartbeat cada 60 segundos.

Si el programa de la estación **queda colgado** (no se cerró, pero no contesta), un control lo mira cada 1 minuto en `http://127.0.0.1:<puerto>/status`. Si falla **3 veces seguidas**, reinicia el servicio NSSM. Ese control lo deja instalado `01-instalar-estacion.cmd`. Si la estación se instaló antes de este control, corré `01b-reinstalar-servicio-estacion.cmd` una vez.

BioStar y la apertura a distancia se recuperan solos si el proceso **se cierra**: hasta 3 reintentos, con 1 minuto entre cada uno, y un rearme todos los días a las 04:00. Si se agotaron los 3 reintentos, usá `03b` o `05b`.

## Si Windows se reinició

No hace falta dejar una sesión abierta:

1. El servicio de la estación arranca solo.
2. Las tareas `MSSGuard-BioStar-Bridge` y `BacarGuard-SR201-Bridge` arrancan solas con Windows.

Si después del reinicio algo no responde, usá `02`, `03b` o `05b` según la tabla de arriba.

## Dónde seguir

- Guía corta de la carpeta: [scripts/LEEME.md](../scripts/LEEME.md)
- Comandos para el equipo técnico: [RUNBOOK-INSTALACION.md](./RUNBOOK-INSTALACION.md)
