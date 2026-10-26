import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import {ErrorBoundary} from './components/ui/ErrorBoundary';
import {installSessionFetch} from './lib/api';
import './index.css';

// Before anything renders: every fetch('/api/...') the views make (they are being moved to apiFetch one track at a time) gets the
// session handling of src/lib/api.ts, so an idle lock or an ended session is a message on the screen, not a crash.
installSessionFetch();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary fullPage>
      <App />
    </ErrorBoundary>
  </StrictMode>,
);
