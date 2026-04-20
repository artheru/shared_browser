function normalizeBaseUrl(baseUrl) {
  return String(baseUrl || '').trim().replace(/\/+$/, '')
}

export function buildReadSkillsUrl({ baseUrl, browserId, token }) {
  const safeBrowserId = String(browserId || '').trim()
  const safeToken = String(token || '').trim() || '<ai-token>'

  const url = new URL(`${normalizeBaseUrl(baseUrl)}/api/ai/help/read-skills`)
  url.searchParams.set('token', safeToken)
  if (safeBrowserId) {
    url.searchParams.set('browserId', safeBrowserId)
  }
  return url.toString()
}
