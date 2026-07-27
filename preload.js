const { contextBridge, ipcRenderer } = require('electron')

// 렌더러는 화면 표시와 요청만 맡는다. 게임 상태와 API 키는 메인 프로세스가 관리한다.
contextBridge.exposeInMainWorld('api', {
  onGameState: (callback) => ipcRenderer.on('game-state', (_event, data) => callback(data)),
  performAction: (actionName, args) => ipcRenderer.invoke('perform-action', actionName, args),
  updateAnimalPosition: (animalId, position) => ipcRenderer.invoke('update-animal-position', animalId, position),
  respondToLibrarianProposal: (accepted) => ipcRenderer.invoke('respond-to-librarian-proposal', accepted),
  updateLibrarianDirective: (directive) => ipcRenderer.invoke('update-librarian-directive', directive),
  saveLibrarianApiKey: (apiKey, useDirectApi) => ipcRenderer.invoke('save-librarian-api-key', apiKey, useDirectApi),
  markLibrarianReportRead: () => ipcRenderer.invoke('mark-librarian-report-read'),
  clearReadLibrarianReport: () => ipcRenderer.invoke('clear-read-librarian-report'),
})
