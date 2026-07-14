# Páginas de dominio

Refactor de `App.js` monolítico en páginas por dominio. Cada página posee su estado y fetches.

## Nota de bug — `fetchCurrentUser` / deps de `logout` (no corregir a ciegas)

### En qué consistía (código original en `App.js`)

Había un `useEffect` que, al tener `authToken`, llamaba a `/auth/me` para hidratar `currentUser`. En el `catch` (token inválido / red / 401) invocaba `handleLogout` (o `logout`).

Ese efecto **listaba `authToken` en el array de dependencias pero omitía `handleLogout`**. En React, eso significa:

1. El efecto guarda en el closure la versión de `handleLogout` del **primer render** en que se montó con ese token.
2. Si `handleLogout` cambia de identidad entre renders (porque se recrea al cambiar otros estados que captura), el efecto **no se vuelve a registrar** y sigue llamando a la función **vieja**.
3. En la práctica, el logout “stale” puede dejar de limpiar estados nuevos (p. ej. roles, tabs, toasts) o, en variantes peores, no coincidir con el `setAuthToken` actual.

Es el clásico warning de `react-hooks/exhaustive-deps` con riesgo real de **sesión inconsistente al fallar `/auth/me`**, no un bug de negocio de permisos.

### Estado hoy

La carga de sesión vive en `AuthContext` y declara `[authToken, logout]` en deps, con `logout` estabilizado vía `useCallback([])`. Eso **mitiga** el caso principal.

### Por qué no “arreglar más” en esta tanda

Queda documentado porque cualquier cambio adicional (p. ej. no hacer logout en errores de red no-401) es decisión de producto y puede interactuar con `apiFetch` / sesión expirada. Revisar en otra tanda si se quiere: distinguir 401 (logout) vs offline temporal (mantener sesión local).
