import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import { Shell } from './shell/Shell.js';

createRoot(document.getElementById('root')!).render(<StrictMode><Shell /></StrictMode>);

// Installable, but never offline for data: the service worker keeps only the application files (sw.js never touches /api).
if ('serviceWorker' in navigator && import.meta.env.PROD) void navigator.serviceWorker.register('/sw.js');
