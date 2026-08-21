import { Analytics } from '@vercel/analytics/react'
import MapView from './components/MapView.jsx'

export default function App() {
  return (
    <div style={{ height: '100%', width: '100%' }}>
      <MapView />
      <Analytics />
    </div>
  )
}