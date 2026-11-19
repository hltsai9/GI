import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
// Source Serif 4 bundled with the app, so it also works on networks without Google Fonts.
import '@fontsource/source-serif-4/400.css';
import '@fontsource/source-serif-4/400-italic.css';
import '@fontsource/source-serif-4/600.css';
import './styles/broadsheet.css';
import './styles/app.css';
import { App } from './App';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
