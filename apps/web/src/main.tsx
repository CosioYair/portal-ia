import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App.tsx';
import './tokens.css';
import './styles.css';
import './manual-test-feedback.css';
// Portal IA 2.0: sistema de diseño (base, primitivas, estructura); va el último para que sus primitivas manden.
import './system.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </React.StrictMode>
);
