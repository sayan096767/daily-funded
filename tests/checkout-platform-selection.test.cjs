const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const checkoutHtml = fs.readFileSync(
  path.join(root, 'hosting-public/FundingForge.html'),
  'utf8'
);
const termsHtml = fs.readFileSync(
  path.join(root, 'hosting-public/terms-and-conditions.html'),
  'utf8'
);
const privacyHtml = fs.readFileSync(
  path.join(root, 'hosting-public/privacy-policy.html'),
  'utf8'
);
const backendSource = fs.readFileSync(path.join(root, 'backend/app.py'), 'utf8');
const firebaseConfig = JSON.parse(fs.readFileSync(path.join(root, 'firebase.json'), 'utf8'));

function extractFunction(name, nextName) {
  const start = checkoutHtml.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} was not found`);
  const end = checkoutHtml.indexOf(`\nfunction ${nextName}(`, start);
  assert.notEqual(end, -1, `${nextName} was not found after ${name}`);
  return checkoutHtml.slice(start, end);
}

function platformContext() {
  const radios = ['mt5', 'ctrader', 'match_trader', 'cf'].map(value => ({
    value,
    checked: false,
    card: {classList: {toggle(_name, selected) { this.selected = selected; }}},
    closest() { return this.card; }
  }));
  const unlocked = [];
  const platformSummary = {textContent: '—'};
  const loggedErrors = [];
  const context = vm.createContext({
    document: {
      querySelectorAll: selector => selector === 'input[name="tradingPlatform"]' ? radios : [],
      getElementById: id => id === 'coPlatform' ? platformSummary : null
    },
    setPaymentAccess: () => unlocked.push(false),
    selectedTradingPlatform: '',
    tradingPlatforms: new Set(['mt5', 'ctrader', 'match_trader', 'cf'])
  });
  vm.runInContext(
    `function isValidTradingPlatform(platform){return tradingPlatforms.has(platform);}\n` +
      extractFunction('hasSelectedTradingPlatform', 'setPaymentAccess') +
      '\n' +
      extractFunction('setTradingPlatform', 'normalizeCheckoutSelection'),
    context
  );
  return {context, radios, unlocked, platformSummary};
}

function getFrontendPricing() {
  const start = checkoutHtml.indexOf('const pricing = {');
  const end = checkoutHtml.indexOf('\nfunction renderPlans(', start);
  assert.ok(start >= 0 && end > start, 'frontend pricing catalog was not found');
  const context = vm.createContext({});
  vm.runInContext(
    `${checkoutHtml.slice(start, end)}\nthis.pricing = pricing;`,
    context
  );
  return JSON.parse(JSON.stringify(context.pricing));
}

function getBackendPrices(planKey) {
  const catalogStart = backendSource.indexOf('CATALOG = {');
  const planStart = backendSource.indexOf(`"${planKey}": {`, catalogStart);
  const pricesStart = backendSource.indexOf('"prices": {', planStart);
  const pricesEnd = backendSource.indexOf('}', pricesStart);
  assert.ok(catalogStart >= 0 && planStart > catalogStart && pricesEnd > pricesStart);
  return Object.fromEntries(
    [...backendSource.slice(pricesStart, pricesEnd).matchAll(/(\d+)\s*:\s*(\d+)/g)]
      .map(([, size, price]) => [Number(size), Number(price)])
  );
}

test('Firebase serves the main page with its embedded NOWPayments checkout', () => {
  assert.equal(firebaseConfig.hosting.public, 'hosting-public');
  assert.match(checkoutHtml, /<section id="checkout">/);
  assert.match(checkoutHtml, /Secure checkout · NOWPayments/);
  assert.doesNotMatch(
    checkoutHtml,
    /Attach a payment screenshot with your confirmation|checkout will show a notice when you select it/i
  );
  assert.doesNotMatch(checkoutHtml, /<input[^>]*(?:UPI|upi)|<option[^>]*>UPI/i);
  assert.match(checkoutHtml, /payment updates to our server, which verifies the purchase and settlement/);
  assert.doesNotMatch(
    checkoutHtml,
    /payment proof submission are still required|required payment proof|submit payment proof/i
  );
  assert.match(termsHtml, /NOWPayments sends payment updates to our server/);
  assert.match(termsHtml, /finished payment with an exact verified settlement/);
  assert.match(termsHtml, /current checkout uses NOWPayments as its payment provider/);
  assert.match(termsHtml, /does not ask customers to upload payment proof/);
  assert.match(privacyHtml, /current checkout uses NOWPayments as its payment provider/);
  assert.match(privacyHtml, /server verifies the provider notification and checks payment details against the purchase and NOWPayments records/);
  assert.match(privacyHtml, /NOWPayments for payment processing/);
  assert.match(privacyHtml, /does not ask customers to upload payment proof/);
  assert.doesNotMatch(
    privacyHtml,
    /Payment Proofs|payment confirmation, receipt, transaction screenshot|payment proofs/i
  );
});

test('checkout refresh routes to the saved product before blocking Firebase scripts load', () => {
  const restoreBootstrapIndex = checkoutHtml.indexOf("checkoutRestoreParams.get('checkout') === '1'");
  const firebaseScriptIndex = checkoutHtml.indexOf('firebase-app-compat.js');
  const skeletonIndex = checkoutHtml.indexOf('id="checkoutRestoreSkeleton"');
  assert.ok(restoreBootstrapIndex >= 0 && restoreBootstrapIndex < firebaseScriptIndex);
  assert.ok(skeletonIndex > 0 && skeletonIndex < firebaseScriptIndex);
  assert.match(checkoutHtml, /html\.checkout-restore-pending body>:not\(#checkoutRestoreSkeleton\)/);
  assert.match(checkoutHtml, /checkout-restore-grid/);
  assert.match(checkoutHtml, /checkout-restore-field/);
  assert.match(checkoutHtml, /@media\(prefers-reduced-motion:reduce\)\{\.checkout-restore-shimmer::after\{animation:none/);
  assert.match(checkoutHtml, /id="checkoutRestoreRetry"/);
  assert.match(checkoutHtml, /id="checkoutRestoreBack"/);
  assert.match(checkoutHtml, /onload="this\.onload=null;this\.rel='stylesheet'"/);
});

test('checkout URL preserves its existing parameters and canonical product selection', () => {
  const pricing = getFrontendPricing();
  const selection = {
    market: 'forex',
    productModel: 'spark',
    planKey: 'spark_1step',
    productId: pricing.spark_1step.productId,
    size: 25000
  };
  const url = new URL(
    `https://daily-funded.web.app/FundingForge.html?checkout-theme=20261108&checkout=1&market=forex&model=${selection.productModel}&plan=${selection.planKey}&product=${selection.productId}&size=${selection.size}`
  );
  const context = vm.createContext({
    window: {
      location: {href: url.href, search: url.search},
      history: {state: {existing: true}, replaceState(_state, _title, next) { this.next = next; }}
    },
    URL,
    URLSearchParams,
    pricing,
    sizes: [5000, 10000, 25000, 50000, 100000],
    sparkSizes: [25000, 50000, 100000]
  });
  const normalizeStart = checkoutHtml.indexOf('function normalizeCheckoutSelection(');
  const routeStart = checkoutHtml.indexOf('function readCheckoutRoute()', normalizeStart);
  const writeStart = checkoutHtml.indexOf('function writeCheckoutRoute(', routeStart);
  const clearStart = checkoutHtml.indexOf('function clearCheckoutRoute()', writeStart);
  const end = checkoutHtml.indexOf('\nfunction readStoredPendingCheckout()', clearStart);
  assert.ok(normalizeStart >= 0 && routeStart > normalizeStart && writeStart > routeStart && clearStart > writeStart && end > clearStart);
  vm.runInContext(
    `const sizes = [5000,10000,25000,50000,100000];\n` +
      `const sparkSizes = [25000,50000,100000];\n` +
      `${checkoutHtml.slice(normalizeStart, routeStart)}\n` +
      `${checkoutHtml.slice(routeStart, end)}`,
    context
  );
  const restored = context.readCheckoutRoute();
  assert.equal(restored.requested, true);
  assert.equal(restored.selection.planKey, selection.planKey);
  assert.equal(restored.selection.productModel, selection.productModel);
  assert.equal(restored.selection.productId, selection.productId);
  assert.equal(restored.selection.size, selection.size);
  context.writeCheckoutRoute(restored.selection);
  assert.match(context.window.history.next, /checkout-theme=20261108/);
  assert.match(context.window.history.next, /plan=spark_1step/);
  assert.match(context.window.history.next, /size=25000/);
  context.clearCheckoutRoute();
  assert.match(context.window.history.next, /checkout-theme=20261108/);
  assert.doesNotMatch(context.window.history.next, /(?:^|[?&])checkout=/);
});

test('hosted payment step shows unavailable UPI and selected crypto reference cards', () => {
  assert.match(checkoutHtml, /class="hosted-method-card hosted-method-card-unavailable" aria-label="UPI is unavailable"/);
  assert.match(checkoutHtml, /Unavailable — UPI payments are not supported at this time\./);
  assert.match(checkoutHtml, /class="hosted-method-card hosted-method-card-selected" aria-label="Crypto selected, pay with cryptocurrency"/);
  for (const logo of ['googlepay', 'phonepe', 'paytm', 'bitcoin', 'ethereum', 'tether', 'circle', 'binance']) {
    assert.ok(checkoutHtml.includes(`cdn.simpleicons.org/${logo}/`), `${logo} logo should be displayed`);
  }
  assert.match(checkoutHtml, /\.hosted-method-card-selected\{border:2px solid #347bff/);
  assert.match(checkoutHtml, /\.hosted-upi-app\{display:inline-flex/);
  assert.match(checkoutHtml, /@media\(max-width:960px\)\{[\s\S]*\.hosted-method-card\{grid-template-columns:22px minmax\(0,1fr\) auto/);
  assert.match(checkoutHtml, /\.hosted-method-card \.hosted-method-copy\{grid-column:2\/4;grid-row:2;\}/);
  assert.match(checkoutHtml, /\.hosted-upi-apps\{grid-column:2\/4;grid-row:3;gap:5px;\}/);
});

test('checkout highlights the supplied payment and account activation message', () => {
  assert.match(
    checkoutHtml,
    /<p class="hosted-crypto-note">Your trading journey starts here! Complete your payment and get ready to unlock your funded trading opportunity\. Your account will be activated once your payment is successfully verified\.<\/p>/
  );
  assert.match(checkoutHtml, /\.hosted-crypto-panel \.hosted-crypto-note\{[^}]*border-left:4px solid #34c98b;[^}]*background:#10213b;[^}]*background:linear-gradient\(115deg,#123229,#142648\);[^}]*color:#f4f8ff/);
  assert.match(checkoutHtml, /\.hosted-crypto-note strong\{display:block;[^}]*color:#67e6ab/);
});

test('secure checkout button displays one decorative lock icon', () => {
  const paymentButton = checkoutHtml.match(/<button type="submit" class="btn btn-primary checkout-submit" id="coPayBtn"[\s\S]*?<\/button>/)?.[0];
  assert.ok(paymentButton, 'secure checkout button should exist');
  assert.match(paymentButton, /<svg class="checkout-lock-icon"[^>]*aria-hidden="true"/);
  assert.equal((paymentButton.match(/class="checkout-lock-icon"/g) || []).length, 1);
  assert.match(paymentButton, /Continue to Secure Checkout →/);
});

test('checkout uses the requested responsive color palette and form dimensions', () => {
  assert.match(checkoutHtml, /family=IBM\+Plex\+Sans/);
  assert.match(checkoutHtml, /body\.checkout-open\{[\s\S]*--bg:#060A13;[\s\S]*--bg2:#0E1626;[\s\S]*--panel:#121B2E;[\s\S]*--panel-b:#25314A;/);
  assert.match(checkoutHtml, /@media\(prefers-color-scheme:light\)\{[\s\S]*--bg:#E3E9F4;[\s\S]*--bg2:#F7F9FC;[\s\S]*--panel:#FFFFFF;[\s\S]*--panel-b:#DDE4EF;/);
  assert.match(checkoutHtml, /--checkout-selected:#16264A;[\s\S]*--checkout-check:#34C98B;[\s\S]*--checkout-error:#E5484D/);
  assert.match(checkoutHtml, /--checkout-selected:#E8EFFF;[\s\S]*--checkout-check:#12A06B;[\s\S]*--checkout-error:#E5484D/);
  assert.match(checkoutHtml, /#checkout \.platform-choice\{border:1px solid var\(--panel-b\); border-radius:12px; padding:24px; background:var\(--panel\)/);
  assert.match(checkoutHtml, /height:42px; min-height:42px; padding:0 12px; border:1px solid var\(--panel-b\); border-radius:8px/);
  assert.match(checkoutHtml, /height:46px; border-radius:8px; background:var\(--checkout-accent\); color:var\(--checkout-on-accent\)/);
  assert.match(checkoutHtml, /#applyCouponBtn\{[\s\S]*height:46px;[\s\S]*background:var\(--checkout-accent\);[\s\S]*color:var\(--checkout-on-accent\)/);
});

test('every displayed challenge price matches the backend purchase catalog', () => {
  const frontendPricing = getFrontendPricing();
  for (const planKey of ['1step', '2step', 'instant', 'spark_1step', 'spark_instant']) {
    const frontendPrices = Object.fromEntries(
      Object.entries(frontendPricing[planKey].prices)
        .map(([size, price]) => [Number(size), price])
    );
    assert.deepEqual(frontendPrices, getBackendPrices(planKey), planKey);
  }
  assert.doesNotMatch(
    checkoutHtml,
    /basePrice\s*\*\s*\(1\s*-\s*plan\.discount\)|plan\.prices\?\.\[size\]\s*\?\?/
  );
});

test('checkout defaults to CF and directs customers to hosted crypto selection', () => {
  const platformInputs = [...checkoutHtml.matchAll(/<input type="radio" name="tradingPlatform" value="([^"]+)"([^>]*)>/g)];
  assert.deepEqual(platformInputs.map(match => match[1]), ['mt5', 'ctrader', 'match_trader', 'cf']);
  assert.ok(platformInputs.slice(0, -1).every(match => !/\bchecked\b/.test(match[2])));
  assert.match(platformInputs.at(-1)[2], /\bchecked\b/);
  const platformChoiceIndex = checkoutHtml.indexOf('<fieldset class="platform-choice"');
  const paymentStepIndex = checkoutHtml.indexOf('id="paymentStep"');
  assert.ok(platformChoiceIndex >= 0 && platformChoiceIndex < paymentStepIndex);
  const platformCards = [...checkoutHtml.matchAll(/<label class="platform-card"[^>]*>([\s\S]*?)<\/label>/g)];
  assert.equal(platformCards.length, 4);
  assert.deepEqual(
    platformCards.map(card => card[1].match(/<strong>([^<]+)<\/strong>/)?.[1]),
    ['MetaTrader 5', 'cTrader', 'Match-Trader', 'CF Terminal']
  );
  assert.deepEqual(
    platformCards.map(card => card[1].match(/<img src="([^"]+)"/)?.[1]),
    ['./platform-mt5-mark.png', './platform-ctrader-mark.png', './platform-match-trader-mark.png', './crazy-funded-logo.png']
  );
  assert.match(checkoutHtml, /<span>Trading platform<\/span><b id="coPlatform">CF Terminal<\/b>/);
  assert.match(checkoutHtml, /setTradingPlatform\('cf'\)/);
  assert.match(checkoutHtml, /id="paymentStep" class="payment-step"[^>]*hidden/);
  assert.match(checkoutHtml, /id="billingStep" class="billing-details"/);
  assert.doesNotMatch(checkoutHtml, /id="paymentInterface" hidden/);
  assert.match(checkoutHtml, /class="hosted-crypto-panel"/);
  assert.match(checkoutHtml, /Continue to NOWPayments to choose an available cryptocurrency and network/);
  assert.doesNotMatch(checkoutHtml, /cryptoCurrencySelect|id="curTabs"|id="netTabs"/);
  assert.doesNotMatch(checkoutHtml, /id="copyBtn"|id="qrOpenBtn"|id="attachBtn"|id="proofInput"/);
  assert.match(checkoutHtml, /id="coLabel"/);
  assert.match(checkoutHtml, /id="coSize"/);
  assert.match(checkoutHtml, /id="coSplit"/);
  assert.match(checkoutHtml, /id="coPlatform"/);
  assert.doesNotMatch(checkoutHtml, /Platform selected\. Payment options are now available\./);
});

test('each supported platform selection remains selected without bypassing billing', () => {
  const expectedLabels = {
    mt5: 'MetaTrader 5',
    ctrader: 'cTrader',
    match_trader: 'Match-Trader',
    cf: 'CF Terminal'
  };
  for (const platform of ['mt5', 'ctrader', 'match_trader', 'cf']) {
    const {context, radios, unlocked, platformSummary} = platformContext();
    context.setTradingPlatform(platform);
    assert.equal(context.selectedTradingPlatform, platform);
    assert.deepEqual(unlocked, [false]);
    assert.equal(radios.filter(radio => radio.checked).length, 1);
    assert.equal(radios.find(radio => radio.value === platform).checked, true);
    assert.equal(platformSummary.textContent, expectedLabels[platform]);
  }
});

test('changing platform retains only the final canonical selection', () => {
  const {context, radios, unlocked, platformSummary} = platformContext();
  context.setTradingPlatform('mt5');
  context.setTradingPlatform('match_trader');

  assert.equal(context.selectedTradingPlatform, 'match_trader');
  assert.equal(radios.find(radio => radio.value === 'mt5').checked, false);
  assert.equal(radios.find(radio => radio.value === 'match_trader').checked, true);
  assert.deepEqual(unlocked, [false, false]);
  assert.equal(platformSummary.textContent, 'Match-Trader');
  context.setTradingPlatform('');
  assert.equal(platformSummary.textContent, '—');
});

test('checkout selects CF and posts the authenticated hosted-checkout request without currency', () => {
  const renderStart = checkoutHtml.indexOf('function renderCheckout(');
  const renderEnd = checkoutHtml.indexOf('\nfunction closeCheckout', renderStart);
  const renderSource = checkoutHtml.slice(renderStart, renderEnd);
  assert.match(renderSource, /setTradingPlatform\('cf'\)/);

  const createCheckoutStart = checkoutHtml.indexOf('async function createCryptoCheckout(purchase){');
  const createCheckoutEnd = checkoutHtml.indexOf('\nfunction getPendingSubmissionId', createCheckoutStart);
  const createCheckoutSource = checkoutHtml.slice(createCheckoutStart, createCheckoutEnd);
  assert.ok(createCheckoutStart >= 0 && createCheckoutEnd > createCheckoutStart);
  assert.match(createCheckoutSource, /if\(!isValidTradingPlatform\(selectedTradingPlatform\)\)/);
  assert.match(createCheckoutSource, /firebaseApiHeaders\(/);
  assert.match(createCheckoutSource, /fetch\(API_BASE \+ '\/api\/crypto\/checkout'/);
  assert.match(createCheckoutSource, /tradingPlatform: selectedTradingPlatform/);
  assert.doesNotMatch(createCheckoutSource, /\bcurrency\s*:/);
  assert.match(checkoutHtml, /window\.location\.assign\(purchase\.invoiceUrl\)/);
  assert.doesNotMatch(checkoutHtml, /cryptoCurrencySelect/);
});

test('checkout stacks panels for tablet and uses a 2-by-2 platform grid on phones', () => {
  assert.match(checkoutHtml, /@media\(max-width:820px\)\{\.checkout-grid\{grid-template-columns:1fr;\}\}/);
  assert.match(checkoutHtml, /@media\(max-width:520px\)\{\.platform-card-grid\{grid-template-columns:repeat\(2,minmax\(0,1fr\)\);\}\}/);
});

test('checkout price and coupon rendering use only elements present in the hosted markup', () => {
  const ids = new Set([...checkoutHtml.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]));
  const elements = new Map([...ids].map(id => [id, {
    textContent: '',
    value: '',
    className: '',
    style: {},
    disabled: false,
    hidden: false,
    classList: {add() {}, remove() {}},
    reset() {},
    removeAttribute() {},
    replaceChildren() {},
    appendChild() {}
  }]));
  const queryElements = new Map();
  const context = vm.createContext({
    document: {
      documentElement: {classList: {contains() { return false; }, remove() {}}},
      getElementById: id => elements.get(id) || null,
      querySelector: selector => {
        if (!queryElements.has(selector)) queryElements.set(selector, {style: {}, hidden: false});
        return queryElements.get(selector);
      },
      body: {classList: {add() {}, remove() {}}},
      createElement: () => ({textContent: ''})
    },
    window: {scrollTo() {}},
    readPendingCheckoutState: () => null,
    applyCheckoutAccountDetails(accountDetails) {
      const billing = accountDetails.billing || {};
      for (const [key, id] of Object.entries({
        full_name: 'billingFullName',
        email: 'billingEmail',
        phone: 'billingPhone',
        country: 'billingCountry'
      })) {
        const field = elements.get(id);
        const value = typeof billing[key] === 'string' ? billing[key].trim() : '';
        if (field && value) field.value = value;
      }
      elements.get('billingAccountInfoStatus').textContent = accountDetails.message || '';
    },
    persistPendingCheckoutState() {},
    clearCheckoutRestoreShell() {},
    checkout: {classList: {add() {}, remove() {}, contains() {return false;}}},
    mainSections: [],
    billingFields: {},
    pricing: {'1step': {extra: []}},
    pendingHomepageCoupon: '',
    getPendingSubmissionId: () => 'submission-id',
    setTradingPlatform() {},
    checkoutBasePrice: 32,
    couponApplied: false,
    activeCouponCode: 'CRAZYFUNDED30',
    pendingPurchase: {productModel: 'classic'}
  });
  const formatPrice = extractFunction('formatCheckoutAmount', 'updateCheckoutPrice');
  const updatePrice = extractFunction('updateCheckoutPrice', 'applyCheckoutCoupon');
  const renderCheckout = extractFunction('renderCheckout', 'closeCheckout');
  const applyCouponStart = checkoutHtml.indexOf('function applyCheckoutCoupon()');
  const applyCouponEnd = checkoutHtml.indexOf("\ndocument.getElementById('applyCouponBtn')", applyCouponStart);
  assert.ok(applyCouponStart >= 0 && applyCouponEnd > applyCouponStart);

  vm.runInContext(
    `${formatPrice}\n${updatePrice}\n${renderCheckout}\n${checkoutHtml.slice(applyCouponStart, applyCouponEnd)}`,
    context
  );
  context.renderCheckout({
    productModel: 'classic',
    planKey: '1step',
    label: '1-Step',
    size: 5000,
    split: '80%',
    price: 32
  });
  assert.equal(elements.get('coLabel').textContent, '1-Step Challenge');
  assert.equal(elements.get('coTotal').textContent, '$32');

  elements.get('couponCodeInput').value = 'CRAZYFUNDED30';
  context.applyCheckoutCoupon();
  assert.equal(context.couponApplied, true);
  assert.equal(elements.get('coSubtotal').textContent, '$32');
  assert.equal(elements.get('coDiscount').textContent, '−$9.60');
  assert.equal(elements.get('coTotal').textContent, '$22.40');
  assert.equal(elements.get('coSubtotalRow').style.display, '');
  assert.equal(elements.get('coDiscountRow').style.display, '');

  elements.get('couponCodeInput').value = '';
  context.applyCheckoutCoupon();
  assert.equal(context.couponApplied, false);
  assert.equal(elements.get('coTotal').textContent, '$32');
  assert.equal(elements.get('coSubtotalRow').style.display, 'none');
  assert.equal(elements.get('coDiscountRow').style.display, 'none');
});

function billingContext(values = {}) {
  const fieldIds = {
    full_name: 'billingFullName',
    email: 'billingEmail',
    phone: 'billingPhone',
    country: 'billingCountry',
    state: 'billingState',
    city: 'billingCity',
    postal_code: 'billingPostalCode',
    address_line_1: 'billingAddressLine1',
    address_line_2: 'billingAddressLine2',
    company_name: 'billingCompanyName',
    tax_id: 'billingTaxId'
  };
  const fields = Object.fromEntries(
    Object.entries(fieldIds).map(([key, id]) => [id, {
      value: values[key] ?? '',
      attributes: {},
      setAttribute(name, value) { this.attributes[name] = value; },
      removeAttribute(name) { delete this.attributes[name]; },
      focus(options) { this.focused = true; this.focusOptions = options; },
      scrollIntoView(options) { this.scrollOptions = options; }
    }])
  );
  const errors = Object.fromEntries(
    Object.values(fieldIds).map(id => [`${id}Error`, {textContent: ''}])
  );
  const status = {textContent: ''};
  const sourceStart = checkoutHtml.indexOf('function validateBillingDetails(');
  const sourceEnd = checkoutHtml.indexOf('\nasync function createCryptoCheckout(', sourceStart);
  assert.ok(sourceStart >= 0 && sourceEnd > sourceStart);
  const context = vm.createContext({
    document: {getElementById: id => fields[id] || errors[id] || (id === 'billingContinueStatus' ? status : null)},
    countryData: [{code: 'US'}, {code: 'CA'}]
  });
  vm.runInContext(
    `const billingFields = ${JSON.stringify(fieldIds)};\n` +
      `let billingPaymentUnlocked = false;\n` +
      `let billingValidationAttempted = false;\n` +
      `let pendingPurchase = {};\n` +
      `let tradingPlatformSelected = true;\n` +
      `const paymentAccess = [];\n` +
      `function hasSelectedTradingPlatform(){return tradingPlatformSelected;}\n` +
      `function normalizeCheckoutSelection(){return true;}\n` +
      `function setPaymentAccess(){paymentAccess.push(billingPaymentUnlocked);}\n` +
      checkoutHtml.slice(sourceStart, sourceEnd),
    context
  );
  return {context, fields, errors, status};
}

test('billing validation blocks empty, partial, malformed, and unselected billing details', () => {
  for (const [values, expectedError] of [
    [{}, 'billingFullNameError'],
    [{full_name: 'Buyer'}, 'billingEmailError'],
    [{full_name: 'Buyer', email: 'bad-email'}, 'billingEmailError'],
    [{full_name: 'Buyer', email: 'buyer@example.com', phone: 'letters'}, 'billingPhoneError'],
    [{full_name: 'Buyer', email: 'buyer@example.com', phone: '4155552671', country: ''}, 'billingCountryError'],
    [{
      full_name: 'Buyer', email: 'buyer@example.com', phone: '4155552671',
      country: 'US', state: 'CA', city: 'San Francisco', postal_code: '94105',
      address_line_1: '   '
    }, 'billingAddressLine1Error']
  ]) {
    const {context, errors} = billingContext(values);
    const result = context.validateBillingDetails();
    assert.equal(result.valid, false);
    assert.ok(errors[expectedError].textContent);
  }
});

test('billing validation trims required values and permits empty optional fields', () => {
  const {context} = billingContext({
    full_name: '  Buyer Name  ',
    email: ' buyer@example.com ',
    phone: ' +1 (415) 555-2671 ',
    country: 'US',
    state: ' California ',
    city: ' San Francisco ',
    postal_code: ' 94105 ',
    address_line_1: ' 1 Market Street ',
    address_line_2: ' ',
    company_name: '',
    tax_id: ''
  });
  const result = context.validateBillingDetails();
  assert.equal(result.valid, true);
  assert.equal(result.details.full_name, 'Buyer Name');
  assert.equal(result.details.address_line_1, '1 Market Street');
  assert.equal(result.details.address_line_2, '');
});

test('billing validation moves focus only when explicitly requested', () => {
  const {context, fields} = billingContext({
    full_name: 'Buyer Name',
    phone: '9876543210',
    city: 'Hyderabad'
  });
  context.validateBillingDetails();
  assert.equal(fields.billingEmail.focused, undefined);
  assert.equal(fields.billingFullName.focused, undefined);
  context.validateBillingDetails(true);
  assert.equal(fields.billingEmail.focused, true);
  assert.equal(fields.billingEmail.scrollOptions.behavior, 'smooth');
  assert.equal(fields.billingEmail.scrollOptions.block, 'center');
  assert.equal(fields.billingEmail.focusOptions.preventScroll, true);

  const handlersStart = checkoutHtml.indexOf("checkoutSubmissionFormEl.addEventListener('input'");
  const handlersEnd = checkoutHtml.indexOf("\n}\nconst attachPopupOkEl", handlersStart);
  const handlers = checkoutHtml.slice(handlersStart, handlersEnd);
  assert.match(handlers, /addEventListener\('input',refreshBillingValidation\)/);
  assert.match(handlers, /addEventListener\('change',refreshBillingValidation\)/);
  assert.match(handlers, /const billing = validateBillingDetails\(true\)/);
});

test('continuing with incomplete billing scrolls to the first invalid field and keeps payment locked', () => {
  const {context, fields, errors, status} = billingContext({
    full_name: 'Buyer Name',
    email: 'buyer@example.com',
    phone: '9876543210',
    country: 'US',
    state: 'Telangana',
    postal_code: '500001',
    address_line_1: 'Test Street'
  });

  assert.equal(context.continueToPayment(), false);
  assert.equal(vm.runInContext('billingPaymentUnlocked', context), false);
  assert.equal(fields.billingCity.focused, true);
  assert.equal(fields.billingCity.scrollOptions.behavior, 'smooth');
  assert.equal(fields.billingCity.scrollOptions.block, 'center');
  assert.equal(fields.billingEmail.focused, undefined);
  assert.equal(errors.billingCityError.textContent, 'Enter your city.');
  assert.match(status.textContent, /Complete the highlighted billing details/);

  fields.billingCity.value = 'Hyderabad';
  assert.equal(context.continueToPayment(), true);
  assert.equal(vm.runInContext('billingPaymentUnlocked', context), true);
  assert.equal(status.textContent, '');
});

test('billing form precedes hosted payment and submission uses shared validation', () => {
  const billingIndex = checkoutHtml.indexOf('id="billingDetailsTitle"');
  const continueIndex = checkoutHtml.indexOf('id="billingContinueBtn"');
  const paymentIndex = checkoutHtml.indexOf('id="paymentStep"');
  const submitIndex = checkoutHtml.indexOf('id="coPayBtn"');
  assert.ok(billingIndex >= 0 && billingIndex < continueIndex && continueIndex < paymentIndex && paymentIndex < submitIndex);
  assert.match(checkoutHtml, /id="checkoutSubmissionForm" novalidate/);
  assert.match(checkoutHtml, /id="paymentStep" class="payment-step"[^>]*hidden/);
  assert.match(checkoutHtml, /id="billingEmail" name="email" type="email"[^>]*required/);
  assert.match(checkoutHtml, /id="billingPhone" name="phone" type="tel"[^>]*required/);
  assert.match(checkoutHtml, /billing_details: billing\.details/);
  assert.match(checkoutHtml, /billingContinueBtnEl\.addEventListener\('click',continueToPayment\)/);
  assert.match(checkoutHtml, /billingBackBtnEl\.addEventListener\('click',returnToBilling\)/);
  assert.match(checkoutHtml, /checkoutSubmissionFormEl\.addEventListener\('submit'/);
  assert.match(checkoutHtml, /if\(!billingPaymentUnlocked\)\{\s*continueToPayment\(\);\s*return;/);
  assert.match(checkoutHtml, /if\(!billingPaymentUnlocked\) throw new Error\('Complete billing details before submitting payment\.'\)/);
  assert.equal((checkoutHtml.match(/id="billingStep"/g) || []).length, 1);
  assert.equal((checkoutHtml.match(/id="paymentStep"/g) || []).length, 1);
  assert.match(checkoutHtml, /document\.getElementById\('paymentStep'\)\?\.scrollIntoView\(\{behavior:'smooth',block:'start'\}\)/);
  assert.match(checkoutHtml, /document\.getElementById\('billingStep'\)\?\.scrollIntoView\(\{behavior:'smooth',block:'start'\}\)/);
  assert.match(checkoutHtml, /if\(billingStep\) billingStep\.hidden = enabled;\s*if\(paymentStep\) paymentStep\.hidden = !enabled;/);
});

test('account creation details map to matching billing fields without invented profile fields', () => {
  for (const [id, name] of [
    ['registrationFirstName', 'firstName'],
    ['registrationLastName', 'lastName'],
    ['registrationDateOfBirth', 'dateOfBirth'],
    ['registrationCountry', 'country'],
    ['registrationPhone', 'phone'],
    ['registrationEmail', 'email']
  ]) {
    assert.match(checkoutHtml, new RegExp(`id="${id}" name="${name}"`));
  }
  assert.match(checkoutHtml, /const registrationPayload = \{firstName,lastName,dateOfBirth,country,phone\}/);
  assert.match(checkoutHtml, /API_BASE \+ '\/api\/auth\/register'/);
  assert.match(checkoutHtml, /API_BASE \+ '\/api\/auth\/me'/);
  assert.match(backendSource, /profile_ref\.set\(profile, merge=True\)/);
  assert.match(backendSource, /def user_document\(uid\):/);

  const mapStart = checkoutHtml.indexOf('function mapAccountToBillingDetails(');
  const mapEnd = checkoutHtml.indexOf('\nasync function loadCheckoutAccountDetails(', mapStart);
  assert.ok(mapStart >= 0 && mapEnd > mapStart);
  const context = vm.createContext({});
  vm.runInContext(checkoutHtml.slice(mapStart, mapEnd), context);
  const mapped = context.mapAccountToBillingDetails({
    firstName: ' Ada ',
    lastName: ' Lovelace ',
    email: 'ada@example.com',
    phone: '+442079460123',
    country: 'GB',
    dateOfBirth: '1815-12-10'
  }, {displayName: 'Firebase Name', email: 'auth@example.com'});
  assert.deepEqual({...mapped}, {
    full_name: 'Ada Lovelace',
    email: 'ada@example.com',
    phone: '+442079460123',
    country: 'GB'
  });
  const missing = context.mapAccountToBillingDetails({}, {displayName: '', email: 'new@example.com'});
  assert.deepEqual({...missing}, {full_name: '', email: '', phone: '', country: ''});
});

test('checkout loads the authenticated profile and visibly reports when profile loading fails', async () => {
  const mapStart = checkoutHtml.indexOf('function mapAccountToBillingDetails(');
  const loaderStart = checkoutHtml.indexOf('async function loadCheckoutAccountDetails(', mapStart);
  const loaderEnd = checkoutHtml.indexOf('\nfunction formatCheckoutAmount(', loaderStart);
  assert.ok(mapStart >= 0 && loaderStart > mapStart && loaderEnd > loaderStart);
  const profileResult = {
    uid: 'user-123',
    email: 'account@example.com',
    profile: {
      firstName: 'Ada',
      lastName: 'Lovelace',
      email: 'account@example.com',
      phone: '+442079460123',
      country: 'GB'
    }
  };
  const loggedErrors = [];
  const context = vm.createContext({
    API_BASE: 'https://api.example.test',
    firebaseApiHeaders: async headers => headers,
    fetch: async (url,options) => {
      assert.equal(url, 'https://api.example.test/api/auth/me');
      assert.equal(options.credentials, 'same-origin');
      return {ok: true, json: async () => profileResult};
    },
    console: {error(...args) { loggedErrors.push(args); }}
  });
  vm.runInContext(
    checkoutHtml.slice(mapStart, loaderEnd),
    context
  );
  const loaded = await context.loadCheckoutAccountDetails({
    uid: 'user-123',
    displayName: 'Firebase Display Name',
    email: 'account@example.com'
  });
  assert.deepEqual(loggedErrors, []);
  assert.deepEqual({...loaded.billing}, {
    full_name: 'Ada Lovelace',
    email: 'account@example.com',
    phone: '+442079460123',
    country: 'GB'
  });
  assert.match(loaded.message, /Complete any required fields that remain blank/);

  context.fetch = async () => ({ok: false, status: 503});
  const fallback = await context.loadCheckoutAccountDetails({
    uid: 'user-123',
    displayName: 'Firebase Display Name',
    email: 'account@example.com'
  });
  assert.deepEqual({...fallback.billing}, {
    full_name: 'Firebase Display Name',
    email: 'account@example.com',
    phone: '',
    country: ''
  });
  assert.match(fallback.message, /could not load your saved account details/i);
});

test('checkout pre-fills only account-matched identity fields and leaves other billing details untouched', () => {
  const renderStart = checkoutHtml.indexOf('function renderCheckout(selection,accountDetails=');
  const renderEnd = checkoutHtml.indexOf('\nfunction initializeCheckoutRestore', renderStart);
  const renderSource = checkoutHtml.slice(renderStart, renderEnd);
  assert.match(renderSource, /applyCheckoutAccountDetails\(accountDetails\)/);
  assert.match(checkoutHtml, /renderCheckout\(selection,\{billing:\{\},message:'Loading your saved account details…'\}\)/);
  assert.match(checkoutHtml, /applyCheckoutAccountDetails\(accountDetails,true\)/);
  const helperStart = checkoutHtml.indexOf('function applyCheckoutAccountDetails(');
  const helperEnd = checkoutHtml.indexOf('\nasync function loadCheckoutAccountDetails(', helperStart);
  assert.ok(helperStart >= 0 && helperEnd > helperStart);
  const values = {
    billingFullName: {value: ''},
    billingEmail: {value: 'typed@example.com'},
    billingPhone: {value: ''},
    billingCountry: {value: ''},
    billingState: {value: 'User State'},
    billingCity: {value: 'User City'},
    billingAccountInfoStatus: {textContent: ''}
  };
  const context = vm.createContext({document: {getElementById: id => values[id] || null}});
  vm.runInContext(checkoutHtml.slice(helperStart, helperEnd), context);
  context.applyCheckoutAccountDetails({
    billing: {full_name: 'Ada Lovelace', email: 'profile@example.com', phone: '+442079460123', country: 'GB'},
    message: 'Profile details loaded.'
  }, true);
  assert.equal(values.billingFullName.value, 'Ada Lovelace');
  assert.equal(values.billingEmail.value, 'typed@example.com');
  assert.equal(values.billingPhone.value, '+442079460123');
  assert.equal(values.billingCountry.value, 'GB');
  assert.equal(values.billingState.value, 'User State');
  assert.equal(values.billingCity.value, 'User City');
  assert.equal(values.billingAccountInfoStatus.textContent, 'Profile details loaded.');
});

test('payment and billing replace each other in place without clearing billing values', () => {
  const billingStep = {hidden: false, scrollIntoView(options) { this.scrollOptions = options; }};
  const paymentStep = {hidden: true, scrollIntoView(options) { this.scrollOptions = options; }};
  const controls = {};
  controls.coPayBtn = {setAttribute(name, value) { this[name] = value; }, disabled: true};
  const nodes = {billingStep, paymentStep, ...controls};
  const values = {
    billingFullName: 'Buyer Name',
    billingEmail: 'buyer@example.com',
    billingPhone: '9876543210',
    billingAddressLine2: 'Suite 2',
    billingCompanyName: 'Buyer Co',
    billingTaxId: 'TAX-123'
  };
  const context = vm.createContext({
    document: {getElementById: id => nodes[id] || null},
    hasSelectedTradingPlatform: () => true,
  });
  const accessStart = checkoutHtml.indexOf('function setPaymentAccess(){');
  const accessEnd = checkoutHtml.indexOf('\nfunction setTradingPlatform(', accessStart);
  const backStart = checkoutHtml.indexOf('function returnToBilling(){');
  const backEnd = checkoutHtml.indexOf('\nasync function createCryptoCheckout(', backStart);
  assert.ok(accessStart >= 0 && accessEnd > accessStart && backStart >= 0 && backEnd > backStart);
  vm.runInContext(
    'let billingPaymentUnlocked = false;\n' +
      checkoutHtml.slice(accessStart, accessEnd) +
      '\n' +
      checkoutHtml.slice(backStart, backEnd),
    context
  );

  vm.runInContext('billingPaymentUnlocked = true; setPaymentAccess();', context);
  assert.equal(billingStep.hidden, true);
  assert.equal(paymentStep.hidden, false);
  assert.equal(controls.coPayBtn.disabled, false);

  context.returnToBilling();
  assert.equal(billingStep.hidden, false);
  assert.equal(paymentStep.hidden, true);
  assert.equal(controls.coPayBtn.disabled, true);
  assert.equal(billingStep.scrollOptions.behavior, 'smooth');
  assert.equal(billingStep.scrollOptions.block, 'start');
  assert.deepEqual(values, {
    billingFullName: 'Buyer Name',
    billingEmail: 'buyer@example.com',
    billingPhone: '9876543210',
    billingAddressLine2: 'Suite 2',
    billingCompanyName: 'Buyer Co',
    billingTaxId: 'TAX-123'
  });
});

test('hosted checkout uses the provider URL and keeps coin selection off-site', () => {
  const requestStart = checkoutHtml.indexOf('async function createCryptoCheckout(purchase){');
  const requestEnd = checkoutHtml.indexOf('\nfunction getPendingSubmissionId', requestStart);
  const requestSource = checkoutHtml.slice(requestStart, requestEnd);
  assert.ok(requestStart >= 0 && requestEnd > requestStart);
  assert.match(requestSource, /fetch\(API_BASE \+ '\/api\/crypto\/checkout'/);
  assert.match(requestSource, /firebaseApiHeaders\(/);
  assert.match(requestSource, /billing_details: billing\.details/);
  assert.doesNotMatch(requestSource, /\bcurrency\s*:/);
  assert.match(requestSource, /invoiceUrl\.hostname !== 'nowpayments\.io'/);
  assert.match(checkoutHtml, /window\.location\.assign\(purchase\.invoiceUrl\)/);
  assert.doesNotMatch(checkoutHtml, /cryptoCurrencySelect|id="curTabs"|id="netTabs"/);
});

test('dashboard retries paid pending provisioning and reloads the actual engine account', async () => {
  const start = checkoutHtml.indexOf('async function loadDashboardAccounts(){');
  const end = checkoutHtml.indexOf('\nlet billingValidationAttempted', start);
  assert.ok(start >= 0 && end > start);
  const source = checkoutHtml.slice(start, end);
  const requests = [];
  const responses = [
    {
      ok: true,
      status: 200,
      json: async () => [{
        id: 'purchase-doc-id',
        purchaseId: 'purchase-verified',
        provisioningStatus: 'pending',
        status: 'pending_provisioning'
      }]
    },
    {
      ok: true,
      status: 200,
      json: async () => ({provisioningStatus: 'provisioned'})
    },
    {
      ok: true,
      status: 200,
      json: async () => [{
        id: 'purchase-doc-id',
        purchaseId: 'purchase-verified',
        provisioningStatus: 'provisioned',
        status: 'active',
        tradingEnabled: true,
        tradingEngineAccountId: 'ACC_11111111-1111-4111-8111-111111111111'
      }]
    }
  ];
  const context = vm.createContext({
    API_BASE: 'https://api.example.test',
    firebaseApiHeaders: async headers => ({...headers, Authorization: 'Bearer test-token'}),
    fetch: async (url, options = {}) => {
      requests.push({url, options});
      return responses.shift();
    },
    console: {error() {}}
  });
  vm.runInContext(`${source}\nthis.loadDashboardAccounts = loadDashboardAccounts;`, context);
  await context.loadDashboardAccounts();

  assert.deepEqual(requests.map(request => request.options.method || 'GET'), ['GET', 'POST', 'GET']);
  assert.equal(
    requests[1].url,
    'https://api.example.test/api/my/purchases/purchase-verified/provision'
  );
  assert.equal(requests[1].options.headers.Authorization, 'Bearer test-token');
  assert.equal(context.dashboardAccounts[0].tradingEngineAccountId, 'ACC_11111111-1111-4111-8111-111111111111');
  assert.match(checkoutHtml, /Payment verified\. Account provisioning is pending/);
  assert.doesNotMatch(checkoutHtml, /id="accountEngineId"/);
  assert.doesNotMatch(checkoutHtml, /ENGINE ['"] \+ data\.tradingEngineAccountId/);
  assert.doesNotMatch(checkoutHtml, /MT5 password|trading credentials/i);
});

test('all supplied platform images are present and admin supports historical records', () => {
  for (const asset of [
    'platform-mt5-mark.png',
    'platform-ctrader-mark.png',
    'platform-match-trader-mark.png',
    'crazy-funded-logo.png'
  ]) {
    assert.ok(fs.existsSync(path.join(root, 'hosting-public', asset)), `${asset} is missing`);
  }
  const adminHtml = fs.readFileSync(path.join(root, 'hosting-public/admin/index.html'), 'utf8');
  assert.match(adminHtml, /platformLabels\[purchase\.tradingPlatform\] \|\| 'Not recorded'/);
  assert.match(adminHtml, /Settlement \$\{escapeHtml\(purchase\.settlementStatus\)\}/);
});
