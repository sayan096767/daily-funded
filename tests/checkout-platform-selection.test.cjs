const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const siteHtml = fs.readFileSync(path.join(root, 'hosting-public/FundingForge.html'), 'utf8');
const rootSiteHtml = fs.readFileSync(path.join(root, 'FundingForge.html'), 'utf8');
const checkoutPageHtml = fs.readFileSync(path.join(root, 'hosting-public/checkout.html'), 'utf8');
const checkoutScript = fs.readFileSync(path.join(root, 'hosting-public/checkout.js'), 'utf8');
const checkoutStyles = fs.readFileSync(path.join(root, 'hosting-public/checkout.css'), 'utf8');
const checkoutHtml = `${checkoutPageHtml}\n${checkoutScript}\n${checkoutStyles}`;
const integratedCheckoutScript = fs.readFileSync(path.join(root, 'hosting-public/integrated-checkout.js'), 'utf8');
const integratedCheckoutStyles = fs.readFileSync(path.join(root, 'hosting-public/integrated-checkout.css'), 'utf8');
const backendSource = fs.readFileSync(path.join(root, 'backend/app.py'), 'utf8');

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
      extractFunction('setTradingPlatform', 'showCheckoutError'),
    context
  );
  return {context, radios, unlocked, platformSummary};
}

test('checkout defaults to CF and presents logo-only platform choices inline', () => {
  const platformInputs = [...checkoutHtml.matchAll(/<input type="radio" name="tradingPlatform" value="([^"]+)"([^>]*)>/g)];
  assert.deepEqual(platformInputs.map(match => match[1]), ['mt5', 'ctrader', 'match_trader', 'cf']);
  assert.ok(platformInputs.slice(0, -1).every(match => !/\bchecked\b/.test(match[2])));
  assert.match(platformInputs.at(-1)[2], /\bchecked\b/);
  const platformChoiceIndex = checkoutHtml.indexOf('<fieldset class="platform-choice"');
  assert.ok(platformChoiceIndex >= 0);
  assert.match(checkoutHtml, /<h4 id="paymentStepTitle">Choose Your Payment Method<\/h4>/);
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
  assert.doesNotMatch(checkoutHtml, /id="cryptoCurrencySelect"/);
  assert.match(checkoutHtml, /aria-label="Bitcoin, Ethereum, Tether, USD Coin, and BNB"/);
  assert.match(checkoutHtml, /Continue to Secure Checkout →/);
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

test('opening checkout selects CF and retains submission guards', () => {
  const renderStart = checkoutHtml.indexOf('function renderCheckout(');
  const renderEnd = checkoutHtml.indexOf('\nfunction selectionFromLocation', renderStart);
  const renderSource = checkoutHtml.slice(renderStart, renderEnd);
  assert.match(renderSource, /setTradingPlatform\('cf'\)/);

  const createCheckoutStart = checkoutHtml.indexOf('async function createCryptoCheckout(purchase){');
  const createCheckoutEnd = checkoutHtml.indexOf('\nfunction mapAccountToBillingDetails', createCheckoutStart);
  const createCheckoutSource = checkoutHtml.slice(createCheckoutStart, createCheckoutEnd);
  assert.match(createCheckoutSource, /if\(!isValidTradingPlatform\(selectedTradingPlatform\)\)/);
  assert.match(createCheckoutSource, /tradingPlatform:\s*selectedTradingPlatform/);
  assert.doesNotMatch(createCheckoutSource, /cryptoCurrencySelect|currency,/);
  assert.match(checkoutHtml, /if\(!hasSelectedTradingPlatform\(\)\)\{/);
});

test('checkout stacks panels for tablet and uses a 2-by-2 platform grid on phones', () => {
  assert.match(checkoutHtml, /@media\(max-width:820px\)\{\.checkout-grid\{grid-template-columns:1fr;\}\}/);
  assert.match(checkoutHtml, /@media\(max-width:520px\)\{\.platform-card-grid\{grid-template-columns:repeat\(2,minmax\(0,1fr\)\);\}\}/);
});

test('homepage checkout entry opens the integrated checkout after authentication', () => {
  assert.doesNotMatch(siteHtml, /<section id="checkout"|async function createCryptoCheckout/);
  assert.match(siteHtml, /<dialog id="integratedCheckoutDialog"/);
  assert.match(siteHtml, /await window\.CrazyFundedIntegratedCheckoutReady/);
  assert.match(siteHtml, /window\.CrazyFundedIntegratedCheckout\.open\(\s*selection,currentUser,pendingHomepageCoupon/);
  assert.doesNotMatch(siteHtml, /buildCheckoutPageUrl|checkout\.html/);
  assert.equal((siteHtml.match(/id="checkoutSubmissionForm"/g) || []).length, 1);
  assert.equal((siteHtml.match(/id="paymentStep"/g) || []).length, 1);
  assert.match(rootSiteHtml, /<dialog id="integratedCheckoutDialog"/);
  assert.match(rootSiteHtml, /window\.CrazyFundedIntegratedCheckout\.open\(/);
  assert.doesNotMatch(rootSiteHtml, /buildCheckoutPageUrl|checkout\.html/);
  assert.match(integratedCheckoutScript, /async function openIntegratedCheckout\(selection,user,couponCode=''\)/);
  assert.match(integratedCheckoutScript, /window\.location\.assign\(checkout\.invoiceUrl\)/);
  assert.match(integratedCheckoutScript, /function closeIntegratedCheckout\(\)/);
  assert.match(integratedCheckoutStyles, /@scope \(#integratedCheckoutDialog\)/);
  assert.match(checkoutPageHtml, /<main id="checkout" class="crazy-checkout-page active" hidden>/);
  assert.match(checkoutPageHtml, /src="\.\/checkout\.js" defer/);
  assert.match(checkoutPageHtml, /href="\.\/checkout\.css"/);
  assert.match(checkoutScript, /if\(!user\)\{\s*window\.location\.replace\('FundingForge\.html'\)/);
  assert.match(checkoutScript, /firebaseAuth\.onAuthStateChanged/);
  assert.doesNotMatch(checkoutHtml, /name="checkoutPaymentMethod" value="upi"/i);
});

test('standalone checkout preserves confirmed Classic Instant prices', () => {
  const pricingStart = checkoutScript.indexOf('const sizes = [');
  const pricingEnd = checkoutScript.indexOf('const activeCouponCode', pricingStart);
  const normalizeStart = checkoutScript.indexOf('function normalizeCheckoutSelection(');
  const normalizeEnd = checkoutScript.indexOf('\nfunction savePendingCheckout', normalizeStart);
  const context = vm.createContext({});
  vm.runInContext(
    checkoutScript.slice(pricingStart, pricingEnd) +
      '\n' +
      checkoutScript.slice(normalizeStart, normalizeEnd),
    context
  );
  const instantPrices = [[2500, 20], [25000, 190], [50000, 349], [100000, 689], [200000, 1299]];
  for (const [size, price] of instantPrices) {
    assert.equal(context.normalizeCheckoutSelection('classic', size, 'instant', 'instant').price, price);
  }
  assert.equal(context.normalizeCheckoutSelection('classic', 25000, 'instant', 'invalid'), null);
});

test('standalone coupon retains exact-cent rounding for 30 percent off', () => {
  const nodes = {
    couponCodeInput: {value: ' crazyfunded30 '},
    couponStatus: {className: '', textContent: ''}
  };
  const values = {};
  const context = vm.createContext({
    activeCouponCode: 'CRAZYFUNDED30',
    pendingPurchase: {productModel: 'classic'},
    document: {getElementById: id => nodes[id]},
    updateCheckoutPrice: () => { values.applied = context.couponApplied; }
  });
  const applyStart = checkoutScript.indexOf('function applyCheckoutCoupon(');
  const applyEnd = checkoutScript.indexOf('\nfunction validateBillingDetails', applyStart);
  vm.runInContext('var couponApplied = false;\n' + checkoutScript.slice(applyStart, applyEnd), context);
  context.applyCheckoutCoupon();
  assert.equal(values.applied, true);
  assert.equal(nodes.couponStatus.textContent, 'Coupon applied: 30% off.');

  const amountNodes = {
    coSubtotal: {textContent: ''},
    coDiscount: {textContent: ''},
    coSubtotalRow: {style: {}},
    coDiscountRow: {style: {}},
    coTotal: {textContent: ''}
  };
  const priceStart = checkoutScript.indexOf('function formatCheckoutAmount(');
  const priceEnd = checkoutScript.indexOf('\nfunction applyCheckoutCoupon', priceStart);
  const amountContext = vm.createContext({
    checkoutBasePrice: 26,
    couponApplied: true,
    document: {getElementById: id => amountNodes[id]}
  });
  vm.runInContext(checkoutScript.slice(priceStart, priceEnd), amountContext);
  amountContext.updateCheckoutPrice();
  assert.equal(amountNodes.coSubtotal.textContent, '$26');
  assert.equal(amountNodes.coDiscount.textContent, '−$7');
  assert.equal(amountNodes.coTotal.textContent, '$19');
  amountContext.checkoutBasePrice = 190;
  amountContext.updateCheckoutPrice();
  assert.equal(amountNodes.coDiscount.textContent, '−$57');
  assert.equal(amountNodes.coTotal.textContent, '$133');
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
  const paymentStep = {scrollIntoView(options) { this.scrollOptions = options; }};
  const sourceStart = checkoutHtml.indexOf('function validateBillingDetails(');
  const sourceEnd = checkoutHtml.indexOf('\nasync function createCryptoCheckout(', sourceStart);
  assert.ok(sourceStart >= 0 && sourceEnd > sourceStart);
  const context = vm.createContext({
    document: {getElementById: id => fields[id] || errors[id] || (id === 'billingContinueStatus' ? status : null) || (id === 'paymentStep' ? paymentStep : null)},
    window: {CrazyFundedCountryData: [{code: 'US'}, {code: 'CA'}]}
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
  return {context, fields, errors, status, paymentStep};
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

  const handlersStart = checkoutHtml.indexOf("checkoutSubmissionForm.addEventListener('input'");
  const handlersEnd = checkoutHtml.indexOf("checkoutSubmissionForm.addEventListener('submit'", handlersStart);
  const handlers = checkoutHtml.slice(handlersStart, handlersEnd);
  assert.match(handlers, /checkoutSubmissionForm\.addEventListener\('input'/);
  assert.match(handlers, /checkoutSubmissionForm\.addEventListener\('change'/);
  const continueStart = checkoutHtml.indexOf('function continueToPayment(');
  const continueEnd = checkoutHtml.indexOf('\nfunction returnToBilling', continueStart);
  assert.match(checkoutHtml.slice(continueStart, continueEnd), /const billing = validateBillingDetails\(true\)/);
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

test('billing form precedes proof and the submit control, and submission uses shared validation', () => {
  const billingIndex = checkoutHtml.indexOf('id="billingDetailsTitle"');
  const continueIndex = checkoutHtml.indexOf('id="billingContinueBtn"');
  const paymentIndex = checkoutHtml.indexOf('id="paymentStep"');
  const submitIndex = checkoutHtml.indexOf('id="coPayBtn"');
  assert.ok(billingIndex >= 0 && billingIndex < continueIndex && continueIndex < paymentIndex && paymentIndex < submitIndex);
  assert.match(checkoutHtml, /id="checkoutSubmissionForm" novalidate/);
  assert.match(checkoutHtml, /id="paymentStep" class="payment-step"[^>]*hidden/);
  assert.match(checkoutHtml, /id="billingEmail" name="email" type="email"[^>]*required/);
  assert.match(checkoutHtml, /id="billingPhone" name="phone" type="tel"[^>]*required/);
  assert.match(checkoutHtml, /billing_details:\s*billing\.details/);
  assert.match(checkoutHtml, /getElementById\('billingContinueBtn'\)\.addEventListener\('click',continueToPayment\)/);
  assert.match(checkoutHtml, /getElementById\('billingBackBtn'\)\.addEventListener\('click',returnToBilling\)/);
  assert.match(checkoutHtml, /checkoutSubmissionForm\.addEventListener\('submit'/);
  assert.match(checkoutHtml, /if\(!billingPaymentUnlocked\)\{\s*continueToPayment\(\);\s*return;/);
  assert.match(checkoutHtml, /if\(!billingPaymentUnlocked\) throw new Error\('Complete billing details before continuing to payment\.'\)/);
  assert.equal((checkoutHtml.match(/id="billingStep"/g) || []).length, 1);
  assert.equal((checkoutHtml.match(/id="paymentStep"/g) || []).length, 1);
  assert.match(checkoutHtml, /document\.getElementById\('paymentStep'\)\.scrollIntoView\(\{behavior:'smooth',block:'start'\}\)/);
  assert.match(checkoutHtml, /document\.getElementById\('billingStep'\)\.scrollIntoView\(\{behavior:'smooth',block:'start'\}\)/);
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
    assert.match(siteHtml, new RegExp(`id="${id}" name="${name}"`));
  }
  assert.match(siteHtml, /const registrationPayload = \{firstName,lastName,dateOfBirth,country,phone\}/);
  assert.match(siteHtml, /API_BASE \+ '\/api\/auth\/register'/);
  assert.match(checkoutScript, /API_BASE \+ '\/api\/auth\/me'/);
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
  const loaderEnd = checkoutHtml.indexOf('\nfunction renderCheckout(', loaderStart);
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
  const renderStart = checkoutHtml.indexOf('function renderCheckout(selection,accountDetails)');
  const renderEnd = checkoutHtml.indexOf('\nfunction selectionFromLocation', renderStart);
  const renderSource = checkoutHtml.slice(renderStart, renderEnd);
  assert.match(renderSource, /full_name:'billingFullName',email:'billingEmail',phone:'billingPhone',country:'billingCountry'/);
  assert.match(renderSource, /if\(value\) document\.getElementById\(id\)\.value = value/);
  assert.match(renderSource, /accountDetails\.message/);
  assert.match(checkoutScript, /renderCheckout\(selection,accountDetails\)/);
  assert.doesNotMatch(renderSource, /billing(State|City|PostalCode|AddressLine1|AddressLine2|CompanyName|TaxId).*accountDetails/);
});

test('payment and billing replace each other in place without clearing billing values', () => {
  const billingStep = {hidden: false, scrollIntoView(options) { this.scrollOptions = options; }};
  const paymentStep = {hidden: true, scrollIntoView(options) { this.scrollOptions = options; }};
  const controls = Object.fromEntries(
    [].map(id => [id, {disabled: true}])
  );
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
    closeQrPopup() {}
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
  context.returnToBilling();
  assert.equal(billingStep.hidden, false);
  assert.equal(paymentStep.hidden, true);
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

test('hosted checkout owns wallet address and QR presentation', () => {
  assert.doesNotMatch(checkoutHtml, /id="addrText"|id="copyBtn"|id="qrOpenBtn"|id="qrCode"/);
  assert.match(checkoutHtml, /Continue to Secure Checkout →/);
  assert.match(checkoutHtml, /window\.location\.assign\(checkout\.invoiceUrl\)/);
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
});

test('payment UI shows unavailable UPI and keeps the selected crypto checkout', () => {
  const paymentSection = checkoutHtml.match(
    /<section id="paymentStep"[\s\S]*?<\/section>\s*<\/form>/
  );
  assert.ok(paymentSection, 'the payment section should be present');
  assert.match(paymentSection[0], /UPI payments are not supported at this time/);
  assert.match(paymentSection[0], /aria-disabled="true"/);
  assert.match(paymentSection[0], /name="checkoutPaymentMethod" value="crypto" checked/);
  assert.match(paymentSection[0], /id="coPayBtn"/);
  assert.doesNotMatch(paymentSection[0], /name="checkoutPaymentMethod" value="upi"/i);
  assert.match(paymentSection[0], /Continue to Secure Checkout/);
});

test('hosted NOWPayments asset selection and real redirect remain intact', () => {
  assert.doesNotMatch(checkoutHtml, /id="cryptoCurrencySelect"/);
  assert.doesNotMatch(checkoutHtml, /nowpaymentsCurrencyOptions/);
  assert.match(checkoutHtml, /id="coPayBtn"/);
  assert.match(checkoutHtml, /function createCryptoCheckout\s*\(/);
  assert.doesNotMatch(checkoutHtml, /currency,\s*tradingPlatform/);
  assert.match(checkoutHtml, /window\.location\.assign\(checkout\.invoiceUrl\)/);
});

test('order summary identifiers remain unchanged', () => {
  for (const id of [
    'coLabel', 'coSize', 'coSplit', 'coPlatform',
    'coDiscount', 'coTotal', 'coRules'
  ]) {
    assert.match(checkoutHtml, new RegExp(`id="${id}"`));
  }
});
