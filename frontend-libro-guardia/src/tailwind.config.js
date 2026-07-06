/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    "./src/**/*.{js,jsx,ts,tsx}", // Escanea todos los archivos JS, JSX, TS, TSX en la carpeta src
    "./public/index.html",       // También escanea el index.html si tienes clases de Tailwind allí
  ],
  theme: {
    extend: {},
  },
  plugins: [],
}