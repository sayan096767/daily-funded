const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const referralLinks = require('../hosting-public/referral-links.js');
const fundingForgeHtml = fs.readFileSync(
  path.join(__dirname, '../hosting-public/FundingForge.html'),
  'utf8'
);

const referralCode = '0F9B3304C66D33D3A9F37D014D7383D8';

test('parses branded referral paths for backend validation', () => {
  assert.deepEqual(
    referralLinks.parseReferralUrl(`https://www.crazyfunded.com/ref/${referralCode.toLowerCase()}`),
    {code: referralCode.toLowerCase(), source: 'path'}
  );
});

test('parses legacy query referral links', () => {
  assert.deepEqual(
    referralLinks.parseReferralUrl(`https://daily-funded.web.app/FundingForge.html?ref=${referralCode}`),
    {code: referralCode, source: 'query'}
  );
});

test('branded referral paths take precedence over a legacy query code', () => {
  assert.deepEqual(
    referralLinks.parseReferralUrl(
      `https://www.crazyfunded.com/ref/${referralCode}?ref=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`
    ),
    {code: referralCode, source: 'path'}
  );
});

test('malformed referral paths do not fall back to a query code', () => {
  assert.deepEqual(
    referralLinks.parseReferralUrl(
      `https://www.crazyfunded.com/ref/${referralCode}/extra?ref=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`
    ),
    {code: '', source: 'path'}
  );
});

test('non-referral routes are left alone', () => {
  assert.equal(referralLinks.parseReferralUrl('https://www.crazyfunded.com/FundingForge.html'), null);
});

test('builds a supported live-domain URL only from a valid unique-code shape', () => {
  assert.equal(
    referralLinks.buildBrandedUrl(referralCode.toLowerCase()),
    `https://daily-funded.web.app/ref/${referralCode}`
  );
  assert.throws(() => referralLinks.buildBrandedUrl('CRAZYFUNDED'), TypeError);
});

test('dashboard displays the code and copies a branded URL instead of displaying the URL', () => {
  assert.match(fundingForgeHtml, /id="referralLinkInput"[^>]+aria-label="Your referral code"/);
  assert.match(fundingForgeHtml, /linkInput\.value = referralCode;/);
  assert.match(
    fundingForgeHtml,
    /navigator\.clipboard\.writeText\(ReferralLinks\.buildBrandedUrl\(input\.value\)\)/
  );
  assert.doesNotMatch(fundingForgeHtml, /linkInput\.value = shareUrl/);
});

test('dashboard shows referral summary metrics and per-user activity states', () => {
  for (const id of [
    'referralTotalCount',
    'referralQualifiedCount',
    'referralPendingCount',
    'referralEarningsTotal',
    'referralPendingRewards',
    'referralPaidTotal'
  ]) {
    assert.match(fundingForgeHtml, new RegExp(`id="${id}"`));
  }
  for (const label of [
    'Total People Referred',
    'Qualified Referrals',
    'Pending Referrals',
    'Total Referral Earnings',
    'Pending Rewards',
    'Rewards Paid',
    'REFERRAL ACTIVITY'
  ]) {
    assert.ok(fundingForgeHtml.includes(label), `Missing referral dashboard label: ${label}`);
  }
  assert.match(fundingForgeHtml, /result\.pendingRewardsTracked[\s\S]*?'Not tracked'/);
  assert.match(fundingForgeHtml, /entry\.displayName/);
  assert.match(fundingForgeHtml, /entry\.purchaseStatus/);
  assert.match(fundingForgeHtml, /entry\.accountCreatedAt/);
  assert.match(fundingForgeHtml, /data-copy-referral-link/);
  assert.match(fundingForgeHtml, /referrals-history-wrap\{overflow-x:auto;\}/);
});

test('sends parsed referral codes through the existing backend resolver', () => {
  assert.match(fundingForgeHtml, /ReferralLinks\.parseReferralUrl\(url\)/);
  assert.match(fundingForgeHtml, /\/api\/referrals\/resolve/);
  assert.match(fundingForgeHtml, /JSON\.stringify\(\{code:referral\.code\}\)/);
});

test('Firebase Hosting rewrites only the branded referral path to the existing page', () => {
  const firebaseConfig = JSON.parse(
    fs.readFileSync(path.join(__dirname, '../firebase.json'), 'utf8')
  );
  assert.deepEqual(firebaseConfig.hosting.rewrites, [
    {source: '/ref/**', destination: '/FundingForge.html'}
  ]);
});

test('deep referral routes use root-relative page assets and reset redirects', () => {
  assert.match(fundingForgeHtml, /href="\/hero-background\.css"/);
  assert.match(fundingForgeHtml, /src="\/community-banner\.html"/);
  assert.match(fundingForgeHtml, /href="\/terms-and-conditions\.html"/);
  assert.match(fundingForgeHtml, /window\.location\.origin \+ '\/FundingForge\.html'/);
});
