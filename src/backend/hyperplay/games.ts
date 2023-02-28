import { getHyperPlayGameInfo } from 'backend/hyperplay/library'
import { existsSync } from 'graceful-fs'
import { isWindows, isMac, isLinux } from '../constants'

export const isHpGameAvailable = (appName: string) => {
  const hpGameInfo = getHyperPlayGameInfo(appName)
  if (hpGameInfo && hpGameInfo.install.platform === 'web') {
    return true
  }

  if (hpGameInfo.install && hpGameInfo.install.executable) {
    return existsSync(hpGameInfo.install.executable)
  }
  return false
}

export function isHpGameNative(appName: string): boolean {
  const {
    install: { platform }
  } = getHyperPlayGameInfo(appName)
  if (platform) {
    if (platform === 'web') {
      return true
    }

    if (isWindows) {
      return true
    }

    if (isMac && platform === 'Mac') {
      return true
    }

    // small hack, but needs to fix the typings
    const plat = platform.toLowerCase()
    if (isLinux && plat === 'linux') {
      return true
    }
  }

  return false
}