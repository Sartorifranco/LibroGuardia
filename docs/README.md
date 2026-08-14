# Índice de `docs/`

Guía rápida de qué leer según lo que necesites. Todo lo de acá está vigente salvo
que se indique lo contrario.

## Instalación de hardware (leer en este orden si es una planta nueva)

1. **[INSTALACION-SR201.md](./INSTALACION-SR201.md)** — puente y placa relé SR201 (molinete/puerta): cableado, red, túnel Cloudflare, configuración en Admin.
2. **[INSTALACION-LECTOR-PUERTA.md](./INSTALACION-LECTOR-PUERTA.md)** — lector de DNI serie (GADNIC) por puerta desatendida, emparejamiento, servicio Windows, actualización de versión.
3. **[MULTI-PUERTAS.md](./MULTI-PUERTAS.md)** — conceptos de puerta/lector/estanco y cómo configurar más de una puerta o un estanco (esclusa).

## Operación diaria / soporte de campo

- **[ACTUALIZAR-BRIDGE-ESTACION.md](./ACTUALIZAR-BRIDGE-ESTACION.md)** — guía corta (clicks, sin terminal) para reiniciar o reinstalar la estación de una puerta puntual.
- **[CITACIONES-FOLDER-BRIDGE.md](./CITACIONES-FOLDER-BRIDGE.md)** — puente que sincroniza las planillas Excel/CSV de citados con el sistema. En uso, mantener.
- **[PRUEBA-MOLINETE.md](./PRUEBA-MOLINETE.md)** — checklist de casos de prueba para validar que el molinete autoriza/deniega correctamente después de un deploy o una instalación nueva.

## Referencia / histórico

- **[MIGRACION-BACKEND.md](./MIGRACION-BACKEND.md)** — la **Parte 1** (arriba del todo) es vigente: qué apagar en planta del backend viejo Node+Mongo. La **Parte 2** es la bitácora cerrada de cómo se hizo la migración; no hace falta leerla para instalar o dar soporte.

## Fuera de esta carpeta pero relacionado

- Checklist de alta de cliente nuevo: [`../INSTALL-CLIENTE-NUEVO.md`](../INSTALL-CLIENTE-NUEVO.md)
- Setup general de Firebase: [`../FIREBASE-SETUP.md`](../FIREBASE-SETUP.md)
- Legacy Node+Mongo (no usar): [`../legacy/README.md`](../legacy/README.md)

---

### Qué se limpió acá (14/08/2026)

- Se reparó el encoding (mojibake `Ã±`, `Â»`, etc.) en todos los `.md` de esta carpeta
  y en los archivos raíz que enlazan con ella (`README.md`, `FIREBASE-SETUP.md`,
  `legacy/README.md`).
- Se corrigió un link relativo roto en `legacy/README.md` (apuntaba dos niveles
  arriba de más).
- `MIGRACION-BACKEND.md` se reordenó: lo operativo (Parte 1) va primero, el
  historial cerrado de fases de desarrollo (Parte 2) quedó al final sin
  duplicar contenido.
- No se borró ningún documento — los 7 archivos originales seguían siendo
  información vigente y sin duplicación real entre sí; el problema era encoding
  y orden, no contenido de sobra.
