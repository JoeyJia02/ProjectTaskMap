import { createRoot } from 'react-dom/client';
import { App } from './App';
import { MapBoundary } from './MapBoundary';
import './styles.css';

createRoot(document.getElementById('root')!).render(<MapBoundary><App /></MapBoundary>);
