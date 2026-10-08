# Etapa 2 — Reglas de Firestore para el hub (referencia)

Las reglas **no se despliegan desde este repo** (ver commit `8e04f6b`, "no desplegar reglas de Firestore desde este repo"): se centralizan aparte. Este archivo documenta el fragmento que hay que sumar para la Etapa 2 (T4, `docs/ETAPA2-DISENO.md` §3–§4).

## Quién accede directo a Firestore

- **Usuarios (guardia, Admin)**: nunca. Usan la API (`/api/**`, Functions con Admin SDK). El login es JWT propio, no Firebase Auth.
- **Controladores**: nunca. Hablan con el hub por LAN y, si hace falta, con `/api/edge/v1/*`.
- **Hub**: solo **lectura** de su sitio, con el custom token que entrega `POST /api/edge/v1/token`:
  `admin.auth().createCustomToken(deviceId, { siteId, deviceId, kind: 'hub' })`.
  - `onSnapshot` sobre `sites/{siteId}/compiled/head` (y lectura de los chunks con hash distinto).
  - `onSnapshot` sobre `sites/{siteId}/commands` (aperturas remotas pendientes).
  - Todo lo que escribe (eventos, resultados de comandos, heartbeat, `live/summary`) va por la API, que valida y controla costo.

## Fragmento de reglas

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {

    function isHubOf(siteId) {
      return request.auth != null
        && request.auth.token.kind == 'hub'
        && request.auth.token.siteId == siteId
        && request.auth.token.deviceId == request.auth.uid;
    }

    // Snapshot compilado (head + chunks) del propio sitio: solo lectura.
    match /sites/{siteId}/compiled/{doc} {
      allow read: if isHubOf(siteId);
      allow write: if false;
    }

    // Comandos nube → hub: el hub los lee; el resultado vuelve por
    // POST /api/edge/v1/commands/{id}/result (nunca escribe directo).
    match /sites/{siteId}/commands/{commandId} {
      allow read: if isHubOf(siteId);
      allow write: if false;
    }

    // Todo lo demás de Etapa 2 es solo Admin SDK (Functions):
    //   devices/{id}, deviceEnrollCodes/{hash}, sites/{s}, sites/{s}/journal/**,
    //   sites/{s}/alarms/**, sites/{s}/status/**, sites/{s}/live/**, entries/**.
    match /{document=**} {
      allow read, write: if false;
    }
  }
}
```

Notas:

- El `match /{document=**}` final ya es el comportamiento actual (sin acceso cliente); si las reglas centralizadas tienen otros `allow` para colecciones legacy, sumar solo los dos bloques de `sites/{siteId}/compiled` y `sites/{siteId}/commands`.
- El custom token no se revoca solo: un equipo revocado o reemplazado (`devices/{id}.status != 'active'`) ya no puede pedir token nuevo en `/api/edge/v1/token`, y el ID token de Firebase que tenga vence en ≤ 1 h. Si se necesita corte inmediato, `admin.auth().revokeRefreshTokens(deviceId)` desde Admin (pendiente, T9).
- Costo: una lectura por documento cambiado en cada `onSnapshot`; el head cambia solo con la config (~50/día).
