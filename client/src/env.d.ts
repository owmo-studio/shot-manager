import type { DesktopAPI, DesktopBridge } from '../../shared/desktop'

declare global {
  interface Window {
    desktop: DesktopAPI
    desktopBridge?: DesktopBridge
  }
}
