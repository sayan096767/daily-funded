import hashlib
import hmac
import json
import threading
import unittest
import uuid
from copy import deepcopy
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from types import SimpleNamespace
from urllib.error import HTTPError
from unittest.mock import MagicMock, call, patch

import app as app_module
from app import app
from test_admin_auth import PurchaseApiTests


class MemorySnapshot:
    def __init__(self, data):
        self.exists = data is not None
        self._data = deepcopy(data)

    def to_dict(self):
        return deepcopy(self._data)


class MemoryDocument:
    def __init__(self, document_id):
        self.id = document_id
        self.data = None

    def get(self, transaction=None):
        with transaction.lock if transaction else threading.RLock():
            return MemorySnapshot(self.data)


class MemoryCollection:
    def __init__(self):
        self.documents = {}

    def document(self, document_id):
        return self.documents.setdefault(document_id, MemoryDocument(document_id))


class MemoryUserDocument(MemoryDocument):
    def __init__(self, document_id):
        super().__init__(document_id)
        self.collections = {}

    def collection(self, name):
        return self.collections.setdefault(name, MemoryCollection())


class MemoryTransaction:
    def __init__(self):
        self.lock = threading.RLock()

    def _values(self, values):
        return {
            key: datetime.now(timezone.utc) if value is app_module.firestore.SERVER_TIMESTAMP else deepcopy(value)
            for key, value in values.items()
        }

    def update(self, document, values):
        with self.lock:
            if document.data is None:
                raise AssertionError("Cannot update a missing document.")
            document.data.update(self._values(values))

    def set(self, document, values):
        with self.lock:
            document.data = self._values(values)

    def create(self, document, values):
        with self.lock:
            if document.data is not None:
                raise AssertionError("Cannot create an existing document.")
            document.data = self._values(values)


class MemoryFirestore:
    def __init__(self):
        self.collections = {}
        self._transaction = MemoryTransaction()

    def collection(self, name):
        return self.collections.setdefault(name, MemoryCollection())

    def transaction(self):
        return self._transaction


class NowPaymentsTests(unittest.TestCase):
    submission_id = "00000000-0000-4000-8000-000000000456"
    billing_details = PurchaseApiTests.default_billing_details
    config = {
        "api_key": "test-api-key",
        "ipn_secret": "test-ipn-secret",
        "callback_url": "https://api.example.test/api/payments/nowpayments/ipn",
        "return_url": "https://daily-funded.web.app/?payment=return",
    }

    def setUp(self):
        self.client = app.test_client()

    def authenticated_post(
        self, path, payload=None, claims=None, client=None, method="POST", **_ignored
    ):
        with patch("app.firebase_auth.verify_id_token", return_value=claims or {
            "uid": "verified-user-a", "email": "a@example.com", "name": "User A",
        }):
            with patch("app.get_firebase_app"):
                return (client or self.client).open(
                    path,
                    method=method,
                    json=payload,
                    headers={"Authorization": "Bearer test-token"},
                )

    def checkout_payload(self, **overrides):
        payload = {
            "plan": "1step",
            "size": 5000,
            "productModel": "classic",
            "productId": "1step",
            "coupon": "CRAZYFUNDED30",
            "submissionId": self.submission_id,
            "currency": "ignored-legacy-client-value",
            "tradingPlatform": "mt5",
            "billing_details": self.billing_details,
            "price": 0.01,
            "totalCents": 1,
            "discountPercent": 99,
        }
        payload.update(overrides)
        return payload

    def test_checkout_uses_authoritative_price_and_never_creates_account_or_calls_payment(self):
        purchase_ref = MagicMock()
        purchase_ref.get.return_value.exists = False
        saved_purchase = {}
        purchase_ref.create.side_effect = lambda values: saved_purchase.update(values)
        purchase_ref.update.side_effect = lambda values: saved_purchase.update(values)
        user_ref = MagicMock()
        user_ref.collection.return_value.document.return_value = purchase_ref
        user_ref.get.return_value.to_dict.return_value = {"email": "a@example.com"}
        database = MagicMock()
        database.collection.return_value.document.return_value = user_ref

        with patch("app.get_firestore", return_value=database):
            with patch("app.nowpayments_configuration", return_value=self.config):
                with patch("app.nowpayments_api_request", return_value={
                    "id": "invoice-123",
                    "invoice_url": "https://nowpayments.io/payment/?iid=invoice-123",
                }) as provider_request:
                    response = self.authenticated_post(
                        "/api/crypto/checkout", self.checkout_payload()
                    )

        self.assertEqual(response.status_code, 201)
        self.assertEqual(response.get_json()["totalCents"], 2240)
        self.assertEqual(saved_purchase["listPriceCents"], 3200)
        self.assertEqual(saved_purchase["discountCents"], 960)
        self.assertEqual(saved_purchase["totalCents"], 2240)
        self.assertNotIn("paymentCurrency", saved_purchase)
        self.assertNotIn("paymentNetwork", saved_purchase)
        self.assertEqual(saved_purchase["paymentProvider"], "nowpayments")
        self.assertEqual(saved_purchase["invoiceId"], "invoice-123")
        invoice_payload = provider_request.call_args.args[3]
        self.assertEqual(invoice_payload["price_amount"], 22.4)
        self.assertEqual(invoice_payload["price_currency"], "usd")
        self.assertNotIn("pay_currency", invoice_payload)
        self.assertNotIn("price", invoice_payload)
        self.assertEqual(user_ref.collection.call_args_list, [call("purchases")])
        self.assertNotIn("paymentProof", saved_purchase)

    def test_checkout_reuses_an_existing_invoice_instead_of_creating_another(self):
        purchase_id = str(uuid.uuid5(
            uuid.NAMESPACE_URL,
            f"daily-funded:verified-user-a:{self.submission_id}",
        ))
        existing_purchase = {
            "ownerUid": "verified-user-a",
            "planKey": "1step",
            "accountSize": 5000,
            "couponCode": "CRAZYFUNDED30",
            "paymentCurrency": "usdttrc20",
            "paymentNetwork": "tron",
            "tradingPlatform": "mt5",
            "billingDetails": self.billing_details,
            "paymentProvider": "nowpayments",
            "invoiceUrl": "https://nowpayments.io/payment/?iid=invoice-existing",
            "invoiceId": "invoice-existing",
            "totalCents": 2240,
            "status": "pending",
            "paymentStatus": "waiting",
        }
        purchase_ref = MagicMock()
        purchase_ref.get.return_value.exists = True
        purchase_ref.get.return_value.to_dict.return_value = existing_purchase
        user_ref = MagicMock()
        user_ref.collection.return_value.document.return_value = purchase_ref
        database = MagicMock()
        database.collection.return_value.document.return_value = user_ref

        with patch("app.get_firestore", return_value=database):
            with patch("app.nowpayments_api_request") as provider_request:
                response = self.authenticated_post(
                    "/api/crypto/checkout", self.checkout_payload()
                )

        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.get_json()["idempotentReplay"])
        self.assertEqual(response.get_json()["purchaseId"], purchase_id)
        provider_request.assert_not_called()
        purchase_ref.create.assert_not_called()

    def test_checkout_configuration_failure_returns_unavailable_without_invoice_call(self):
        purchase_ref = MagicMock()
        purchase_ref.get.return_value.exists = False
        user_ref = MagicMock()
        user_ref.collection.return_value.document.return_value = purchase_ref
        database = MagicMock()
        database.collection.return_value.document.return_value = user_ref

        with patch("app.get_firestore", return_value=database):
            with patch("app.nowpayments_configuration", side_effect=RuntimeError("invalid config")):
                with patch("app.nowpayments_api_request") as provider_request:
                    response = self.authenticated_post(
                        "/api/crypto/checkout", self.checkout_payload()
                    )

        self.assertEqual(response.status_code, 503)
        self.assertEqual(
            response.get_json()["error"],
            "Crypto checkout is temporarily unavailable.",
        )
        provider_request.assert_not_called()
        purchase_ref.create.assert_not_called()

    def test_only_explicit_provider_client_errors_are_safe_to_retry(self):
        for status_code, expected_retryability in ((400, True), (500, False)):
            with self.subTest(status_code=status_code):
                provider_error = HTTPError(
                    "https://api.nowpayments.io/v1/invoice",
                    status_code,
                    "provider response",
                    hdrs=None,
                    fp=None,
                )
                with patch("app.urlopen", side_effect=provider_error):
                    with self.assertRaises(app_module.NOWPaymentsRequestError) as raised:
                        app_module.nowpayments_api_request(
                            "POST", "/invoice", "test-api-key", {"price_amount": 10}
                        )
                self.assertEqual(raised.exception.safe_to_retry, expected_retryability)

    def test_failed_invoice_attempt_can_be_retried_and_replayed_safely(self):
        purchase_ref = MagicMock()
        purchase_ref.get.return_value.exists = False
        saved_purchase = {}
        purchase_ref.create.side_effect = lambda values: saved_purchase.update(values)
        purchase_ref.update.side_effect = lambda values: saved_purchase.update(values)
        user_ref = MagicMock()
        user_ref.collection.return_value.document.return_value = purchase_ref
        user_ref.get.return_value.to_dict.return_value = {"email": "a@example.com"}
        database = MagicMock()
        database.collection.return_value.document.return_value = user_ref
        transaction = MagicMock()
        transaction.update.side_effect = lambda _reference, values: saved_purchase.update(values)
        database.transaction.return_value = transaction

        with patch("app.get_firestore", return_value=database):
            with patch("app.nowpayments_configuration", return_value=self.config):
                with patch("app.nowpayments_api_request", side_effect=[
                    app_module.NOWPaymentsRequestError(
                        "provider rejected the request", safe_to_retry=True
                    ),
                    {
                        "id": "invoice-retry",
                        "invoice_url": "https://nowpayments.io/payment/?iid=invoice-retry",
                    },
                ]) as provider_request:
                    with patch("app.firestore.transactional", side_effect=lambda function: function):
                        failed = self.authenticated_post(
                            "/api/crypto/checkout", self.checkout_payload()
                        )
                        self.assertEqual(failed.status_code, 503)
                        self.assertEqual(saved_purchase["invoiceCreationStatus"], "failed")
                        self.assertEqual(
                            saved_purchase["invoiceCreationErrorType"],
                            "NOWPaymentsRequestError",
                        )
                        self.assertEqual(saved_purchase["paymentStatus"], "waiting")
                        self.assertNotIn("mt5Password", saved_purchase)

                        purchase_ref.get.return_value.exists = True
                        purchase_ref.get.return_value.to_dict.return_value = saved_purchase
                        retried = self.authenticated_post(
                            "/api/crypto/checkout", self.checkout_payload()
                        )
                        self.assertEqual(retried.status_code, 201)
                        self.assertEqual(
                            retried.get_json()["invoiceUrl"],
                            "https://nowpayments.io/payment/?iid=invoice-retry",
                        )
                        self.assertEqual(saved_purchase["invoiceCreationStatus"], "created")
                        self.assertIsNone(saved_purchase["invoiceCreationErrorType"])

                        replayed = self.authenticated_post(
                            "/api/crypto/checkout", self.checkout_payload()
                        )
        self.assertEqual(replayed.status_code, 200)
        self.assertTrue(replayed.get_json()["idempotentReplay"])
        self.assertEqual(provider_request.call_count, 2)
        purchase_ref.create.assert_called_once()

    def test_concurrent_invoice_retries_claim_only_one_provider_request(self):
        state_lock = threading.RLock()
        provider_started = threading.Event()
        release_provider = threading.Event()
        purchase_data = {
            "ownerUid": "verified-user-a",
            "planKey": "1step",
            "accountSize": 5000,
            "couponCode": "CRAZYFUNDED30",
            "tradingPlatform": "mt5",
            "billingDetails": self.billing_details,
            "paymentProvider": "nowpayments",
            "totalCents": 2240,
            "status": "pending",
            "paymentStatus": "waiting",
            "invoiceCreationStatus": "failed",
        }

        class Snapshot:
            exists = True

            def to_dict(self):
                with state_lock:
                    return dict(purchase_data)

        purchase_ref = MagicMock()
        purchase_ref.get.side_effect = lambda transaction=None: Snapshot()
        purchase_ref.create.side_effect = AssertionError("retry must not create another purchase")
        purchase_ref.update.side_effect = lambda values: purchase_data.update(values)
        user_ref = MagicMock()
        user_ref.collection.return_value.document.return_value = purchase_ref
        user_ref.get.return_value.to_dict.return_value = {"email": "a@example.com"}
        database = MagicMock()
        database.collection.return_value.document.return_value = user_ref
        transaction = MagicMock()
        transaction.update.side_effect = lambda _reference, values: purchase_data.update(values)
        database.transaction.return_value = transaction

        def transactional(function):
            def run(current_transaction):
                with state_lock:
                    return function(current_transaction)
            return run

        def provider_request(*_args):
            provider_started.set()
            if not release_provider.wait(timeout=10):
                raise TimeoutError("test provider gate timed out")
            return {
                "id": "invoice-concurrent",
                "invoice_url": "https://nowpayments.io/payment/?iid=invoice-concurrent",
            }

        def post_checkout():
            return self.authenticated_post(
                "/api/crypto/checkout",
                self.checkout_payload(),
                client=app.test_client(),
            )

        with patch("app.get_firestore", return_value=database):
            with patch("app.nowpayments_configuration", return_value=self.config):
                with patch("app.nowpayments_api_request", side_effect=provider_request) as provider:
                    with patch("app.firestore.transactional", side_effect=transactional):
                        with ThreadPoolExecutor(max_workers=2) as executor:
                            first_future = executor.submit(post_checkout)
                            self.assertTrue(provider_started.wait(timeout=10))
                            second = post_checkout()
                            release_provider.set()
                            first = first_future.result(timeout=10)

        self.assertEqual(first.status_code, 201)
        self.assertEqual(second.status_code, 503)
        self.assertEqual(purchase_data["invoiceCreationStatus"], "created")
        self.assertEqual(
            purchase_data["invoiceUrl"],
            "https://nowpayments.io/payment/?iid=invoice-concurrent",
        )
        self.assertEqual(provider.call_count, 1)
        purchase_ref.create.assert_not_called()

    def test_ambiguous_provider_failure_requires_reconciliation_before_retry(self):
        purchase_ref = MagicMock()
        purchase_ref.get.return_value.exists = False
        saved_purchase = {}
        purchase_ref.create.side_effect = lambda values: saved_purchase.update(values)
        purchase_ref.update.side_effect = lambda values: saved_purchase.update(values)
        user_ref = MagicMock()
        user_ref.collection.return_value.document.return_value = purchase_ref
        user_ref.get.return_value.to_dict.return_value = {"email": "a@example.com"}
        database = MagicMock()
        database.collection.return_value.document.return_value = user_ref

        with patch("app.get_firestore", return_value=database):
            with patch("app.nowpayments_configuration", return_value=self.config):
                with patch(
                    "app.nowpayments_api_request",
                    side_effect=RuntimeError("provider response timed out"),
                ) as provider_request:
                    failed = self.authenticated_post(
                        "/api/crypto/checkout", self.checkout_payload()
                    )
                    self.assertEqual(failed.status_code, 503)
                    self.assertEqual(
                        saved_purchase["invoiceCreationStatus"],
                        "reconciliation_required",
                    )

                    purchase_ref.get.return_value.exists = True
                    purchase_ref.get.return_value.to_dict.return_value = saved_purchase
                    retry = self.authenticated_post(
                        "/api/crypto/checkout", self.checkout_payload()
                    )

        self.assertEqual(retry.status_code, 503)
        self.assertIn("contact support", retry.get_json()["error"].lower())
        self.assertEqual(provider_request.call_count, 1)
        purchase_ref.create.assert_called_once()

    def test_created_invoice_is_saved_for_replay_if_first_firestore_update_fails(self):
        purchase_ref = MagicMock()
        purchase_ref.get.return_value.exists = False
        saved_purchase = {}
        purchase_ref.create.side_effect = lambda values: saved_purchase.update(values)
        update_attempts = []

        def persist_invoice(values):
            update_attempts.append(values)
            if len(update_attempts) == 1:
                raise RuntimeError("temporary Firestore write failure")
            saved_purchase.update(values)

        purchase_ref.update.side_effect = persist_invoice
        user_ref = MagicMock()
        user_ref.collection.return_value.document.return_value = purchase_ref
        user_ref.get.return_value.to_dict.return_value = {"email": "a@example.com"}
        database = MagicMock()
        database.collection.return_value.document.return_value = user_ref

        with patch("app.get_firestore", return_value=database):
            with patch("app.nowpayments_configuration", return_value=self.config):
                with patch("app.nowpayments_api_request", return_value={
                    "id": "invoice-persist",
                    "invoice_url": "https://nowpayments.io/payment/?iid=invoice-persist",
                }) as provider_request:
                    first = self.authenticated_post(
                        "/api/crypto/checkout", self.checkout_payload()
                    )
                    self.assertEqual(first.status_code, 503)
                    self.assertEqual(saved_purchase["invoiceUrl"], "https://nowpayments.io/payment/?iid=invoice-persist")
                    purchase_ref.get.return_value.exists = True
                    purchase_ref.get.return_value.to_dict.return_value = saved_purchase
                    replay = self.authenticated_post(
                        "/api/crypto/checkout", self.checkout_payload()
                    )

        self.assertEqual(replay.status_code, 200)
        self.assertTrue(replay.get_json()["idempotentReplay"])
        self.assertEqual(provider_request.call_count, 1)
        self.assertEqual(len(update_attempts), 2)

    def test_classic_instant_prices_and_coupon_totals_remain_exact_to_the_cent(self):
        expected = (
            (2500, 20, 2000, 600, 1400),
            (5000, 39, 3900, 1170, 2730),
            (10000, 78, 7800, 2340, 5460),
            (25000, 190, 19000, 5700, 13300),
            (50000, 349, 34900, 10470, 24430),
            (100000, 689, 68900, 20670, 48230),
            (200000, 1299, 129900, 38970, 90930),
        )
        instant = app_module.CATALOG["instant"]
        self.assertEqual(tuple(instant["prices"].values()), tuple(row[1] for row in expected))
        for size, price, list_price, discount, total in expected:
            with self.subTest(size=size):
                result = app_module.calculate_purchase_amount(
                    "instant", size, "CRAZYFUNDED30"
                )
                self.assertEqual(result[:3], (list_price, discount, total))

    def test_checkout_rejects_invalid_coupon_before_provider_call(self):
        with patch("app.get_firestore") as firestore_client:
            with patch("app.nowpayments_api_request") as provider_request:
                response = self.authenticated_post(
                    "/api/crypto/checkout",
                    self.checkout_payload(coupon="NOT-A-COUPON"),
                )
        self.assertEqual(response.status_code, 400)
        self.assertIn("Invalid coupon", response.get_json()["error"])
        firestore_client.assert_not_called()
        provider_request.assert_not_called()

    def test_configured_coupons_apply_to_spark_and_funded100_is_exactly_free(self):
        for plan_key, plan in app_module.CATALOG.items():
            for size, price in plan["prices"].items():
                with self.subTest(plan=plan_key, size=size):
                    list_price = price * 100
                    discount = (list_price * 30 + 50) // 100
                    self.assertEqual(
                        app_module.calculate_purchase_amount(
                            plan_key, size, "CRAZYFUNDED30"
                        )[:3],
                        (list_price, discount, list_price - discount),
                    )
                    self.assertEqual(
                        app_module.calculate_purchase_amount(
                            plan_key, size, "FUNDED100"
                        )[:3],
                        (list_price, list_price, 0),
                    )

        spark_30 = app_module.calculate_purchase_amount(
            "spark_1step", 25000, "CRAZYFUNDED30"
        )
        self.assertEqual(spark_30, (3900, 1170, 2730, "CRAZYFUNDED30"))
        full_discount = app_module.calculate_purchase_amount(
            "spark_1step", 25000, "FUNDED100"
        )
        self.assertEqual(full_discount, (3900, 3900, 0, "FUNDED100"))
        self.assertTrue(app_module.purchase_payment_allows_auto_provisioning({
            "status": "pending",
            "paymentProvider": "coupon",
            "paymentMethod": "coupon",
            "paymentStatus": "not_required",
            "couponCode": "FUNDED100",
            "couponRedemptionVerified": True,
            "listPriceCents": 3900,
            "discountCents": 3900,
            "totalCents": 0,
        }))
        self.assertFalse(app_module.purchase_payment_allows_auto_provisioning({
            "paymentProvider": "coupon",
            "paymentMethod": "coupon",
            "paymentStatus": "not_required",
            "couponCode": "FUNDED100",
            "couponRedemptionVerified": False,
            "listPriceCents": 3900,
            "discountCents": 3900,
            "totalCents": 0,
        }))

    def test_funded100_checkout_skips_payment_and_redeems_once_per_user(self):
        database = MemoryFirestore()
        user_ref = MemoryUserDocument("verified-user-a")
        database.collection("users").documents[user_ref.id] = user_ref
        free_payload = self.checkout_payload(
            plan="spark_1step",
            size=25000,
            productModel="spark",
            productId="MODEL_FX_SPARK_1STEP",
            coupon="FUNDED100",
        )
        with patch("app.get_firestore", return_value=database):
            with patch(
                "app.nowpayments_configuration",
                side_effect=AssertionError("free checkout must not configure NOWPayments"),
            ) as payment_config:
                with patch("app.nowpayments_api_request") as provider_request:
                    with patch(
                        "app.provision_verified_purchase",
                        return_value={"state": "provisioned", "accountId": "ACC_TEST"},
                    ) as provisioner:
                        with patch(
                            "app.firestore.transactional",
                            side_effect=lambda function: lambda transaction: function(transaction),
                        ):
                            response = self.authenticated_post(
                                "/api/crypto/checkout", free_payload
                            )
                            purchase_id = response.get_json()["purchaseId"]
                            saved_purchase = user_ref.collection("purchases").document(
                                purchase_id
                            ).data
                            redemption = user_ref.collection(
                                "couponRedemptions"
                            ).document("FUNDED100").data

                            replayed = self.authenticated_post(
                                "/api/crypto/checkout", free_payload
                            )
                            retry_payload = dict(free_payload)
                            retry_payload["submissionId"] = "00000000-0000-4000-8000-000000000457"
                            reused = self.authenticated_post(
                                "/api/crypto/checkout", retry_payload
                            )

        self.assertEqual(response.status_code, 201)
        self.assertFalse(response.get_json()["requiresPayment"])
        self.assertEqual(response.get_json()["provisioningStatus"], "provisioned")
        self.assertNotIn("invoiceUrl", response.get_json())
        self.assertEqual(saved_purchase["totalCents"], 0)
        self.assertEqual(saved_purchase["paymentProvider"], "coupon")
        self.assertTrue(saved_purchase["couponRedemptionVerified"])
        self.assertEqual(redemption["purchaseId"], purchase_id)
        self.assertEqual(replayed.status_code, 200)
        self.assertTrue(replayed.get_json()["idempotentReplay"])
        self.assertEqual(reused.status_code, 409)
        self.assertIn("already been used", reused.get_json()["error"])
        payment_config.assert_not_called()
        provider_request.assert_not_called()
        self.assertEqual(provisioner.call_count, 2)

    def test_coupon_validation_returns_server_price_and_rejects_used_full_coupon(self):
        database = MemoryFirestore()
        user_ref = MemoryUserDocument("verified-user-a")
        database.collection("users").documents[user_ref.id] = user_ref
        payload = {
            "plan": "spark_1step",
            "size": 25000,
            "productModel": "spark",
            "productId": "MODEL_FX_SPARK_1STEP",
            "coupon": "CRAZYFUNDED30",
        }
        with patch("app.get_firestore", return_value=database):
            response = self.authenticated_post(
                "/api/crypto/coupon/validate", payload
            )
            full_payload = dict(payload, coupon="FUNDED100")
            full_discount = self.authenticated_post(
                "/api/crypto/coupon/validate", full_payload
            )
            user_ref.collection("couponRedemptions").document("FUNDED100").data = {
                "purchaseId": "prior-purchase",
            }
            used = self.authenticated_post(
                "/api/crypto/coupon/validate", full_payload
            )
            replay_submission = self.submission_id
            replay_purchase_id = str(uuid.uuid5(
                uuid.NAMESPACE_URL,
                f"daily-funded:verified-user-a:{replay_submission}",
            ))
            user_ref.collection("purchases").document(replay_purchase_id).data = {
                "ownerUid": "verified-user-a",
                "planKey": "spark_1step",
                "accountSize": 25000,
                "couponCode": "FUNDED100",
                "paymentProvider": "coupon",
                "paymentMethod": "coupon",
                "paymentStatus": "not_required",
                "couponRedemptionVerified": True,
                "listPriceCents": 3900,
                "discountCents": 3900,
                "totalCents": 0,
                "status": "approved",
            }
            replay = self.authenticated_post(
                "/api/crypto/coupon/validate",
                dict(full_payload, submissionId=replay_submission),
            )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json()["discountPercent"], 30)
        self.assertEqual(response.get_json()["totalCents"], 2730)
        self.assertEqual(full_discount.status_code, 200)
        self.assertEqual(full_discount.get_json()["totalCents"], 0)
        self.assertEqual(used.status_code, 409)
        self.assertEqual(replay.status_code, 200)

    def test_checkout_rejects_invalid_product_and_size_before_provider_call(self):
        for overrides in (
            {"plan": "unknown"},
            {"size": 2500},
        ):
            with self.subTest(overrides=overrides):
                with patch("app.get_firestore") as firestore_client:
                    with patch("app.nowpayments_api_request") as provider_request:
                        response = self.authenticated_post(
                            "/api/crypto/checkout",
                            self.checkout_payload(**overrides),
                        )
                self.assertEqual(response.status_code, 400)
                self.assertIn("challenge is not available", response.get_json()["error"])
                firestore_client.assert_not_called()
                provider_request.assert_not_called()

    def ipn_payload(self, **overrides):
        payload = {
            "payment_id": "payment-456",
            "payment_status": "finished",
            "price_amount": 22.4,
            "price_currency": "usd",
            "pay_currency": "usdttrc20",
            "order_id": "00000000-0000-4000-8000-000000000789",
            "invoice_id": "invoice-789",
        }
        payload.update(overrides)
        return payload

    def ipn_signature(self, payload):
        body = json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
        return hmac.new(
            self.config["ipn_secret"].encode("utf-8"),
            body.encode("utf-8"),
            hashlib.sha512,
        ).hexdigest()

    def call_ipn(self, payload, purchase_data, provider_payment=None, account_data=None):
        purchase_ref = MagicMock()
        current_snapshot = MagicMock()
        current_snapshot.to_dict.return_value = purchase_data
        purchase_ref.get.return_value = current_snapshot
        purchase = MagicMock()
        purchase.reference = purchase_ref
        purchase.to_dict.return_value = purchase_data
        database = MagicMock()
        transaction = MagicMock()
        database.transaction.return_value = transaction
        account_snapshot = MagicMock()
        account_snapshot.exists = account_data is not None
        account_snapshot.to_dict.return_value = account_data or {}
        account_ref = MagicMock()
        account_ref.get.return_value = account_snapshot
        user_ref = MagicMock()
        user_ref.collection.return_value.document.return_value = account_ref
        provider_payment = provider_payment or {
            "payment_id": payload["payment_id"],
            "order_id": payload["order_id"],
            "invoice_id": payload["invoice_id"],
            "payment_status": payload["payment_status"],
            "price_amount": payload["price_amount"],
            "price_currency": payload["price_currency"],
            "pay_currency": payload["pay_currency"],
            "pay_amount": "22.4",
            "actually_paid": "22.4",
        }
        self.provisioner = MagicMock(return_value={
            "state": "provisioned",
            "accountId": "ACC_11111111-1111-4111-8111-111111111111",
            "tradingStatus": "active",
        })
        with patch("app.nowpayments_configuration", return_value=self.config):
            with patch("app.find_purchase_document", return_value=purchase):
                with patch("app.get_firestore", return_value=database):
                    with patch("app.nowpayments_api_request", return_value=provider_payment) as provider_request:
                        with patch("app.user_document", return_value=user_ref):
                            with patch("app.provision_verified_purchase", self.provisioner):
                                with patch("app.firestore.transactional", side_effect=lambda function: function):
                                    response = self.client.post(
                                        "/api/payments/nowpayments/ipn",
                                        json=payload,
                                        headers={"x-nowpayments-sig": self.ipn_signature(payload)},
                                    )
        return response, transaction, provider_request

    def purchase_data(self, **overrides):
        data = {
            "purchaseId": "00000000-0000-4000-8000-000000000789",
            "accountId": "00000000-0000-4000-8000-000000000789",
            "ownerUid": "verified-user-a",
            "planKey": "1step",
            "accountSize": 5000,
            "totalCents": 2240,
            "paymentProvider": "nowpayments",
            "invoiceId": "invoice-789",
            "status": "pending",
            "paymentStatus": "waiting",
        }
        data.update(overrides)
        return data

    def test_ipn_requires_signature_and_rejects_amount_mismatch(self):
        with patch("app.nowpayments_configuration", return_value=self.config):
            with patch("app.get_firestore") as firestore_client:
                response = self.client.post(
                    "/api/payments/nowpayments/ipn",
                    json=self.ipn_payload(),
                )
        self.assertEqual(response.status_code, 401)
        firestore_client.assert_not_called()

        with patch("app.nowpayments_configuration", return_value=self.config):
            with patch("app.get_firestore") as firestore_client:
                response = self.client.post(
                    "/api/payments/nowpayments/ipn",
                    json=self.ipn_payload(),
                    headers={"x-nowpayments-sig": "invalid"},
                )
        self.assertEqual(response.status_code, 401)
        firestore_client.assert_not_called()

        payload = self.ipn_payload(price_amount=20)
        response, _transaction, provider_request = self.call_ipn(
            payload, self.purchase_data()
        )
        self.assertEqual(response.status_code, 400)
        self.assertIn("amount or currency", response.get_json()["error"])
        provider_request.assert_not_called()

    def test_ipn_rejects_provider_currency_or_order_mismatch(self):
        payload = self.ipn_payload()
        mismatched_provider = {
            "payment_id": payload["payment_id"],
            "order_id": "00000000-0000-4000-8000-000000000999",
            "payment_status": payload["payment_status"],
            "price_amount": payload["price_amount"],
            "price_currency": payload["price_currency"],
            "pay_currency": "btc",
        }
        response, transaction, _provider_request = self.call_ipn(
            payload, self.purchase_data(), mismatched_provider
        )

        self.assertEqual(response.status_code, 400)
        transaction.update.assert_not_called()

    def test_ipn_rejects_invalid_currency_before_provider_lookup(self):
        payload = self.ipn_payload(pay_currency="USDT TRC20")
        response, transaction, provider_request = self.call_ipn(
            payload, self.purchase_data()
        )

        self.assertEqual(response.status_code, 400)
        self.assertIn("amount or currency", response.get_json()["error"])
        transaction.update.assert_not_called()
        provider_request.assert_not_called()

    def test_finished_ipn_is_idempotent_after_provisioning(self):
        payload = self.ipn_payload()
        existing_purchase = self.purchase_data(
            status="approved",
            paymentCurrency="usdttrc20",
            paymentStatus="finished",
            providerPaymentId=payload["payment_id"],
            settlementStatus="exact",
            settlementVerified=True,
            manualReviewRequired=False,
            provisioningStatus="provisioned",
        )
        existing_account = {
            "ownerUid": existing_purchase["ownerUid"],
            "purchaseId": existing_purchase["purchaseId"],
            "accountId": existing_purchase["accountId"],
            "planKey": existing_purchase["planKey"],
            "accountSize": existing_purchase["accountSize"],
            "status": "active",
            "tradingEnabled": True,
            "tradingEngineAccountId": "ACC_11111111-1111-4111-8111-111111111111",
        }
        response, transaction, _provider_request = self.call_ipn(
            payload, existing_purchase, account_data=existing_account
        )

        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.get_json()["duplicate"])
        transaction.update.assert_not_called()
        self.provisioner.assert_not_called()
        self.assertFalse(app_module.purchase_payment_allows_approval({
            "paymentProvider": "nowpayments",
            "paymentStatus": "waiting",
        }))
        self.assertFalse(app_module.purchase_payment_allows_approval({
            "paymentProvider": "nowpayments",
            "paymentStatus": "finished",
        }))
        self.assertTrue(app_module.purchase_payment_allows_approval({
            "paymentProvider": "nowpayments",
            "paymentStatus": "finished",
            "settlementStatus": "exact",
            "settlementVerified": True,
        }))

    def test_valid_finished_ipn_marks_payment_verified_and_starts_automatic_provisioning(self):
        payload = self.ipn_payload()
        response, transaction, _provider_request = self.call_ipn(
            payload, self.purchase_data()
        )

        self.assertEqual(response.status_code, 200)
        self.assertFalse(response.get_json()["duplicate"])
        updates = transaction.update.call_args.args[1]
        self.assertEqual(updates["paymentStatus"], "finished")
        self.assertEqual(updates["paymentCurrency"], "usdttrc20")
        self.assertEqual(updates["providerPaymentId"], payload["payment_id"])
        self.assertEqual(updates["settlementStatus"], "exact")
        self.assertTrue(updates["settlementVerified"])
        self.assertEqual(updates["settlementPayAmount"], "22.4")
        self.assertEqual(updates["settlementActuallyPaid"], "22.4")
        self.assertEqual(updates["status"], "approved")
        self.assertEqual(updates["approvalSource"], "automatic_nowpayments")
        self.assertEqual(updates["provisioningStatus"], "pending")
        self.provisioner.assert_called_once()

    def test_overpaid_finished_ipn_is_held_for_review_without_provisioning(self):
        payload = self.ipn_payload()
        provider_payment = {
            "payment_id": payload["payment_id"],
            "order_id": payload["order_id"],
            "invoice_id": payload["invoice_id"],
            "payment_status": "finished",
            "price_amount": payload["price_amount"],
            "price_currency": "usd",
            "pay_currency": "usdttrc20",
            "pay_amount": "22.4",
            "actually_paid": "22.41",
        }
        response, transaction, _provider_request = self.call_ipn(
            payload, self.purchase_data(), provider_payment
        )
        updates = transaction.update.call_args.args[1]

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json()["settlementStatus"], "overpaid")
        self.assertTrue(response.get_json()["manualReviewRequired"])
        self.assertEqual(updates["settlementStatus"], "overpaid")
        self.assertFalse(updates["settlementVerified"])
        self.assertTrue(updates["manualReviewRequired"])
        self.assertNotIn("status", updates)
        self.provisioner.assert_not_called()
        self.assertTrue(app_module.purchase_payment_allows_approval({
            "paymentProvider": "nowpayments",
            "paymentStatus": "finished",
            "settlementStatus": "overpaid",
            "settlementVerified": False,
            "manualReviewRequired": True,
        }))

    def test_underpaid_or_missing_settlement_fields_never_start_provisioning(self):
        payload = self.ipn_payload()
        underpaid_provider = {
            "payment_id": payload["payment_id"],
            "order_id": payload["order_id"],
            "invoice_id": payload["invoice_id"],
            "payment_status": "finished",
            "price_amount": payload["price_amount"],
            "price_currency": "usd",
            "pay_currency": "usdttrc20",
            "pay_amount": "22.4",
            "actually_paid": "22.39",
        }
        for provider_payment, expected_status in (
            (underpaid_provider, "underpaid"),
            ({
                "payment_id": payload["payment_id"],
                "order_id": payload["order_id"],
                "invoice_id": payload["invoice_id"],
                "payment_status": "finished",
                "price_amount": payload["price_amount"],
                "price_currency": "usd",
                "pay_currency": "usdttrc20",
            }, "missing"),
        ):
            with self.subTest(settlement=expected_status):
                response, transaction, _provider_request = self.call_ipn(
                    payload, self.purchase_data(), provider_payment
                )
                updates = transaction.update.call_args.args[1]

                self.assertEqual(response.status_code, 200)
                self.assertEqual(response.get_json()["settlementStatus"], expected_status)
                self.assertTrue(response.get_json()["manualReviewRequired"])
                self.assertEqual(updates["settlementStatus"], expected_status)
                self.assertFalse(updates["settlementVerified"])
                self.assertTrue(updates["manualReviewRequired"])
                self.assertNotIn("status", updates)
                self.provisioner.assert_not_called()

    def test_confirming_or_partially_paid_ipn_cannot_auto_provision(self):
        payload = self.ipn_payload(payment_status="partially_paid")
        provider_payment = {
            "payment_id": payload["payment_id"],
            "order_id": payload["order_id"],
            "invoice_id": payload["invoice_id"],
            "payment_status": "partially_paid",
            "price_amount": payload["price_amount"],
            "price_currency": "usd",
            "pay_currency": "usdttrc20",
            "pay_amount": "22.4",
            "actually_paid": "10",
        }
        response, transaction, _provider_request = self.call_ipn(
            payload, self.purchase_data(), provider_payment
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json()["paymentStatus"], "partially_paid")
        self.assertEqual(response.get_json()["settlementStatus"], "underpaid")
        self.provisioner.assert_not_called()

    def test_late_finished_ipn_preserves_rejection_and_cannot_approve_or_expose_account(self):
        payload = self.ipn_payload()
        rejected_purchase = self.purchase_data(
            status="rejected",
            rejectionReason="Rejected before provider confirmation.",
        )
        response, transaction, _provider_request = self.call_ipn(
            payload, rejected_purchase
        )

        self.assertEqual(response.status_code, 200)
        self.assertFalse(response.get_json()["duplicate"])
        updates = transaction.update.call_args.args[1]
        self.assertEqual(updates["paymentStatus"], "finished")
        self.assertEqual(updates["providerStatus"], "finished")
        self.assertEqual(updates["providerPaymentId"], payload["payment_id"])
        self.assertTrue(updates["manualReviewRequired"])
        self.assertEqual(
            updates["manualReviewReason"],
            "Rejected before provider confirmation.",
        )
        self.assertNotIn("status", updates)
        rejected_purchase.update(updates)
        self.assertEqual(rejected_purchase["status"], "rejected")
        self.assertFalse(app_module.purchase_payment_allows_approval(rejected_purchase))
        duplicate, duplicate_transaction, _provider_request = self.call_ipn(
            payload, rejected_purchase
        )
        self.assertEqual(duplicate.status_code, 200)
        self.assertTrue(duplicate.get_json()["duplicate"])
        duplicate_transaction.update.assert_not_called()

        purchase_ref = MagicMock()
        purchase_snapshot = MagicMock()
        purchase_snapshot.to_dict.return_value = rejected_purchase
        purchase_ref.get.return_value = purchase_snapshot
        purchase = MagicMock()
        purchase.reference = purchase_ref
        purchase.reference.id = rejected_purchase["purchaseId"]
        purchase.to_dict.return_value = rejected_purchase
        database = MagicMock()
        database.transaction.return_value = MagicMock()

        with patch("app.firebase_auth.verify_id_token", return_value={"uid": "admin-1", "admin": True}):
            with patch("app.get_firebase_app"):
                with patch("app.firestore.transactional", side_effect=lambda function: function):
                    with patch("app.find_purchase_document", return_value=purchase):
                        with patch("app.get_firestore", return_value=database):
                            with patch("app.cloudflare_worker_configuration") as worker_config:
                                approval = self.authenticated_post(
                                    f"/api/admin/purchases/{rejected_purchase['purchaseId']}/approve",
                                    claims={"uid": "admin-1", "admin": True},
                                    headers={"Authorization": "******"},
                                )
        self.assertEqual(approval.status_code, 409)
        worker_config.assert_not_called()

        account_ref = MagicMock()
        account_snapshot = MagicMock()
        account_snapshot.exists = True
        account_snapshot.to_dict.return_value = {
            "ownerUid": rejected_purchase["ownerUid"],
            "status": "rejected",
            "tradingEnabled": True,
            "tradingEngineAccountId": "ACC_11111111-1111-4111-8111-111111111111",
        }
        account_ref.get.return_value = account_snapshot
        user_ref = MagicMock()
        user_ref.collection.return_value.document.return_value = account_ref
        with patch("app.firebase_auth.verify_id_token", return_value={"uid": rejected_purchase["ownerUid"]}):
            with patch("app.get_firebase_app"):
                with patch("app.user_document", return_value=user_ref):
                    with patch("app.call_cloudflare_trading_worker") as worker_call:
                        access = self.authenticated_post(
                            "/api/trading/accounts?account_id=account-789",
                            claims={"uid": rejected_purchase["ownerUid"]},
                            method="GET",
                            headers={"Authorization": "******"},
                        )
        self.assertEqual(access.status_code, 409)
        self.assertEqual(access.get_json()["code"], "trading_disabled")
        worker_call.assert_not_called()

    def test_refund_after_approval_is_flagged_for_manual_review_without_access_change(self):
        payload = self.ipn_payload(payment_status="refunded")
        response, transaction, _provider_request = self.call_ipn(
            payload, self.purchase_data(status="approved", paymentStatus="finished")
        )

        self.assertEqual(response.status_code, 200)
        updates = transaction.update.call_args.args[1]
        self.assertTrue(updates["manualReviewRequired"])
        self.assertEqual(updates["manualReviewReason"], "NOWPayments reported refunded.")
        self.assertNotIn("status", updates)
        self.assertNotIn("tradingEnabled", updates)

    def test_refunded_or_unpaid_nowpayments_purchase_cannot_be_approved(self):
        for payment_status in ("waiting", "refunded", "reversed"):
            with self.subTest(payment_status=payment_status):
                self.assertFalse(app_module.purchase_payment_allows_approval({
                    "paymentProvider": "nowpayments",
                    "paymentStatus": payment_status,
                    "manualReviewRequired": payment_status in {"refunded", "reversed"},
                }))

    def provisioning_fixture(self, plan_key="instant", account_size=5000):
        database = MemoryFirestore()
        purchase_id = "00000000-0000-4000-8000-000000000990"
        purchase_data = {
            "purchaseId": purchase_id,
            "accountId": purchase_id,
            "ownerUid": "verified-user-a",
            "planKey": plan_key,
            "accountSize": account_size,
            "totalCents": 3900,
            "paymentProvider": "nowpayments",
            "paymentStatus": "finished",
            "settlementStatus": "exact",
            "settlementVerified": True,
            "manualReviewRequired": False,
            "status": "approved",
            "approvalSource": "automatic_nowpayments",
            "provisioningStatus": "pending",
        }
        purchase_ref = MemoryDocument(purchase_id)
        purchase_ref.data = deepcopy(purchase_data)
        purchase = SimpleNamespace(reference=purchase_ref)
        user_ref = MemoryUserDocument("verified-user-a")
        return database, purchase, purchase_data, user_ref

    def engine_account_response(self, purchase_data, account_id="ACC_11111111-1111-4111-8111-111111111111"):
        return {
            "id": account_id,
            "user_id": purchase_data["ownerUid"],
            "purchase_id": purchase_data["purchaseId"],
            "model_code": app_module.TRADING_ENGINE_MODEL_CODES[purchase_data["planKey"]],
            "challenge_size": purchase_data["accountSize"],
            "phase_number": 1,
            "phase_name": "Phase 1",
            "starting_balance": purchase_data["accountSize"],
            "balance": purchase_data["accountSize"],
            "equity": purchase_data["accountSize"],
            "status": "active",
        }

    @staticmethod
    def transactional_lock(function):
        def run(transaction):
            with transaction.lock:
                return function(transaction)
        return run

    def test_exact_verified_payment_provisions_exact_product_and_is_idempotent(self):
        database, purchase, purchase_data, user_ref = self.provisioning_fixture()
        worker_response = self.engine_account_response(purchase_data)

        with patch("app.user_document", return_value=user_ref):
            with patch("app.cloudflare_worker_configuration", return_value=("https://engine.example.test", "test-token")):
                with patch("app.provision_cloudflare_account", return_value=worker_response) as worker:
                    with patch("app.firestore.transactional", side_effect=self.transactional_lock):
                        first = app_module.provision_verified_purchase(purchase, database)
                        second = app_module.provision_verified_purchase(purchase, database)

        account = user_ref.collection("accounts").document(purchase_data["accountId"]).data
        self.assertEqual(first["state"], "provisioned")
        self.assertEqual(first["accountId"], worker_response["id"])
        self.assertEqual(second["state"], "provisioned")
        worker.assert_called_once()
        self.assertEqual(worker.call_args.args[2], {
            "user_id": "verified-user-a",
            "purchase_id": purchase_data["purchaseId"],
            "plan_key": "instant",
            "account_size": 5000,
        })
        self.assertEqual(account["tradingEngineAccountId"], worker_response["id"])
        self.assertEqual(account["status"], "active")
        self.assertEqual(account["tradingStatus"], "active")
        self.assertTrue(account["tradingEnabled"])
        self.assertEqual(account["accountSize"], 5000)
        self.assertEqual(purchase.reference.data["paymentStatus"], "finished")
        self.assertEqual(purchase.reference.data["provisioningStatus"], "provisioned")

    def test_full_coupon_provisions_without_awarding_a_payment_referral_reward(self):
        database, purchase, purchase_data, user_ref = self.provisioning_fixture()
        purchase_data.update({
            "status": "pending",
            "paymentProvider": "coupon",
            "paymentMethod": "coupon",
            "paymentStatus": "not_required",
            "couponCode": "FUNDED100",
            "couponRedemptionVerified": True,
            "listPriceCents": 3900,
            "discountCents": 3900,
            "totalCents": 0,
        })
        purchase.reference.data.update(purchase_data)
        worker_response = self.engine_account_response(purchase_data)

        with patch("app.user_document", return_value=user_ref):
            with patch("app.cloudflare_worker_configuration", return_value=("https://engine.example.test", "test-token")):
                with patch("app.provision_cloudflare_account", return_value=worker_response):
                    with patch("app.award_referral_reward") as referral_reward:
                        with patch("app.firestore.transactional", side_effect=self.transactional_lock):
                            result = app_module.provision_verified_purchase(purchase, database)

        self.assertEqual(result["state"], "provisioned")
        self.assertEqual(purchase.reference.data["approvalSource"], "automatic_coupon")
        referral_reward.assert_not_called()

    def test_engine_failure_keeps_payment_paid_and_retries_same_purchase_id(self):
        database, purchase, purchase_data, user_ref = self.provisioning_fixture()
        worker_response = self.engine_account_response(purchase_data)
        worker_failure = app_module.CloudflareProvisioningError(
            "worker_timeout", "Trading engine provisioning timed out.", 504
        )

        with patch("app.user_document", return_value=user_ref):
            with patch("app.cloudflare_worker_configuration", return_value=("https://engine.example.test", "test-token")):
                with patch(
                    "app.provision_cloudflare_account",
                    side_effect=[worker_failure, worker_response],
                ) as worker:
                    with patch("app.firestore.transactional", side_effect=self.transactional_lock):
                        failed = app_module.provision_verified_purchase(purchase, database)
                        self.assertEqual(purchase.reference.data["paymentStatus"], "finished")
                        self.assertEqual(purchase.reference.data["provisioningStatus"], "pending")
                        self.assertEqual(
                            user_ref.collection("accounts").document(purchase_data["accountId"]).data["status"],
                            "pending_provisioning",
                        )
                        retried = app_module.provision_verified_purchase(purchase, database)

        self.assertEqual(failed["state"], "pending")
        self.assertEqual(retried["state"], "provisioned")
        self.assertEqual(worker.call_count, 2)
        self.assertEqual(
            worker.call_args_list[0].args[2]["purchase_id"],
            worker.call_args_list[1].args[2]["purchase_id"],
        )
        self.assertEqual(purchase.reference.data["paymentStatus"], "finished")

    def test_concurrent_provisioning_retries_share_a_single_engine_request(self):
        database, purchase, purchase_data, user_ref = self.provisioning_fixture()
        worker_response = self.engine_account_response(purchase_data)
        worker_entered = threading.Event()
        release_worker = threading.Event()

        def wait_then_provision(*_args):
            worker_entered.set()
            if not release_worker.wait(timeout=5):
                raise TimeoutError("test worker timed out")
            return worker_response

        with patch("app.user_document", return_value=user_ref):
            with patch("app.cloudflare_worker_configuration", return_value=("https://engine.example.test", "test-token")):
                with patch("app.provision_cloudflare_account", side_effect=wait_then_provision) as worker:
                    with patch("app.firestore.transactional", side_effect=self.transactional_lock):
                        with ThreadPoolExecutor(max_workers=2) as executor:
                            first_future = executor.submit(
                                app_module.provision_verified_purchase, purchase, database
                            )
                            self.assertTrue(worker_entered.wait(timeout=2))
                            second = app_module.provision_verified_purchase(purchase, database)
                            release_worker.set()
                            first = first_future.result(timeout=5)

        self.assertEqual(second["state"], "in_progress")
        self.assertEqual(first["state"], "provisioned")
        worker.assert_called_once()
        self.assertTrue(
            user_ref.collection("accounts").document(purchase_data["accountId"]).data["tradingEnabled"]
        )

    def test_user_provision_retry_cannot_access_another_users_purchase(self):
        purchase_data = self.purchase_data(
            status="approved",
            paymentStatus="finished",
            settlementStatus="exact",
            settlementVerified=True,
        )
        purchase = MagicMock()
        purchase.to_dict.return_value = {
            **purchase_data,
            "ownerUid": "another-user",
        }
        with patch("app.find_purchase_document", return_value=purchase):
            with patch("app.provision_verified_purchase") as provisioner:
                response = self.authenticated_post(
                    f"/api/my/purchases/{purchase_data['purchaseId']}/provision",
                    claims={"uid": "verified-user-a"},
                )

        self.assertEqual(response.status_code, 404)
        provisioner.assert_not_called()


if __name__ == "__main__":
    unittest.main()
