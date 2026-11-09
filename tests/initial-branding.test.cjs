const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..');
const firebaseConfig = JSON.parse(
  fs.readFileSync(path.join(root, 'firebase.json'), 'utf8')
);
const fundingForgeHtml = fs.readFileSync(
  path.join(root, firebaseConfig.hosting.public, 'FundingForge.html'),
  'utf8'
);

test('Firebase Hosting source renders Crazy Funded branding in its initial HTML', () => {
  const brands = [...fundingForgeHtml.matchAll(
    /<div class="brand"[^>]*>[\s\S]*?<\/div>/g
  )].map(match => match[0]);

  assert.equal(brands.length, 2, 'expected the shared header and footer brand blocks');
  assert.match(fundingForgeHtml, /<title>Crazy Funded\b/);

  for (const brand of brands) {
    assert.match(brand, /aria-label="Crazy Funded"/);
    assert.match(
      brand,
      /window\.location\.protocol === 'file:' \? '\.\/crazy-funded-logo\.png' : '\/crazy-funded-logo\.png'/
    );
    assert.match(brand, /<img[^>]+width="30"[^>]+height="30"/);
    assert.match(brand, /<span>Crazy<\/span> <span class="brand-funded">Funded<\/span>/);
    assert.doesNotMatch(brand, /FundingForge|Funding Forge/);
  }
});

test('homepage branding assets support file previews without changing hosted URLs', () => {
  assert.match(
    fundingForgeHtml,
    /window\.location\.protocol === 'file:'[\s\S]*?'\.\/hero-background\.css'[\s\S]*?'\/hero-background\.css'/
  );
  assert.match(
    fs.readFileSync(path.join(root, firebaseConfig.hosting.public, 'hero-background.css'), 'utf8'),
    /url\("hero-assets\.png"\)/
  );
  assert.ok(
    fs.existsSync(path.join(root, firebaseConfig.hosting.public, 'crazy-funded-logo.png')),
    'expected the Crazy Funded logo asset'
  );
  assert.ok(
    fs.existsSync(path.join(root, firebaseConfig.hosting.public, 'hero-assets.png')),
    'expected the hero background image'
  );
});

test('delayed scripts cannot restore the legacy brand or its embedded logo', () => {
  assert.doesNotMatch(fundingForgeHtml, /Funding Forge/);
  assert.doesNotMatch(fundingForgeHtml, /FundingForge(?!\.html)/);
  assert.doesNotMatch(fundingForgeHtml, /data:image\/png;base64,/);
  assert.doesNotMatch(fundingForgeHtml, /brand\.replaceChild|logo\.replaceWith/);
});
