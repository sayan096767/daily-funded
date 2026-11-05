const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const fundingForgeHtml = fs.readFileSync(
  path.join(__dirname, '../hosting-public/FundingForge.html'),
  'utf8'
);

test('homepage promotional sections remain in the document and are dashboard-scoped', () => {
  const sections = [
    ['#dfWorkspacePreview', 'id="dfWorkspacePreview"'],
    ['.payout-mission-banner', 'class="payout-mission-banner"'],
    ['#dfWhyChoose', 'id="dfWhyChoose"'],
    ['#dfRulesStrip', 'id="dfRulesStrip"'],
    ['.df-human-support', 'class="df-human-support"'],
    ['#faq', 'id="faq"']
  ];

  for (const [selector, markup] of sections) {
    assert.ok(fundingForgeHtml.includes(markup), `${selector} homepage markup was removed`);
  }

  assert.match(
    fundingForgeHtml,
    /body\.dashboard-open #dfWorkspacePreview,\s*body\.dashboard-open \.payout-mission-banner,\s*body\.dashboard-open #dfWhyChoose,\s*body\.dashboard-open #dfRulesStrip,\s*body\.dashboard-open \.df-human-support,\s*body\.dashboard-open #faq,\s*#dashboard \.desk-objectives-banner\{display:none!important;\}/
  );
});

test('legacy account-objectives banner is scoped to the dashboard and hidden there', () => {
  assert.match(fundingForgeHtml, /#dashboard \.desk-objectives-banner\{display:none!important;\}/);
  assert.doesNotMatch(fundingForgeHtml, /<iframe[^>]+class="desk-objectives-banner"/);
});

test('dashboard keeps separate copy-code and copy-link actions', () => {
  assert.match(fundingForgeHtml, /id="referralLinkInput"[^>]+aria-label="Your referral code"/);
  assert.match(fundingForgeHtml, /linkInput\.value = referralCode;/);
  assert.match(fundingForgeHtml, /id="referralCopyCodeButton"[^>]*>Copy Code<\/button>/);
  assert.match(fundingForgeHtml, /id="referralCopyLinkButton"[^>]*>Copy Referral Link<\/button>/);
  assert.match(fundingForgeHtml, /getElementById\('referralCopyCodeButton'\)\.addEventListener/);
  assert.match(fundingForgeHtml, /getElementById\('referralCopyLinkButton'\)\.addEventListener/);
  assert.match(
    fundingForgeHtml,
    /navigator\.clipboard\.writeText\(input\.value\)/
  );
  assert.match(
    fundingForgeHtml,
    /navigator\.clipboard\.writeText\(ReferralLinks\.buildBrandedUrl\(input\.value\)\)/
  );
  assert.match(fundingForgeHtml, /ReferralLinks\.parseReferralUrl\(url\)/);
});

test('all inline scripts remain syntactically valid', () => {
  const scripts = [...fundingForgeHtml.matchAll(
    /<script\b(?!(?:[^>]*\bsrc\s*=))[^>]*>([\s\S]*?)<\/script>/gi
  )];
  assert.ok(scripts.length > 0, 'no inline scripts found');

  scripts.forEach((script, index) => {
    new vm.Script(script[1], {filename: `FundingForge-inline-${index + 1}.js`});
  });
});
