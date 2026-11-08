const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const fundingForgeHtml = fs.readFileSync(
  path.join(__dirname, '../hosting-public/FundingForge.html'),
  'utf8'
);

function extractFunction(name, nextFunction) {
  const start = fundingForgeHtml.indexOf(`async function ${name}(`);
  assert.notEqual(start, -1, `${name} was not found`);
  const end = fundingForgeHtml.indexOf(`\n${nextFunction}`, start);
  assert.notEqual(end, -1, `${nextFunction} was not found after ${name}`);
  return fundingForgeHtml.slice(start, end);
}

test('a later Google checkout continues after the profile route has settled', async () => {
  let pendingCheckout = false;
  let profileRequests = 0;
  let dashboardOpens = 0;
  let checkoutFinishes = 0;

  const context = vm.createContext({
    API_BASE: 'https://api.example.test',
    firebaseApiHeaders: async () => ({}),
    fetch: async () => {
      profileRequests += 1;
      return {
        ok: true,
        json: async () => ({
          uid: 'test-user',
          registrationComplete: true,
          profile: {}
        })
      };
    },
    hasPendingCheckout: () => pendingCheckout,
    openDashboard: () => {
      dashboardOpens += 1;
    },
    finishPendingCheckout: async () => {
      checkoutFinishes += 1;
    },
    googleProfileRouteUid: '',
    googleProfileRoutePromise: null,
    googleProfileVerifiedUid: ''
  });

  vm.runInContext(
    `${extractFunction('routeAuthenticatedCheckout', 'function showCheckoutAuthError')}\n` +
      `${extractFunction('continueWithGoogleUser', 'async function handleGoogleSignIn')}`,
    context
  );

  const user = {
    uid: 'test-user',
    providerData: [{providerId: 'google.com'}]
  };

  await context.routeAuthenticatedCheckout(user);
  assert.equal(dashboardOpens, 1);
  assert.equal(context.googleProfileRoutePromise, null);

  pendingCheckout = true;
  await context.routeAuthenticatedCheckout(user);

  assert.equal(profileRequests, 1);
  assert.equal(checkoutFinishes, 1);
});

test('concurrent Google checkout routing shares the pending profile verification', async () => {
  let releaseProfileRequest;
  let markProfileRequestStarted;
  let profileRequests = 0;
  let checkoutFinishes = 0;
  const profileRequestStarted = new Promise(resolve => {
    markProfileRequestStarted = resolve;
  });
  const context = vm.createContext({
    API_BASE: 'https://api.example.test',
    firebaseApiHeaders: async () => ({}),
    fetch: () => {
      profileRequests += 1;
      markProfileRequestStarted();
      return new Promise(resolve => {
        releaseProfileRequest = resolve;
      });
    },
    hasPendingCheckout: () => true,
    openDashboard: () => {},
    finishPendingCheckout: async () => {
      checkoutFinishes += 1;
    },
    googleProfileRouteUid: '',
    googleProfileRoutePromise: null,
    googleProfileVerifiedUid: ''
  });

  vm.runInContext(
    `${extractFunction('routeAuthenticatedCheckout', 'function showCheckoutAuthError')}\n` +
      `${extractFunction('continueWithGoogleUser', 'async function handleGoogleSignIn')}`,
    context
  );

  const user = {
    uid: 'test-user',
    providerData: [{providerId: 'google.com'}]
  };
  const firstRoute = context.routeAuthenticatedCheckout(user);
  const secondRoute = context.routeAuthenticatedCheckout(user);
  await profileRequestStarted;

  assert.equal(profileRequests, 1);
  releaseProfileRequest({
    ok: true,
    json: async () => ({
      uid: 'test-user',
      registrationComplete: true,
      profile: {}
    })
  });
  await Promise.all([firstRoute, secondRoute]);

  assert.equal(checkoutFinishes, 1);
  assert.equal(context.googleProfileVerifiedUid, 'test-user');
});

test('incomplete Google profiles are not cached as verified', async () => {
  let profileRequests = 0;
  const context = vm.createContext({
    API_BASE: 'https://api.example.test',
    firebaseApiHeaders: async () => ({}),
    fetch: async () => {
      profileRequests += 1;
      return {
        ok: true,
        json: async () => ({
          uid: 'test-user',
          registrationComplete: false,
          profile: {}
        })
      };
    },
    isGoogleProfileComplete: () => false,
    hasPendingCheckout: () => false,
    openDashboard: () => {},
    openRegistration: () => {},
    showRegistrationForm: () => {},
    setGoogleRegistrationMode: () => {},
    googleProfileRouteUid: '',
    googleProfileRoutePromise: null,
    googleProfileVerifiedUid: ''
  });

  vm.runInContext(
    `${extractFunction('routeAuthenticatedCheckout', 'function showCheckoutAuthError')}\n` +
      `${extractFunction('continueWithGoogleUser', 'async function handleGoogleSignIn')}`,
    context
  );

  const user = {
    uid: 'test-user',
    providerData: [{providerId: 'google.com'}]
  };
  await context.routeAuthenticatedCheckout(user);
  await context.routeAuthenticatedCheckout(user);

  assert.equal(profileRequests, 2);
  assert.equal(context.googleProfileVerifiedUid, '');
});

test('email/password checkout skips Google profile routing', async () => {
  let googleProfileChecks = 0;
  let checkoutFinishes = 0;
  const context = vm.createContext({
    continueWithGoogleUser: async () => {
      googleProfileChecks += 1;
    },
    finishPendingCheckout: async () => {
      checkoutFinishes += 1;
    }
  });

  vm.runInContext(
    extractFunction('routeAuthenticatedCheckout', 'function showCheckoutAuthError'),
    context
  );
  await context.routeAuthenticatedCheckout({
    uid: 'test-user',
    providerData: [{providerId: 'password'}]
  });

  assert.equal(googleProfileChecks, 0);
  assert.equal(checkoutFinishes, 1);
});

test('logged-out Get Started opens the registration sign-in UI', async () => {
  let registrationOpens = 0;
  let registrationFormsShown = 0;
  let statusText = '';
  const context = vm.createContext({
    selectedForexModel: 'classic',
    normalizeCheckoutSelection: () => ({planKey: '1step'}),
    savePendingCheckout: () => {},
    firebaseAuth: {currentUser: null},
    firebaseAuthStateReady: Promise.resolve(),
    openRegistration: () => {
      registrationOpens += 1;
    },
    showRegistrationForm: () => {
      registrationFormsShown += 1;
    },
    routeAuthenticatedCheckout: async () => {
      assert.fail('logged-out users must not enter authenticated checkout routing');
    },
    document: {
      getElementById: () => ({
        set textContent(value) {
          statusText = value;
        }
      })
    }
  });

  vm.runInContext(
    extractFunction('openCheckout', 'async function refreshDashboard'),
    context
  );
  await context.openCheckout(10000, '1-Step', 51, '80% profit split', '1step');

  assert.equal(registrationOpens, 1);
  assert.equal(registrationFormsShown, 1);
  assert.equal(
    statusText,
    'Create an account or sign in to continue to checkout.'
  );
});

test('authenticated checkout keeps the saved selection and coupon in the integrated dialog', async () => {
  const user = {uid: 'test-user'};
  const selection = {
    market: 'forex',
    productModel: 'classic',
    productId: 'instant',
    planKey: 'instant',
    size: 25000,
    price: 190
  };
  let openedCheckout = null;
  const context = vm.createContext({
    firebaseAuthPersistenceReady: Promise.resolve(),
    requireFirebaseAuth: () => ({currentUser: user}),
    readPendingCheckout: () => selection,
    pendingCheckoutResumeKey: '',
    registrationSection: {classList: {contains: () => true}},
    closeRegistration() {},
    pendingPurchase: null,
    pendingHomepageCoupon: 'CRAZYFUNDED30',
    window: {
      CrazyFundedIntegratedCheckoutReady: Promise.resolve(),
      CrazyFundedIntegratedCheckout: {
        async open(purchase, currentUser, coupon) {
          openedCheckout = {purchase, currentUser, coupon};
          return true;
        }
      }
    }
  });

  vm.runInContext(
    extractFunction('finishPendingCheckout', 'async function copyCheckoutCoupon'),
    context
  );
  await context.finishPendingCheckout(user);

  assert.deepEqual(openedCheckout, {
    purchase: selection,
    currentUser: user,
    coupon: 'CRAZYFUNDED30'
  });
  assert.ok(context.pendingCheckoutResumeKey);
});
