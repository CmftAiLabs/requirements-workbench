import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './design-tokens.css';
import './style.css';
import './layout.css';
import './collaboration-workspace.css';
import './workspace-header.css';
import './ui-guidelines.css';

createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>);
