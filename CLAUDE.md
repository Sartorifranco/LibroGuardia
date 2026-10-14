# CLAUDE.md — MSS Guard (LG)

Leé esto antes de empezar. Tiene el contexto del proyecto, así que no hace falta historial de conversaciones anteriores.

## Qué es
Control de acceso empresarial (puertas, portones, estancos, visitas, vehículos, guardia) para un predio de transporte de caudales. Lo usan guardias y administrativos **no técnicos**: textos simples en español rioplatense, sin jerga y con ayuda en pantalla. Tiene que ser simple, robusto y apto para celular. **Aún no está en producción**: hay un banco de pruebas en la oficina.

## Estructura
- `functions/` — backend (Firebase Cloud Functions, Express `api`, región southamerica-east1, Node 20). Rutas en `functions/routes/`, lógica en `functions/lib/`.
  - `lib/accessEngine/`: motor de decisión puro (horarios, estanco/interlock, antipassback, motivos en `reasons.es.js`).
  - `lib/siteCompiler/`: compila la config del sitio en chunks versionados y firmados (Ed25519) para el borde.
  - `routes/edge.js`, `lib/devices.js`, `lib/edgeIngest.js`: API de equipos de borde (enrolar, config, eventos, comandos).
  - Permisos: `functions/permissions.js` (espejo en `frontend-libro-guardia/src/utils/permissions.js`; mantener los dos iguales).
- `frontend-libro-guardia/` — React (CRA). Administración en `src/pages/Admin/` y `src/components/`; los componentes de admin compartidos están en `src/components/admin-ui/` (PageHeader, Modal, WizardModal, PageContainer, AdvancedSection, HelpTip, Stepper). El menú admin está en `src/utils/adminNav.js`.
- `scripts/edge/` — software de borde: `controller/` (Raspberry/PC que abre 1–2 puertas, máquina de estados, drivers en `drivers/`), `hub/` (central del sitio: sincroniza config, sube eventos, LAN API y SSE), `lib/db` (SQLite).
- `docs/` — diseño (`ETAPA2-DISENO.md`), banco (`ETAPA2-BANCO.md`), consumo (`CONSUMO.md`) e instalación.

## Reglas del producto
- Todo crear/editar en admin va en ventana emergente (Modal/WizardModal). Nada estirado al 100 % del ancho: usar PageContainer (narrow, medium o wide).
- Estanco: nunca dos puertas del mismo grupo abiertas a la vez. Toda apertura queda registrada. Forzar requiere motivo y queda en auditoría.
- Costo Firebase: tope de **US$ 10 por mes**. Mucho caché y trabajo local/offline; no agregar lecturas en bucle ni polling contra Firestore.

## Cómo trabajar
- Tests: `cd functions; npm test` y `cd frontend-libro-guardia; $env:CI='true'; npm test -- --watchAll=false`; build: `$env:CI='false'; npm run build`. Si el build solo cambia finales de línea en `public/index.html` o `public/manifest.json`, revertí esos archivos.
- Commits en español. No hacer push ni deploy, ni instalar dependencias, salvo pedido explícito.
- Nunca imprimir secretos (tokens, claves, refreshToken).

## Consumo de IA (obligatorio)
- **Una conversación nueva por tarea.** No retomar chats viejos (`--resume` / `--continue`).
- **Modo Auto** en Cursor.
- Tareas **cortas y concretas**: un objetivo, los archivos involucrados y el criterio de "terminado". Pocos reintentos: si algo falla dos veces, frená y reportá.
- No leer archivos enteros si alcanza con una búsqueda. No pegar logs largos ni capturas grandes.
- Las tareas de Cursor se lanzan con `C:\Users\Admin\.cursor-uso\cursor-tarea.ps1`, que registra el consumo de cada una.
- Las tareas chicas y no sensibles van a Gemini gratis con `C:\Users\Admin\.cursor-uso\gemini-tarea.ps1`. A Gemini **nunca** le van secretos, la config real del predio ni lo crítico (`accessEngine`, `siteCompiler`/firmas, `permissions.js`, `scripts/edge/controller`): eso va a Cursor. El reparto completo está en el CLAUDE.md global.
