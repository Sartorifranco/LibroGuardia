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
  /** Razón social que se muestra en UI, footer del kiosko, etc. */
  companyName: 'Bacar S.A.',

  /** Título de la app (header principal, <title> del HTML, PWA). */
  appTitle: 'Libro de Guardia',

  /** Título grande de la pantalla de login (puede diferir de appTitle). */
  loginTitle: 'Libro de Novedades',

  /**
   * Archivo del logo en /public.
   * Para un cliente nuevo: copiá su logo a public/ con este nombre
   * (o cambiá el nombre acá y usá el archivo correspondiente).
   */
  logoPath: 'B roja.png',

  /** Texto alternativo del logo (accesibilidad). */
  logoAlt: 'Logo Bacar',

  /** Color primario de la marca (botones, acentos, theme-color). */
  primaryColor: '#dc2626',

  /** Variante más oscura para hover de botones / acentos. */
  primaryColorHover: '#b91c1c',

  /** Fondo base del tema oscuro y background_color del PWA. */
  backgroundColor: '#0a0a0a',

  /** Subtítulo bajo el logo en la pantalla de login. */
  loginSubtitle: 'Bacar S.A. — Control de accesos',

  /** Subtítulo del header cuando no está en modo admin. */
  headerSubtitle: 'Bacar S.A. — Control de accesos y novedades',

  /** Título del topbar del kiosko de acceso. */
  kioskTitle: 'Control de Acceso',

  /** Texto bajo el título del topbar del kiosko de acceso. */
  kioskSubtitle: 'Escanee su DNI o QR para ingresar',

  /** Texto de marca en el footer del kiosko (junto al operador). */
  footerText: 'Bacar S.A.',

  /** Título del PDF exportado desde Historial. */
  pdfReportTitle: 'Historial — Libro de Guardia Bacar S.A.',

  /** Título del PDF del panel gerencial de Reportes. */
  pdfSummaryReportTitle: 'Reporte gerencial — Libro de Guardia Bacar S.A.',

  /** Descripción corta para meta description / PWA. */
  metaDescription:
    'Libro de Guardia Bacar — registro de personal, vehículos y novedades en planta.',

  /** Nombre corto de la PWA (ícono en el home del celular). */
  shortName: 'Libro Guardia',

  /**
   * Clave de localStorage para el tema claro/oscuro.
   * En instalaciones nuevas conviene cambiarla (ej. "acme-theme") para
   * no heredar preferencias de otra marca en el mismo navegador.
   */
  themeStorageKey: 'bacar-theme',

  /** Placeholder del campo usuario en login (opcional, ejemplo genérico). */
  loginUsernamePlaceholder: 'Ingrese su usuario'
};

module.exports = brand;
