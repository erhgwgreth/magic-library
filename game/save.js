const fs = require('fs')
const path = require('path')
const { applySavedState } = require('./state')

const SAVE_FILE_NAME = 'save.json'

function savePathFor (userDataPath) {
  return path.join(userDataPath, SAVE_FILE_NAME)
}

function loadGame (userDataPath) {
  try {
    const text = fs.readFileSync(savePathFor(userDataPath), 'utf8')
    return applySavedState(JSON.parse(text))
  } catch {
    return applySavedState(null)
  }
}

// 세션 정보나 실제 입력 내용은 저장하지 않는다.
function saveGame (userDataPath, state) {
  try {
    fs.writeFileSync(savePathFor(userDataPath), JSON.stringify(state, null, 2), 'utf8')
  } catch (error) {
    console.error('게임 저장에 실패했습니다:', error.message)
  }
}

module.exports = { loadGame, saveGame }
