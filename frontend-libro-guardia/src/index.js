import React from 'react';
import ReactDOM from 'react-dom/client';
import './index.css'; // Estilos globales de Tailwind
import App from './App';
import reportWebVitals from './reportWebVitals'; // Archivo generado por create-react-app para m�tricas
import brand from './config/brand';
import { applyAppearanceTheme } from './config/applyBrandTheme';
import { fetchAndApplyAppearance } from './utils/appearance';

fetchAndApplyAppearance(applyAppearanceTheme, brand);

const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);

// Si quieres empezar a medir el rendimiento en tu aplicaci�n, pasa una funci�n
// para registrar resultados (por ejemplo: reportWebVitals(console.log))
// o env�alos a un punto final de an�lisis. Aprende m�s: https://bit.ly/CRA-vitals
reportWebVitals();