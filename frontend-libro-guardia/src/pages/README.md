# Páginas de dominio

Refactor de `App.js` monolítico en páginas por dominio. Cada página posee su estado y fetches.

## Nota de bug (no corregir aquí)

El `fetchCurrentUser` original en `App.js` omitía `handleLogout` en las dependencias del `useEffect`.
`AuthContext` ahora encapsula la carga de sesión y usa `logout` de forma estable en deps.
