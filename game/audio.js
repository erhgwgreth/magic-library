const DEFAULT_BGM_VOLUME = 0.3

function normalizeBgmVolume (value) {
  if (!Number.isFinite(value)) return DEFAULT_BGM_VOLUME
  return Math.min(1, Math.max(0, value))
}

function setBgmVolume (state, value) {
  if (!state || typeof state !== 'object' || !Number.isFinite(value)) return false
  const bgmVolume = normalizeBgmVolume(value)
  if (!state.settings || typeof state.settings !== 'object') state.settings = {}
  const changed = state.settings.bgmVolume !== bgmVolume
  state.settings.bgmVolume = bgmVolume
  return changed
}

module.exports = {
  DEFAULT_BGM_VOLUME,
  normalizeBgmVolume,
  setBgmVolume,
}
