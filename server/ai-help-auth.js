function isAllowedAiHelpToken({ providedToken, aiToken, browserToken }) {
  const safeProvided = String(providedToken || '').trim();
  if (!safeProvided) return false;
  if (safeProvided === String(aiToken || '').trim()) return true;
  return safeProvided === String(browserToken || '').trim();
}

function resolveAiHelpDisplayToken({ providedToken, browserToken, aiToken }) {
  const safeBrowserToken = String(browserToken || '').trim();
  if (safeBrowserToken) return safeBrowserToken;
  const safeProvided = String(providedToken || '').trim();
  if (safeProvided) return safeProvided;
  return String(aiToken || '').trim();
}

module.exports = {
  isAllowedAiHelpToken,
  resolveAiHelpDisplayToken
};
