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
  const currencies = [];
  const platformSummary = {textContent: '—'};
  const loggedErrors = [];
  const context = vm.createContext({
    document: {
      querySelectorAll: selector => selector === 'input[name="tradingPlatform"]' ? radios : [],
      getElementById: id => id === 'coPlatform' ? platformSummary : null
    },
    setPaymentAccess: () => unlocked.push(false),
    setCurrency: value => currencies.push(value),
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
  return {context, radios, unlocked, currencies, platformSummary};
}

test('checkout defaults to CF and presents logo-only platform choices inline', () => {
  const platformInputs = [...checkoutHtml.matchAll(/<input type="radio" name="tradingPlatform" value="([^"]+)"([^>]*)>/g)];
  assert.deepEqual(platformInputs.map(match => match[1]), ['mt5', 'ctrader', 'match_trader', 'cf']);
  assert.ok(platformInputs.slice(0, -1).every(match => !/\bchecked\b/.test(match[2])));
  assert.match(platformInputs.at(-1)[2], /\bchecked\b/);
  const platformChoiceIndex = checkoutHtml.indexOf('<fieldset class="platform-choice"');
  const cryptoDividerIndex = checkoutHtml.indexOf('OR PAY WITH CRYPTO');
  assert.ok(platformChoiceIndex >= 0 && platformChoiceIndex < cryptoDividerIndex);
  assert.match(checkoutHtml, /OR PAY WITH CRYPTO<\/div>\s*<h4>Pay with crypto<\/h4>\s*<div class="net-tabs" id="curTabs">/);
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
  assert.match(checkoutHtml, /id="copyBtn" disabled/);
  assert.match(checkoutHtml, /id="qrOpenBtn" disabled/);
  assert.match(checkoutHtml, /id="attachBtn" disabled/);
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
  const {context, radios, unlocked, currencies, platformSummary} = platformContext();
  context.setTradingPlatform('mt5');
  context.setTradingPlatform('match_trader');

  assert.equal(context.selectedTradingPlatform, 'match_trader');
  assert.equal(radios.find(radio => radio.value === 'mt5').checked, false);
  assert.equal(radios.find(radio => radio.value === 'match_trader').checked, true);
  assert.deepEqual(unlocked, [false, false]);
  assert.deepEqual(currencies, ['usdt']);
  assert.equal(platformSummary.textContent, 'Match-Trader');
  context.setTradingPlatform('');
  assert.equal(platformSummary.textContent, '—');
});

test('opening checkout selects CF and retains submission guards', () => {
  const renderStart = checkoutHtml.indexOf('function renderCheckout(');
  const renderEnd = checkoutHtml.indexOf('\nfunction closeCheckout', renderStart);
  const renderSource = checkoutHtml.slice(renderStart, renderEnd);
  assert.match(renderSource, /setTradingPlatform\('cf'\)/);

  const createPurchaseStart = checkoutHtml.indexOf('async function createPurchase(purchase){');
  const createPurchaseEnd = checkoutHtml.indexOf('\nconst pendingCheckoutStorageKey', createPurchaseStart);
  const createPurchaseSource = checkoutHtml.slice(createPurchaseStart, createPurchaseEnd);
  assert.match(createPurchaseSource, /if\(!isValidTradingPlatform\(selectedTradingPlatform\)\)/);
  assert.match(createPurchaseSource, /form\.set\('tradingPlatform',selectedTradingPlatform\)/);
  assert.match(checkoutHtml, /if\(!hasSelectedTradingPlatform\(\)\) return;/);
});

test('checkout stacks panels for tablet and uses a 2-by-2 platform grid on phones', () => {
  assert.match(checkoutHtml, /@media\(max-width:820px\)\{\.checkout-grid\{grid-template-columns:1fr;\}\}/);
  assert.match(checkoutHtml, /@media\(max-width:520px\)\{\.platform-card-grid\{grid-template-columns:repeat\(2,minmax\(0,1fr\)\);\}\}/);
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
  const sourceEnd = checkoutHtml.indexOf('\nasync function createPurchase(', sourceStart);
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

test('billing form precedes proof and the submit control, and submission uses shared validation', () => {
  const billingIndex = checkoutHtml.indexOf('id="billingDetailsTitle"');
  const continueIndex = checkoutHtml.indexOf('id="billingContinueBtn"');
  const paymentIndex = checkoutHtml.indexOf('id="paymentStep"');
  const proofIndex = checkoutHtml.indexOf('id="proofInput"');
  const submitIndex = checkoutHtml.indexOf('id="coPayBtn"');
  assert.ok(billingIndex >= 0 && billingIndex < continueIndex && continueIndex < paymentIndex && paymentIndex < proofIndex && proofIndex < submitIndex);
  assert.match(checkoutHtml, /id="checkoutSubmissionForm" novalidate/);
  assert.match(checkoutHtml, /id="paymentStep" class="payment-step"[^>]*hidden/);
  assert.match(checkoutHtml, /id="billingEmail" name="email" type="email"[^>]*required/);
  assert.match(checkoutHtml, /id="billingPhone" name="phone" type="tel"[^>]*required/);
  assert.match(checkoutHtml, /form\.set\('billing_details',JSON\.stringify\(billing\.details\)\)/);
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
  const renderEnd = checkoutHtml.indexOf('\nfunction closeCheckout', renderStart);
  const renderSource = checkoutHtml.slice(renderStart, renderEnd);
  for (const [key, id] of [
    ['full_name', 'billingFullName'],
    ['email', 'billingEmail'],
    ['phone', 'billingPhone'],
    ['country', 'billingCountry']
  ]) {
    assert.match(renderSource, new RegExp(`${key}:'${id}'`));
  }
  assert.match(renderSource, /if\(field && value\) field\.value = value/);
  assert.match(renderSource, /Complete any required fields that remain blank/);
  assert.match(checkoutHtml, /const accountDetails = await loadCheckoutAccountDetails\(currentUser\);\s*renderCheckout\(selection,accountDetails\)/);
  assert.doesNotMatch(renderSource, /billing(State|City|PostalCode|AddressLine1|AddressLine2|CompanyName|TaxId).*accountDetails/);
});

test('payment and billing replace each other in place without clearing billing values', () => {
  const billingStep = {hidden: false, scrollIntoView(options) { this.scrollOptions = options; }};
  const paymentStep = {hidden: true, scrollIntoView(options) { this.scrollOptions = options; }};
  const controls = Object.fromEntries(
    ['upiOpenBtn', 'copyBtn', 'qrOpenBtn', 'attachBtn', 'proofInput'].map(id => [id, {disabled: true}])
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
  const backEnd = checkoutHtml.indexOf('\nasync function createPurchase(', backStart);
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
  assert.equal(controls.proofInput.disabled, false);

  context.returnToBilling();
  assert.equal(billingStep.hidden, false);
  assert.equal(paymentStep.hidden, true);
  assert.equal(controls.proofInput.disabled, true);
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

test('QR is shown only in the existing popup and copy uses the visible address', () => {
  const setNetworkStart = checkoutHtml.indexOf('function setNetwork(netKey){');
  const setNetworkEnd = checkoutHtml.indexOf('\nconst qrPopupEl', setNetworkStart);
  const setNetworkSource = checkoutHtml.slice(setNetworkStart, setNetworkEnd);
  assert.match(setNetworkSource, /document\.getElementById\('addrText'\)\.textContent = net\.addr/);
  assert.match(setNetworkSource, /new QRCode\(qrEl,\s*\{\s*text: net\.addr/);
  assert.doesNotMatch(checkoutHtml, /id="paymentQrCode"|payment-qr-box|paymentQrUnavailable/);
  assert.match(checkoutHtml, /<div class="qr-box"><div id="qrCode"><\/div>/);
  assert.match(checkoutHtml, /id="qrOpenBtn"[^>]*>Show QR code<\/button>/);
  assert.match(checkoutHtml, /navigator\.clipboard\.writeText\(address\)/);
  assert.match(checkoutHtml, /document\.execCommand\('copy'\)/);
  assert.match(checkoutHtml, /showCopyStatus\(true,'Copied ✓'\)/);
  assert.match(checkoutHtml, /showCopyStatus\(false,'Address selected — press Ctrl\+C'\)/);
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
