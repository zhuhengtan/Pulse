import React from 'react'
import { createRoot } from 'react-dom/client'
import { PulseApp } from './PulseApp.js'
import { PulseDesignSystem } from './PulseDesignSystem.js'
import { createBrowserRouter, RouterProvider } from 'react-router'
import './style.css'
import './redesign.css'
import './messages.css'
import './composer.css'

try {
  const appearance = JSON.parse(window.localStorage.getItem('pulse-web-appearance') ?? '{}') as Record<string, string>
  document.documentElement.dataset.theme = appearance.theme ?? 'system'
  document.documentElement.dataset.interfaceScale = appearance.interfaceScale ?? 'standard'
  document.documentElement.dataset.codeScale = appearance.codeScale ?? 'standard'
} catch {
  document.documentElement.dataset.theme = 'system'
}

const root = document.getElementById('root')
if (!root) throw new Error('PULSE_WEB_ROOT_NOT_FOUND')
const router = createBrowserRouter([{ path: '*', element: <PulseApp /> }])
createRoot(root).render(<React.StrictMode><PulseDesignSystem><RouterProvider router={router} /></PulseDesignSystem></React.StrictMode>)
