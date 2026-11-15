import type { DesktopAPI, DesktopBridge } from '../../shared/desktop'

declare global {
  const __APP_VERSION__: string
  interface Window {
    desktop: DesktopAPI
    desktopBridge?: DesktopBridge
  }
}
