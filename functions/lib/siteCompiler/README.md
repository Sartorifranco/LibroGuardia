# Compilador por sitio — T2 de ETAPA2-DISENO

Compila la configuración de Firestore en chunks firmados que consume el edge
(`scripts/edge/lib/db/chunkStore.js`) y el snapshot en memoria de la nube
(`accessEngine/memorySnapshot.js`).

| Archivo | Qué hace |
|---|---|
| `canonical.js` | `canonicalJson` (claves ordenadas, sin espacios, `undefined` omitido) + `chunkHash` = sha256 hex. Idéntico a `chunkStore.js`; el hub lo comparte. |
| `signing.js` | Ed25519: `signHead`, `verifyHead`, `getSigningPublicKey`. Firma = `canonicalJson({version, chunks})`, `head.sig` en base64, `head.keyId`. |
| `build.js` | Transformaciones puras modelo actual → entidades del contrato (`snapshotSchema.js`). |
| `compiler.js` | `createSiteCompiler(deps)`: compilado completo / delta, head, `_dirty`, snapshot en memoria. |
| `index.js` | Instancia por defecto (Firestore real, sitio `process.env.SITE_ID` o `principal`). |

## Firestore

```
sites/{s}                         tz, name, policy {citacionWindowStrict, apbMode, apbResetMin}, areas?, holidays?
sites/{s}/compiled/head           {siteId, version, day, tz, chunks:{name:{v,hash}}, keyId, credentialKeyId, compiledAt, sig, mode}
sites/{s}/compiled/_dirty         {people[], auths[], visitas[], doors, operators, full, at, rev}
sites/{s}/compiledChunks/{name}   {name, v, hash, json}
sites/{s}/secrets/credentialKey   {key (base64, 32 bytes), keyId, alg, createdAt}   ← solo Admin SDK (reglas: denegar todo)
```

Chunks: `doors`, `ch-00..ch-63` (bucket = sha256(personId) % 64, solo los no vacíos),
`grants-YYYYMMDD` (D-1..D+7, solo los no vacíos), `passes`, `operators`, `secrets`.

## Delta y costo

- Cada mutación hace `markDirty(...)` = 1 escritura en `_dirty` (más de 300 ids → `full`).
- Se compila perezoso: `getHead()` (y `getCloudSnapshot()`, como mucho cada 15 s) lee
  head + `_dirty` (2 lecturas) y, si hay cambios o cambió el día, compila. En Cloud
  Functions además se programa un compilado diferido de 5 s (best effort).
  `compileDirtySites()` sirve para colgarlo de un scheduler existente (no se agrega
  un `onSchedule` nuevo).
- Delta de una persona: head, `_dirty`, clave (cacheada 10 min), chunk `doors`, la
  persona, sus autorizaciones, su ficha de nómina, su bucket y los chunks de grants
  existentes de la ventana (≤ 9) → ~11–20 lecturas; escribe el bucket + head + borra
  `_dirty` = 3 escrituras (4 si aparece un horario autogenerado nuevo o cambian sus
  grants).
- El commit es un único batch con precondición `lastUpdateTime` sobre head y `_dirty`:
  si entra otra mutación durante el compilado se reintenta (no se pierde nada).
- Cambio de día → compilado completo (desliza la ventana de grants y es la red de
  seguridad para mutaciones sin gancho). Completo ≈ personas activas + nómina +
  autorizaciones de la ventana + visitas + usuarios (~2.000 lecturas en planta real).

## Clave de firma (Ed25519)

Variable de entorno `EDGE_SIGNING_PRIVATE_KEY` con la privada PEM PKCS#8 (se admiten
`\n` escapados). Sin ella se genera una efímera por proceso (solo tests/emulador).

```bash
node -e "const c=require('crypto');const {privateKey,publicKey}=c.generateKeyPairSync('ed25519');console.log(privateKey.export({type:'pkcs8',format:'pem'}));console.log(publicKey.export({type:'spki',format:'pem'}))"
```

La privada va como secreto de Functions (`firebase functions:secrets:set EDGE_SIGNING_PRIVATE_KEY`);
la pública la publica `getSigningPublicKey()` y la guardan los equipos al enrolarse.

## Clave de credenciales (HMAC-SHA256)

`hashCredential(type, value, key)`: con clave del sitio = HMAC-SHA256, sin clave = sha256
(compatibilidad). El primer compilado completo crea `sites/{s}/secrets/credentialKey`.
Los pases llevan `dniHash` en vez del DNI. La clave viaja hoy en el chunk `secrets`
dentro del bundle firmado — **TODO fase 2**: chunk `secrets` cifrado a la clave pública
de cada equipo (y que el hub no la sirva a los controladores en claro).

## Mapeo del modelo actual

Ver comentario de `build.js` y los casos de `test/siteCompilerFixture.js` (`PARITY_CASES`).
Diferencias con las reglas actuales: las bajas (`active=false`) no se compilan →
`credencial_desconocida` (hoy `persona_inactiva`); permanente fuera de horario →
`fuera_de_horario`; Sistemas → `puerta_directa`; citación obligatoria sin citación →
`sin_citacion_para_hoy`; el turno de nómina no restringe grants de citación/rango;
`'Fe'` en días se ignora; lectores `ambos` no tienen lado fijo (el que llama pasa `side`).
