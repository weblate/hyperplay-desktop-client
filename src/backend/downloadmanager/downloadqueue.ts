import { TypeCheckedStoreBackend } from './../electron_store'
import { logError, logInfo, LogPrefix } from '../logger/logger'
import { getFileSize, getGame } from '../utils'
import { DMQueueElement } from 'common/types'
import { installQueueElement, updateQueueElement } from './utils'
import { sendFrontendMessage } from '../main_window'
import { downloadGame } from 'backend/hyperplay/library'

const downloadManager = new TypeCheckedStoreBackend('downloadManager', {
  cwd: 'store',
  name: 'download-manager'
})

/*
#### Private ####
*/

type DownloadManagerState = 'idle' | 'running'
type DMStatus = 'done' | 'error' | 'abort'
let queueState: DownloadManagerState = 'idle'

function getFirstQueueElement() {
  const elements = downloadManager.get('queue', [])
  return elements.at(0) ?? null
}

function addToFinished(element: DMQueueElement, status: DMStatus) {
  const elements = downloadManager.get('finished', [])

  const elementIndex = elements.findIndex(
    (el) => el.params.appName === element.params.appName
  )

  if (elementIndex >= 0) {
    elements[elementIndex] = { ...element, status: status ?? 'abort' }
  } else {
    elements.push({ ...element, status })
  }

  downloadManager.set('finished', elements)
  logInfo(
    [element.params.appName, 'added to download manager finished.'],
    LogPrefix.DownloadManager
  )
}

/*
#### Public ####
*/

async function initQueue() {
  let element = getFirstQueueElement()
  queueState = element ? 'running' : 'idle'

  while (element) {
    const queuedElements = downloadManager.get('queue', [])
    sendFrontendMessage('changedDMQueueInformation', queuedElements)

    if (element.params.runner === 'gog' || element.params.runner === 'legendary') {
      const game = getGame(element.params.appName, element.params.runner)
      const installInfo = await game.getInstallInfo(
        element.params.platformToInstall
      )
      element.params.size = installInfo?.manifest?.download_size
        ? getFileSize(installInfo?.manifest?.download_size)
        : '?? MB'
    } else {
      element.params.size = '?? MB'
    }
    element.startTime = Date.now()
    queuedElements[0] = element
    downloadManager.set('queue', queuedElements)

    const { status } = (element.params.runner === 'gog' || element.params.runner === 'legendary') && element.type === 'install'
      ? await installQueueElement(element.params)
      : (element.params.runner === 'gog' || element.params.runner === 'legendary') && element.type === 'update'
        ? await updateQueueElement(element.params)
        : (element.params.runner === 'hyperplay') ? await downloadGame(element.params.appName) : { status: 'error' as const }

    element.endTime = Date.now()
    addToFinished(element, status)
    removeFromQueue(element.params.appName)
    element = getFirstQueueElement()
  }
  queueState = 'idle'
}

function addToQueue(element: DMQueueElement) {
  if (!element) {
    logError(
      'Can not add undefined element to queue!',
      LogPrefix.DownloadManager
    )
    return
  }

  sendFrontendMessage('gameStatusUpdate', {
    appName: element.params.appName,
    runner: element.params.runner,
    folder: element.params.path,
    status: 'queued'
  })

  const elements = downloadManager.get('queue', [])

  const elementIndex = elements.findIndex(
    (el) => el.params.appName === element.params.appName
  )

  if (elementIndex >= 0) {
    elements[elementIndex] = element
  } else {
    elements.push(element)
  }

  downloadManager.set('queue', elements)
  logInfo(
    [element.params.gameInfo.title, ' was added to the download queue.'],
    LogPrefix.DownloadManager
  )

  sendFrontendMessage('changedDMQueueInformation', elements)

  if (queueState === 'idle') {
    initQueue()
  }
}

function removeFromQueue(appName: string) {
  if (appName && downloadManager.has('queue')) {
    const elements = downloadManager.get('queue', [])
    const index = elements.findIndex(
      (queueElement) => queueElement?.params.appName === appName
    )
    if (index !== -1) {
      elements.splice(index, 1)
      downloadManager.delete('queue')
      downloadManager.set('queue', elements)
    }

    sendFrontendMessage('gameStatusUpdate', {
      appName,
      status: 'done'
    })

    logInfo(
      [appName, 'removed from download manager.'],
      LogPrefix.DownloadManager
    )

    sendFrontendMessage('changedDMQueueInformation', elements)
  }
}

function getQueueInformation() {
  const elements = downloadManager.get('queue', [])
  const finished = downloadManager.get('finished', [])

  return { elements, finished }
}

export { initQueue, addToQueue, removeFromQueue, getQueueInformation }
