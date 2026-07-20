/** @type {import('tailwindcss').Config} */
const brand = require('./src/config/brand');

module.exports = {
  content: [
    './src/**/*.{js,jsx,ts,tsx}',
    './public/index.html',
  ],
  theme: {
    extend: {
      fontFamily: {
        inter: ['Inter', 'sans-serif'],
        sans: ['Inter', 'sans-serif'],
      },
      colors: {
        // Alias histórico "bacar"; valores desde src/config/brand.js
        bacar: {
          bg: brand.backgroundColor,
          surface: '#141414',
          card: '#1a1a1a',
          border: '#2a2a2a',
          muted: '#a3a3a3',
          red: brand.primaryColor,
          'red-hover': brand.primaryColorHover,
        },
      },
      borderRadius: {
        bacar: '0.75rem',
      },
      boxShadow: {
        card: '0 1px 0 rgba(255,255,255,0.04) inset, 0 8px 24px rgba(0,0,0,0.35)',
      },
    },
  },
  plugins: [],
};
