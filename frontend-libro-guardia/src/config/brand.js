/**
 * ============================================================================
 * CONFIGURACIÓN DE MARCA — edición por instalación / cliente
 * ============================================================================
 *
 * Cada cliente tiene su propia instancia de Firebase (instalación dedicada).
 * Para blanquear una copia para un cliente nuevo, editá SOLO este archivo
 * y reemplazá el logo en /public (ver logoPath). Luego:
 *   npm start   o   npm run build
 * El script de prebuild regenera index.html y manifest.json desde estos valores.
 *
 * NO hace falta tocar componentes React ni App.css a mano.
 * ============================================================================
 */

const brand = {
  /** Razón social / marca comercial. */
  companyName: 'Manager Sistem Security',

  /** Título de la app (header principal, <title> del HTML, PWA). */
  appTitle: 'MSS Guard',

  /** Título grande de la pantalla de login (puede diferir de appTitle). */
  loginTitle: 'Manager Sistem Security',

  /**
   * Archivo del logo en /public (PNG transparente).
   * Prefijo / para que funcione en todas las rutas del SPA.
   */
  logoPath: '/mss-logo.png',

  /** Texto alternativo del logo (accesibilidad). */
  logoAlt: 'Manager Sistem Security — MSS',

  /** Color primario de la marca (botones, acentos, theme-color). */
  primaryColor: '#e11d2e',

  /** Variante más oscura para hover de botones / acentos. */
  primaryColorHover: '#b01020',

  /** Fondo base del tema oscuro y background_color del PWA. */
  backgroundColor: '#0a0a0a',

  /** Subtítulo bajo el logo en la pantalla de login. */
  loginSubtitle: 'Manager Sistem Security — MSS · Control de accesos',

  /** Subtítulo del header cuando no está en modo admin. */
  headerSubtitle: 'Manager Sistem Security — MSS · Control de accesos y novedades',

  /** Título del topbar del kiosko de acceso. */
  kioskTitle: 'Control de Acceso',

  /** Texto bajo el título del topbar del kiosko de acceso. */
  kioskSubtitle: 'Escanee su DNI o QR para ingresar',

  /** Texto de marca en el footer del kiosko (junto al operador). */
  footerText: 'MSS — Manager Sistem Security',

  /** Título del PDF exportado desde Historial. */
  pdfReportTitle: 'Historial — MSS Guard (Manager Sistem Security)',

  /** Título del PDF del panel gerencial de Reportes. */
  pdfSummaryReportTitle: 'Reporte gerencial — MSS Guard (Manager Sistem Security)',

  /** Descripción corta para meta description / PWA. */
  metaDescription:
    'MSS Guard — Manager Sistem Security. Registro de personal, vehículos y novedades en planta.',

  /** Nombre corto de la PWA (ícono en el home del celular). */
  shortName: 'MSS Guard',

  /**
   * Clave de localStorage para el tema claro/oscuro.
   * En instalaciones nuevas conviene cambiarla (ej. "acme-theme") para
   * no heredar preferencias de otra marca en el mismo navegador.
   */
  themeStorageKey: 'mss-guard-theme',

  /** Placeholder del campo usuario en login (opcional, ejemplo genérico). */
  loginUsernamePlaceholder: 'Ingrese su usuario',

  /** Hosting público de esta instalación. */
  publicOrigin: 'https://mss-guard.web.app',

  /** Nombre largo completo para docs / títulos. */
  fullSystemName: 'Manager Sistem Security - MSS'
};

module.exports = brand;
