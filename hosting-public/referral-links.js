(function(root, factory) {
  const referralLinks = factory();
  if (typeof module === 'object' && module.exports) module.exports = referralLinks;
  if (root) root.CrazyFundedReferralLinks = referralLinks;
})(typeof window === 'undefined' ? globalThis : window, function() {
  const referralCodePattern = /^[A-Fa-f0-9]{32}$/;

  function parseReferralUrl(location) {
    const url = new URL(typeof location === 'string' ? location : location.href);
    if (url.pathname === '/ref' || url.pathname.startsWith('/ref/')) {
      const pathMatch = url.pathname.match(/^\/ref\/([^/]+)\/?$/);
      return {
        code: pathMatch ? pathMatch[1] : '',
        source: 'path'
      };
    }
    if (url.searchParams.has('ref')) {
      return {
        code: url.searchParams.get('ref') || '',
        source: 'query'
      };
    }
    return null;
  }

  function normalizeReferralCode(code) {
    if (typeof code !== 'string' || !referralCodePattern.test(code)) {
      throw new TypeError('Referral service returned an invalid referral code.');
    }
    return code.toUpperCase();
  }

  function buildBrandedUrl(code) {
    return 'https://daily-funded.web.app/ref/' + normalizeReferralCode(code);
  }

  return Object.freeze({parseReferralUrl, normalizeReferralCode, buildBrandedUrl});
});
