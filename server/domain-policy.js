function normalizeDomainRestrictions(input) {
  const raw = Array.isArray(input)
    ? input
    : (typeof input === 'string' ? input.split(/[\n,]+/) : []);
  const cleaned = raw
    .map((item) => String(item || '').trim().toLowerCase())
    .map((item) => item.replace(/^https?:\/\//, '').replace(/\/.*$/, ''))
    .map((item) => item.replace(/^\.+/, '').replace(/\.+$/, ''))
    .filter(Boolean);
  return Array.from(new Set(cleaned));
}

function extractHostFromUrl(url) {
  const text = String(url || '').trim();
  if (!text) return '';
  if (text === 'about:blank') return 'about:blank';
  try {
    const parsed = new URL(text);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      return parsed.hostname.toLowerCase();
    }
    if (parsed.protocol === 'blob:') {
      const inner = parsed.pathname || '';
      if (inner.startsWith('http://') || inner.startsWith('https://')) {
        return new URL(inner).hostname.toLowerCase();
      }
    }
  } catch (_) {
    return '';
  }
  return '';
}

function matchesDomainPattern(host, pattern) {
  if (!host || !pattern) return false;
  const p = String(pattern || '').toLowerCase();
  if (p.startsWith('*.')) {
    const base = p.slice(2);
    if (!base) return false;
    return host === base || host.endsWith(`.${base}`);
  }
  return host === p;
}

function isUrlAllowedByRestrictions(url, restrictions) {
  const normalized = normalizeDomainRestrictions(restrictions);
  if (!normalized.length) {
    return { allowed: true, reason: 'no_restrictions' };
  }
  const host = extractHostFromUrl(url);
  if (host === 'about:blank') {
    return { allowed: true, reason: 'blank_page' };
  }
  if (!host) {
    return { allowed: false, reason: 'invalid_or_unsupported_url' };
  }
  const matched = normalized.some((rule) => matchesDomainPattern(host, rule));
  return {
    allowed: matched,
    reason: matched ? 'matched' : 'domain_not_allowed',
    host
  };
}

function isUrlAllowedForUser(url, browserConfig, user) {
  if (user && user.isAdmin) {
    return { allowed: true, reason: 'admin_bypass' };
  }
  const restrictions = normalizeDomainRestrictions(browserConfig?.domainRestrictions);
  return isUrlAllowedByRestrictions(url, restrictions);
}

module.exports = {
  normalizeDomainRestrictions,
  isUrlAllowedByRestrictions,
  isUrlAllowedForUser
};
