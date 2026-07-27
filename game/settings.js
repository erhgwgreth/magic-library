const fs = require('fs')
const path = require('path')

const SETTINGS_FILE_NAME = 'librarian-settings.json'

function settingsPathFor (userDataPath) {
  return path.join(userDataPath, SETTINGS_FILE_NAME)
}

function loadLibrarianSettings (userDataPath) {
  try {
    const saved = JSON.parse(fs.readFileSync(settingsPathFor(userDataPath), 'utf8'))
    return {
      apiKey: typeof saved.apiKey === 'string' ? saved.apiKey : '',
      useDirectApi: saved.useDirectApi === true,
    }
  } catch {
    return { apiKey: '', useDirectApi: false }
  }
}

function saveLibrarianSettings (userDataPath, settings) {
  fs.writeFileSync(settingsPathFor(userDataPath), JSON.stringify({
    apiKey: typeof settings.apiKey === 'string' ? settings.apiKey.trim() : '',
    useDirectApi: settings.useDirectApi === true,
  }, null, 2), 'utf8')
}

module.exports = { loadLibrarianSettings, saveLibrarianSettings }
