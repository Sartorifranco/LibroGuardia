# Consumo de Firebase

Esta pantalla estima cuánto gasta el sitio en Firestore y avisa si el mes se va a pasar de un tope. El dueño quiere quedarse en la cuota gratis y, como red de seguridad, no pasar de US$ 10 por mes.

## Qué se mide

Hay dos números, y no son lo mismo:

1. **Medición propia.** El servidor cuenta lecturas, escrituras y borrados según quién los pidió: GPS, guardia, equipos, administración, BioStar, actualización de equipos, ingresos al sistema, avisos y el resto. Una consulta cuenta los documentos que devuelve (como mínimo 1). Cada alta, cambio o borrado cuenta 1.
2. **Consumo real de Google.** Si la cuenta del servidor puede, se consulta Cloud Monitoring (lecturas, escrituras y borrados de Firestore, sumados por día, últimos 30 días). Ese resultado se guarda una hora para no consultarlo de más.

La medición propia se vuelca como máximo cada 5 minutos, y también al terminar un trabajo programado, en el documento `usage/AAAAMMDD`. La fecha es la del ciclo de Firestore: medianoche, hora del Pacífico.

## Cómo se calcula el costo

Precios de Firestore en `southamerica-east1`, verificados el 08/10/2026. Fuente: https://cloud.google.com/firestore/pricing

| Concepto | Precio |
| --- | --- |
| Lecturas | US$ 0,045 cada 100.000 |
| Escrituras | US$ 0,135 cada 100.000 |
| Borrados | US$ 0,015 cada 100.000 |
| Almacenamiento | US$ 0,135 por GiB al mes |

Cada día se descuenta la cuota gratis antes de cobrar: 50.000 lecturas, 20.000 escrituras y 20.000 borrados. Esa cuota se reinicia a medianoche, hora del Pacífico.

La proyección del mes es el gasto estimado de los días que van, repartido en los días que faltan. Cloud Functions tiene 2 millones de invocaciones gratis por mes y después US$ 0,40 por millón. En la práctica el GPS ya no debería acercarse a eso.

Los precios editables están en `functions/lib/usage/pricing.js`.

## GPS

Antes, cada 5 minutos se leía la configuración, un documento por vehículo, la lista de móviles y la de vehículos, y se reescribía el estado de todos aunque no se hubieran movido. Con 30 vehículos eran unas 65 lecturas y 33 escrituras por vuelta (cerca de 19.000 lecturas y 9.500 escrituras por día).

Ahora el estado de todos los vehículos vive en `settings/fleetGpsTracks` (un solo documento si entra en 900 KB; si no, de a 200). Solo se escribe si cambió la zona, si pasó de quieto a en movimiento o al revés, si hubo un cruce, o cada 30 minutos como latido. La foto y la configuración se escriben solo si cambió el contenido. Móviles y vehículos autorizados quedan en memoria 10 minutos.

En una vuelta sin cambios: 3 lecturas y 0 escrituras de GPS. Con 30 vehículos quietos son unas 860 lecturas por día. Las escrituras bajan a un latido de la flota cada 30 minutos (unas 50) más el volcado del medidor al terminar el trabajo (una escritura cada 5 minutos, unas 290).

## Cómo ver el consumo real de Google

La función usa la cuenta de servicio que corre Cloud Functions (en la 2ª generación suele ser `PROYECTO@appspot.gserviceaccount.com` o la cuenta por defecto de Compute).

1. Entrá a Google Cloud → IAM y administración → IAM.
2. Buscá esa cuenta de servicio.
3. Agregale el rol **Visor de Monitoring** (`roles/monitoring.viewer`).
4. Esperá unos minutos y abrí de nuevo Administración → Consumo.

Si falta el permiso, la pantalla lo dice y sigue mostrando la estimación propia. No inventa el número de Google.

## Alerta de tope

En Consumo se puede cambiar el tope del mes (empieza en US$ 5). Si la proyección lo supera, el control de equipos que ya corre cada 5 minutos manda un mail, como máximo una vez por día. El aviso se llama **Tope de consumo** y hay que tener las notificaciones prendidas y un correo cargado. En la misma pantalla aparece una alarma en rojo.

No se creó un trabajo nuevo de Cloud Scheduler: esta cuenta tiene 3 trabajos gratis y ya están usados.

## Presupuesto en Google Cloud (la red de US$ 10)

Además de la alerta de la aplicación:

1. Google Cloud → Facturación → Presupuestos y alertas.
2. Crear presupuesto.
3. Alcance: este proyecto.
4. Importe: **US$ 10**.
5. Alertas al **50 %**, **90 %** y **100 %**.
6. Enviar los avisos a los correos de quien administra el sitio.

Ese presupuesto lo cobra Google aunque la aplicación esté caída. El de la pantalla Consumo es el aviso interno, más temprano.
