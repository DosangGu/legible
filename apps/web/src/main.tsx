import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'

import { App } from './app.js'
import { DaemonEventsProvider } from './events.js'
import './styles.css'
import { BrowserConnection } from './connection.js'
import { connectBrowser } from './browser-auth.js'

const root = document.querySelector<HTMLDivElement>('#root')

if (!root) {
  throw new Error('Missing #root element')
}

const connection = connectBrowser()

createRoot(root).render(
  <StrictMode>
    <BrowserConnection initial={connection}>
      <DaemonEventsProvider>
        <BrowserRouter>
          <App />
        </BrowserRouter>
      </DaemonEventsProvider>
    </BrowserConnection>
  </StrictMode>,
)
