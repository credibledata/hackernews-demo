import { lazy, StrictMode, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './styles.css';

// RenderCheck imports MalloyChart directly, so it must be lazy too — a static
// import here would pull Vega back into the main chunk and undo the split.
const RenderCheck = lazy(() =>
  import('./RenderCheck').then((m) => ({ default: m.RenderCheck }))
);

const check = new URLSearchParams(location.search).has('check');

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {check ? (
      <Suspense fallback={<div style={{ padding: 24 }}>Loading…</div>}>
        <RenderCheck />
      </Suspense>
    ) : (
      <App />
    )}
  </StrictMode>
);
