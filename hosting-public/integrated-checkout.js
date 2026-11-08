(()=>{
const firebaseConfig = {
  apiKey: 'AIzaSyArsv-HojE9hn_3BAcJVFh5zp4XS9Dw480',
  authDomain: 'daily-funded.firebaseapp.com',
  projectId: 'daily-funded',
  storageBucket: 'daily-funded.firebasestorage.app',
  messagingSenderId: '1080360028653',
  appId: '1:1080360028653:web:9afa42197ba011c1613fe4',
  measurementId: 'G-Y7SP58FQ6H'
};
if(!firebase.apps.length) firebase.initializeApp(firebaseConfig);
const firebaseAuth = firebase.auth();
const firebaseAuthPersistenceReady = firebaseAuth.setPersistence(firebase.auth.Auth.Persistence.LOCAL);
const API_BASE = ['localhost','127.0.0.1'].includes(window.location.hostname)
  ? 'http://127.0.0.1:8080'
  : 'https://daily-funded-api.onrender.com';

const sizes = [5000,10000,25000,50000,100000,200000];
const sparkSizes = [25000,50000,100000];
const pricing = {
  '1step': {perK:6.40,min:32,discount:.20,label:'1-Step',target:'10% profit target',extra:['5% daily drawdown','10% max drawdown','3 min trading days','5 day reward cycle','80% profit split','No consistency rules']},
  '2step': {perK:5.20,min:27,discount:.40,label:'2-Step',target:'Ph 1: 6% / Ph 2: 6%',extra:['5% daily drawdown','10% max drawdown','5 min trading days','7 day reward cycle','90% profit split','No consistency rules']},
  'instant': {perK:9.80,min:49,discount:.20,prices:{25000:190,50000:349,100000:689,200000:1299},label:'Instant',target:'No profit target',extra:['5% daily drawdown','10% max drawdown','0 min trading days','Daily reward cycle','80% profit split','No consistency rules']},
  'spark_1step': {prices:{25000:39,50000:59,100000:79},label:'Spark 1-Step',target:'6% profit target',extra:['3% daily drawdown','7% trailing max drawdown','5 min trading days','70% profit split','30% consistency rule','On demand reward cycle'],productId:'MODEL_FX_SPARK_1STEP'},
  'spark_instant': {prices:{25000:59,50000:79,100000:99},label:'Spark Instant',target:null,extra:['3% daily drawdown','7% trailing max drawdown','5 min trading days','70% profit split','30% consistency rule','On demand reward cycle'],productId:'MODEL_FX_SPARK_INSTANT'}
};
const activeCouponCode = 'CRAZYFUNDED30';
const pendingCheckoutStorageKey = 'dailyFundedPendingCheckout';
const pendingCouponStorageKey = 'dailyFundedPendingCheckoutCoupon';
const tradingPlatforms = new Set(['mt5','ctrader','match_trader','cf']);
const billingFields = {
  full_name:'billingFullName',
  email:'billingEmail',
  phone:'billingPhone',
  country:'billingCountry',
  state:'billingState',
  city:'billingCity',
  postal_code:'billingPostalCode',
  address_line_1:'billingAddressLine1',
  address_line_2:'billingAddressLine2',
  company_name:'billingCompanyName',
  tax_id:'billingTaxId'
};
let pendingPurchase = null;
let pendingSubmissionId = '';
let billingPaymentUnlocked = false;
let billingValidationAttempted = false;
let checkoutBasePrice = 0;
let couponApplied = false;
let selectedTradingPlatform = '';
const integratedCheckoutDialog = document.getElementById('integratedCheckoutDialog');
const checkoutAssetPrefix = window.location.protocol === 'file:' && !window.location.pathname.toLowerCase().includes('/hosting-public/')
  ? 'hosting-public/'
  : '';
document.querySelectorAll('#checkout img[src^="./"]').forEach(image=>{
  image.src = checkoutAssetPrefix + image.getAttribute('src').slice(2);
});

function requireFirebaseAuth(){
  if(!firebaseAuth) throw new Error('Firebase Authentication is unavailable.');
  return firebaseAuth;
}

async function firebaseApiHeaders(headers={}){
  await firebaseAuthPersistenceReady;
  const user = requireFirebaseAuth().currentUser;
  if(!user) throw new Error('Sign in to continue.');
  return {...headers,Authorization:'Bearer ' + await user.getIdToken()};
}

function normalizeCheckoutSelection(model,size,planKey,productId){
  if(typeof model !== 'string' || typeof planKey !== 'string' || typeof productId !== 'string') return null;
  const plan = pricing[planKey];
  const expectedModel = planKey.startsWith('spark_') ? 'spark' : ['1step','2step','instant'].includes(planKey) ? 'classic' : '';
  const validSize = Number.isInteger(size) && (expectedModel === 'spark'
    ? sparkSizes.includes(size)
    : expectedModel === 'classic' && (sizes.includes(size) || planKey === 'instant' && size === 2500));
  if(!plan || !expectedModel || model !== expectedModel || !validSize || productId !== (plan.productId || planKey)) return null;
  let price;
  if(Number.isFinite(plan.prices?.[size])){
    price = plan.prices[size];
  }else{
    const basePrice = size === 2500 ? Math.round(size * plan.perK / 1000) : Math.max(plan.min,Math.round(size * plan.perK / 1000));
    price = Math.round(basePrice * (1 - plan.discount));
  }
  if(!Number.isFinite(price)) return null;
  return {
    market:'forex',
    size,
    label:plan.label,
    planKey,
    productModel:expectedModel,
    productId:plan.productId || planKey,
    price,
    split:plan.extra.find(rule=>rule.includes('profit split')) || ''
  };
}

function savePendingCheckout(selection){
  sessionStorage.setItem(pendingCheckoutStorageKey,JSON.stringify({
    version:1,
    market:selection.market,
    productModel:selection.productModel,
    planKey:selection.planKey,
    size:selection.size,
    productId:selection.productId
  }));
}

function getPendingSubmissionId(purchase){
  const key = 'dailyFundedPendingPurchase';
  try{
    const saved = JSON.parse(sessionStorage.getItem(key) || 'null');
    if(saved && saved.planKey === purchase.planKey && Number(saved.size) === purchase.size && saved.id) return saved.id;
  }catch(error){
    console.error('Could not read the pending payment submission:',error);
  }
  const id = crypto.randomUUID();
  try{ sessionStorage.setItem(key,JSON.stringify({id,planKey:purchase.planKey,size:purchase.size})); }
  catch(error){ console.error('Could not persist the pending payment submission:',error); }
  return id;
}

function clearPendingSubmissionId(){
  try{
    const saved = JSON.parse(sessionStorage.getItem('dailyFundedPendingPurchase') || 'null');
    if(saved && saved.id === pendingSubmissionId) sessionStorage.removeItem('dailyFundedPendingPurchase');
  }catch(error){
    console.error('Could not clear the pending payment submission:',error);
  }
  pendingSubmissionId = '';
}

function isValidTradingPlatform(platform){
  return tradingPlatforms.has(platform);
}

function hasSelectedTradingPlatform(){
  return isValidTradingPlatform(selectedTradingPlatform);
}

function setPaymentAccess(){
  const enabled = Boolean(billingPaymentUnlocked && hasSelectedTradingPlatform());
  const billingStep = document.getElementById('billingStep');
  const paymentStep = document.getElementById('paymentStep');
  if(billingStep) billingStep.hidden = enabled;
  if(paymentStep) paymentStep.hidden = !enabled;
  const paymentButton = document.getElementById('coPayBtn');
  if(paymentButton){
    paymentButton.setAttribute('aria-disabled',String(!enabled));
    paymentButton.disabled = !enabled;
  }
}

function setTradingPlatform(platform){
  selectedTradingPlatform = isValidTradingPlatform(platform) ? platform : '';
  const platformLabels = {mt5:'MetaTrader 5',ctrader:'cTrader',match_trader:'Match-Trader',cf:'CF Terminal'};
  const platformSummary = document.getElementById('coPlatform');
  if(platformSummary) platformSummary.textContent = platformLabels[selectedTradingPlatform] || '—';
  document.querySelectorAll('input[name="tradingPlatform"]').forEach(input=>{
    input.checked = input.value === selectedTradingPlatform;
    const card = input.closest('.platform-card');
    if(card) card.classList.toggle('selected',input.checked);
  });
  setPaymentAccess();
}

function showCheckoutError(message){
  document.getElementById('checkoutLoading').hidden = true;
  const panel = document.getElementById('checkoutError');
  panel.hidden = false;
  panel.querySelector('p').textContent = message;
  document.getElementById('checkout').hidden = true;
}

function formatCheckoutAmount(amount){
  const rounded = Math.round(amount * 100) / 100;
  return '$' + new Intl.NumberFormat('en-US',{
    minimumFractionDigits:Number.isInteger(rounded) ? 0 : 2,
    maximumFractionDigits:2
  }).format(rounded);
}

function updateCheckoutPrice(){
  const fullPriceCents = Math.round(checkoutBasePrice * 100);
  const totalCents = couponApplied ? Math.ceil(fullPriceCents * 70 / 10000) * 100 : fullPriceCents;
  const discount = (fullPriceCents - totalCents) / 100;
  document.getElementById('coSubtotal').textContent = formatCheckoutAmount(checkoutBasePrice);
  document.getElementById('coDiscount').textContent = '−' + formatCheckoutAmount(discount);
  document.getElementById('coSubtotalRow').style.display = couponApplied ? '' : 'none';
  document.getElementById('coDiscountRow').style.display = couponApplied ? '' : 'none';
  document.getElementById('coTotal').textContent = formatCheckoutAmount(totalCents / 100);
}

function applyCheckoutCoupon(){
  const input = document.getElementById('couponCodeInput');
  const status = document.getElementById('couponStatus');
  if(pendingPurchase.productModel !== 'classic'){
    couponApplied = false;
    input.value = '';
    status.className = 'coupon-status error';
    status.textContent = 'CRAZYFUNDED30 is only available for Classic accounts.';
    updateCheckoutPrice();
    return;
  }
  couponApplied = input.value.trim().toUpperCase() === activeCouponCode;
  status.className = 'coupon-status ' + (couponApplied ? 'success' : 'error');
  status.textContent = couponApplied ? 'Coupon applied: 30% off.' : 'Invalid coupon code.';
  updateCheckoutPrice();
}

function validateBillingDetails(focusFirstInvalid=false){
  const details = {};
  const errors = {};
  Object.entries(billingFields).forEach(([key,id])=>{
    details[key] = document.getElementById(id).value.trim();
  });
  if(!details.full_name) errors.full_name = 'Enter your full name.';
  if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(details.email) || details.email.length > 254){
    errors.email = 'Enter a valid email address.';
  }
  const phoneDigits = details.phone.replace(/\D/g,'');
  if(!/^\+?[\d\s().-]+$/.test(details.phone) || phoneDigits.length < 7 || phoneDigits.length > 15){
    errors.phone = 'Enter a valid phone number with 7 to 15 digits.';
  }
  if(!window.CrazyFundedCountryData.some(country=>country.code === details.country)){
    errors.country = 'Select a country.';
  }
  if(!details.state) errors.state = 'Enter your state or province.';
  if(!details.city) errors.city = 'Enter your city.';
  if(!details.postal_code) errors.postal_code = 'Enter your ZIP or postal code.';
  if(!details.address_line_1) errors.address_line_1 = 'Enter your address line 1.';
  const firstInvalid = Object.keys(billingFields).find(key=>errors[key]);
  Object.entries(billingFields).forEach(([key,id])=>{
    const field = document.getElementById(id);
    const message = document.getElementById(id + 'Error');
    message.textContent = errors[key] || '';
    if(errors[key]) field.setAttribute('aria-invalid','true');
    else field.removeAttribute('aria-invalid');
  });
  if(focusFirstInvalid && firstInvalid){
    const field = document.getElementById(billingFields[firstInvalid]);
    field.scrollIntoView({behavior:'smooth',block:'center'});
    field.focus({preventScroll:true});
  }
  return {valid:Object.keys(errors).length === 0,details,firstInvalid};
}

function continueToPayment(){
  billingValidationAttempted = true;
  const status = document.getElementById('billingContinueStatus');
  const billing = validateBillingDetails(true);
  if(!billing.valid){
    billingPaymentUnlocked = false;
    status.textContent = 'Complete the highlighted billing details before continuing to payment.';
    setPaymentAccess();
    return false;
  }
  if(!pendingPurchase || !normalizeCheckoutSelection(
    pendingPurchase.productModel,pendingPurchase.size,pendingPurchase.planKey,pendingPurchase.productId
  )){
    status.textContent = 'Select a valid challenge before continuing to payment.';
    return false;
  }
  if(!hasSelectedTradingPlatform()){
    status.textContent = 'Choose a trading platform before continuing to payment.';
    return false;
  }
  billingPaymentUnlocked = true;
  status.textContent = '';
  setPaymentAccess();
  document.getElementById('paymentStep').scrollIntoView({behavior:'smooth',block:'start'});
  return true;
}

function returnToBilling(){
  billingPaymentUnlocked = false;
  setPaymentAccess();
  document.getElementById('billingStep').scrollIntoView({behavior:'smooth',block:'start'});
}

async function createCryptoCheckout(purchase){
  if(!billingPaymentUnlocked) throw new Error('Complete billing details before continuing to payment.');
  if(!normalizeCheckoutSelection(purchase.productModel,purchase.size,purchase.planKey,purchase.productId)){
    throw new Error('Select a valid challenge before continuing to payment.');
  }
  if(!isValidTradingPlatform(selectedTradingPlatform)){
    throw new Error('Choose a trading platform before continuing to payment.');
  }
  const billing = validateBillingDetails();
  if(!billing.valid) throw new Error('Complete the highlighted billing details before continuing to payment.');
  const checkoutPayload = {
    productModel:purchase.productModel,
    productId:purchase.productId,
    plan:purchase.planKey,
    size:purchase.size,
    coupon:document.getElementById('couponCodeInput').value.trim(),
    submissionId:pendingSubmissionId,
    tradingPlatform:selectedTradingPlatform,
    billing_details:billing.details
  };
  let headers;
  try{ headers = await firebaseApiHeaders({Accept:'application/json'}); }
  catch(error){ throw new Error('Payment sign-in required. ' + error.message); }
  headers['Content-Type'] = 'application/json';
  let response;
  try{
    response = await fetch(API_BASE + '/api/crypto/checkout',{
      method:'POST',credentials:'same-origin',headers,body:JSON.stringify(checkoutPayload)
    });
  }catch(error){
    throw new Error('Could not connect to payment API at ' + API_BASE + ' from ' + window.location.origin + '. Check the backend and CORS. ' + error.message);
  }
  const responseText = await response.text();
  let result = {};
  try{ result = responseText ? JSON.parse(responseText) : {}; }
  catch(error){ result.error = 'Payment API returned HTTP ' + response.status + ' with a non-JSON response.'; }
  if(!response.ok){
    if(response.status === 409){
      clearPendingSubmissionId();
      pendingSubmissionId = getPendingSubmissionId(pendingPurchase);
    }
    throw new Error(result.error || 'Crypto checkout could not be created (HTTP ' + response.status + ').');
  }
  let invoiceUrl;
  try{ invoiceUrl = new URL(result.invoiceUrl); }
  catch(error){ throw new Error('Payment provider returned an invalid checkout URL.'); }
  if(invoiceUrl.protocol !== 'https:' || invoiceUrl.hostname !== 'nowpayments.io'){
    throw new Error('Payment provider returned an invalid checkout URL.');
  }
  return result;
}

function mapAccountToBillingDetails(profile,user){
  const firstName = typeof profile.firstName === 'string' ? profile.firstName.trim() : '';
  const lastName = typeof profile.lastName === 'string' ? profile.lastName.trim() : '';
  const profileName = [firstName,lastName].filter(Boolean).join(' ');
  const displayName = typeof user.displayName === 'string' ? user.displayName.trim() : '';
  return {
    full_name:profileName || displayName,
    email:typeof profile.email === 'string' ? profile.email.trim() : '',
    phone:typeof profile.phone === 'string' ? profile.phone.trim() : '',
    country:typeof profile.country === 'string' ? profile.country.trim().toUpperCase() : ''
  };
}

async function loadCheckoutAccountDetails(user){
  let profile = {};
  let profileEmail = '';
  let message = 'Account details are filled in when available. Complete any required fields that remain blank.';
  try{
    const response = await fetch(API_BASE + '/api/auth/me',{
      credentials:'same-origin',
      headers:await firebaseApiHeaders({Accept:'application/json'})
    });
    if(!response.ok) throw new Error('Profile service returned HTTP ' + response.status + '.');
    const result = await response.json();
    if(!result || result.uid !== user.uid || !result.profile || typeof result.profile !== 'object' || Array.isArray(result.profile)){
      throw new Error('Profile service returned an invalid profile.');
    }
    if(result.registrationComplete === false) return {incomplete:true};
    profile = result.profile;
    profileEmail = typeof result.email === 'string' ? result.email.trim() : '';
  }catch(error){
    console.error('Could not load account details for checkout:',error);
    message = 'We could not load your saved account details. Please complete the required billing fields below.';
  }
  const billing = mapAccountToBillingDetails(profile,user);
  if(!billing.email) billing.email = profileEmail || (typeof user.email === 'string' ? user.email.trim() : '');
  return {billing,message};
}

function renderCheckout(selection,accountDetails,couponCode=''){
  pendingPurchase = selection;
  billingPaymentUnlocked = false;
  billingValidationAttempted = false;
  const billing = accountDetails.billing || {};
  for(const [key,id] of Object.entries({
    full_name:'billingFullName',email:'billingEmail',phone:'billingPhone',country:'billingCountry'
  })){
    const value = typeof billing[key] === 'string' ? billing[key].trim() : '';
    if(value) document.getElementById(id).value = value;
  }
  document.getElementById('billingAccountInfoStatus').textContent = accountDetails.message || '';
  pendingSubmissionId = getPendingSubmissionId(pendingPurchase);
  checkoutBasePrice = selection.price;
  const classicCouponEligible = selection.productModel === 'classic';
  const couponInput = document.getElementById('couponCodeInput');
  document.querySelector('.coupon-box').hidden = !classicCouponEligible;
  couponInput.disabled = !classicCouponEligible;
  document.getElementById('applyCouponBtn').disabled = !classicCouponEligible;
  let coupon = couponCode === activeCouponCode ? couponCode : '';
  try{
    coupon = coupon || sessionStorage.getItem(pendingCouponStorageKey) || '';
    sessionStorage.removeItem(pendingCouponStorageKey);
  }catch(error){
    console.error('Could not read the pending checkout coupon:',error);
  }
  couponInput.value = classicCouponEligible && coupon === activeCouponCode ? coupon : '';
  const couponStatus = document.getElementById('couponStatus');
  couponStatus.textContent = classicCouponEligible ? '' : 'CRAZYFUNDED30 is only available for Classic accounts.';
  couponStatus.className = 'coupon-status';
  document.getElementById('coLabel').textContent = selection.planKey === 'instant' || selection.planKey === 'spark_instant'
    ? 'Instant Funding'
    : selection.label + ' Challenge';
  document.getElementById('coSize').textContent = '$' + selection.size.toLocaleString();
  document.getElementById('coSplit').textContent = selection.split || '—';
  document.getElementById('coRules').replaceChildren();
  const plan = pricing[selection.planKey];
  [...(plan.target ? [plan.target] : []),...plan.extra.filter(rule=>!rule.toLowerCase().includes('profit split'))].forEach(rule=>{
    const item = document.createElement('li');
    item.textContent = rule;
    document.getElementById('coRules').appendChild(item);
  });
  setTradingPlatform('cf');
  updateCheckoutPrice();
  if(couponInput.value) applyCheckoutCoupon();
  document.getElementById('checkoutLoading').hidden = true;
  document.getElementById('checkout').hidden = false;
}

async function openIntegratedCheckout(selection,user,couponCode=''){
  if(!integratedCheckoutDialog.open) integratedCheckoutDialog.showModal();
  document.getElementById('checkoutLoading').hidden = false;
  document.getElementById('checkoutError').hidden = true;
  document.getElementById('checkout').hidden = true;
  try{
    await firebaseAuthPersistenceReady;
    const normalized = selection && normalizeCheckoutSelection(
      selection.productModel,selection.size,selection.planKey,selection.productId
    );
    if(!normalized || normalized.price !== selection.price){
      throw new Error('The selected challenge is invalid or unavailable. Return to pricing and choose another challenge.');
    }
    const currentUser = firebaseAuth.currentUser;
    if(!user || !currentUser || user.uid !== currentUser.uid){
      throw new Error('Your sign-in session could not be restored. Return to the website and sign in again.');
    }
    const accountDetails = await loadCheckoutAccountDetails(currentUser);
    if(accountDetails.incomplete){
      throw new Error('Your account profile is incomplete. Finish registration before checkout.');
    }
    savePendingCheckout(normalized);
    renderCheckout(normalized,accountDetails,couponCode);
    return true;
  }catch(error){
    console.error('Could not initialize integrated checkout:',error);
    showCheckoutError(error.message || 'Checkout could not be loaded. Please try again.');
    return false;
  }
}

document.querySelectorAll('input[name="tradingPlatform"]').forEach(input=>{
  input.addEventListener('change',()=>{if(input.checked) setTradingPlatform(input.value);});
});
document.getElementById('applyCouponBtn').addEventListener('click',applyCheckoutCoupon);
document.getElementById('couponCodeInput').addEventListener('keydown',event=>{
  if(event.key === 'Enter'){
    event.preventDefault();
    applyCheckoutCoupon();
  }
});
document.getElementById('billingContinueBtn').addEventListener('click',continueToPayment);
document.getElementById('billingBackBtn').addEventListener('click',returnToBilling);
document.getElementById('billingCountry').insertAdjacentHTML(
  'beforeend',
  window.CrazyFundedCountryData.map(country=>`<option value="${country.code}">${country.name}</option>`).join('')
);
function closeIntegratedCheckout(){
  try{
    sessionStorage.removeItem(pendingCheckoutStorageKey);
    sessionStorage.removeItem('dailyFundedPendingPurchase');
    sessionStorage.removeItem(pendingCouponStorageKey);
  }catch(error){
    console.error('Could not clear the pending checkout selection:',error);
  }
  clearPendingSubmissionId();
  if(integratedCheckoutDialog.open) integratedCheckoutDialog.close();
  if(window.CrazyFundedCheckoutHost) window.CrazyFundedCheckoutHost.clearPendingCheckout();
}
document.getElementById('coBack').addEventListener('click',closeIntegratedCheckout);
document.getElementById('checkoutErrorBack').addEventListener('click',closeIntegratedCheckout);
integratedCheckoutDialog.addEventListener('cancel',event=>{
  event.preventDefault();
  closeIntegratedCheckout();
});
integratedCheckoutDialog.addEventListener('click',event=>{
  if(event.target === integratedCheckoutDialog) closeIntegratedCheckout();
});

const checkoutSubmissionForm = document.getElementById('checkoutSubmissionForm');
const checkoutPayButton = document.getElementById('coPayBtn');
checkoutSubmissionForm.addEventListener('input',()=>{
  if(!billingValidationAttempted) return;
  const billing = validateBillingDetails();
  const status = document.getElementById('billingContinueStatus');
  if(!billing.valid){
    if(billingPaymentUnlocked){
      billingPaymentUnlocked = false;
      setPaymentAccess();
    }
    status.textContent = 'Complete the highlighted billing details before continuing to payment.';
  }else{
    status.textContent = '';
  }
});
checkoutSubmissionForm.addEventListener('change',()=>{
  if(!billingValidationAttempted) return;
  validateBillingDetails();
});
checkoutSubmissionForm.addEventListener('submit',async event=>{
  event.preventDefault();
  if(!billingPaymentUnlocked){
    continueToPayment();
    return;
  }
  billingValidationAttempted = true;
  if(!hasSelectedTradingPlatform()){
    document.getElementById('billingContinueStatus').textContent = 'Choose a trading platform before submitting payment.';
    return;
  }
  if(!pendingPurchase || checkoutPayButton.dataset.submitting === 'true') return;
  if(!normalizeCheckoutSelection(pendingPurchase.productModel,pendingPurchase.size,pendingPurchase.planKey,pendingPurchase.productId)){
    document.getElementById('couponStatus').className = 'coupon-status error';
    document.getElementById('couponStatus').textContent = 'Select a valid challenge before submitting payment.';
    return;
  }
  const billing = validateBillingDetails(true);
  if(!billing.valid){
    billingPaymentUnlocked = false;
    document.getElementById('billingContinueStatus').textContent = 'Complete the highlighted billing details before continuing to payment.';
    setPaymentAccess();
    validateBillingDetails(true);
    return;
  }
  const couponCode = document.getElementById('couponCodeInput').value.trim();
  if(couponCode && couponCode.toUpperCase() !== activeCouponCode){
    const status = document.getElementById('couponStatus');
    status.className = 'coupon-status error';
    status.textContent = 'Invalid coupon code. Correct or remove it before submitting payment.';
    return;
  }
  if(couponCode && !couponApplied) applyCheckoutCoupon();
  if(!couponCode && couponApplied){
    couponApplied = false;
    updateCheckoutPrice();
  }
  checkoutPayButton.dataset.submitting = 'true';
  checkoutPayButton.disabled = true;
  checkoutPayButton.setAttribute('aria-disabled','true');
  try{
    const checkout = await createCryptoCheckout(pendingPurchase);
    window.location.assign(checkout.invoiceUrl);
  }catch(error){
    const status = document.getElementById('couponStatus');
    status.className = 'coupon-status error';
    status.textContent = error.message;
  }finally{
    delete checkoutPayButton.dataset.submitting;
    checkoutPayButton.disabled = !(billingPaymentUnlocked && hasSelectedTradingPlatform());
    checkoutPayButton.setAttribute('aria-disabled',String(checkoutPayButton.disabled));
  }
});

window.CrazyFundedIntegratedCheckout = {
  open:openIntegratedCheckout,
  close:closeIntegratedCheckout,
  normalizeCheckoutSelection,
  validateBillingDetails,
  applyCheckoutCoupon,
  continueToPayment
};
})();
