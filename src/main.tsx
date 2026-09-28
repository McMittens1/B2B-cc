import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app/App';
import { ErrorBoundary } from './app/ErrorBoundary';
import { ToastProvider } from './app/ui';
import { requestPersistentStorage } from './db/db';
import './app/styles.css';

void requestPersistentStorage();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ToastProvider>
      <ErrorBoundary>
        <App />
      </ErrorBoundary>
    </ToastProvider>
  </StrictMode>,
);
