import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.jsx'
import './styles/glass.css'
import { inject } from '@vercel/analytics'

// Vercel Web Analytics. Patches history.pushState, so client-side
// navigation is reported without any per-route wiring.
inject()

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
