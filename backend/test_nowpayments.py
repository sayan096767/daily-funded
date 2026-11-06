import hashlib
import hmac
import json
import unittest
import uuid
from unittest.mock import MagicMock, call, patch

import app as app_module
from app import app
from test_admin_auth import PurchaseApiTests


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

    def authenticated_post(self, path, payload, claims=None):
        with patch("app.firebase_auth.verify_id_token", return_value=claims or {
            "uid": "verified-user-a", "email": "a@example.com", "name": "User A",
        }):
            with patch("app.get_firebase_app"):
                return self.client.post(
                    path,
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
            "currency": "usdttrc20",
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
                with patch("app.nowpayments_currency_is_available", return_value=True):
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
        self.assertEqual(saved_purchase["paymentCurrency"], "usdttrc20")
        self.assertEqual(saved_purchase["paymentNetwork"], "tron")
        self.assertEqual(saved_purchase["paymentProvider"], "nowpayments")
        self.assertEqual(saved_purchase["invoiceId"], "invoice-123")
        invoice_payload = provider_request.call_args.args[3]
        self.assertEqual(invoice_payload["price_amount"], 22.4)
        self.assertEqual(invoice_payload["price_currency"], "usd")
        self.assertEqual(invoice_payload["pay_currency"], "usdttrc20")
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

    def test_checkout_rejects_invalid_coupon_spark_and_unlisted_currency_before_provider_call(self):
        invalid_cases = (
            (self.checkout_payload(coupon="NOT-A-COUPON"), "Invalid coupon"),
            (
                self.checkout_payload(
                    plan="spark_1step",
                    size=25000,
                    productModel="spark",
                    productId="MODEL_FX_SPARK_1STEP",
                ),
                "only available for Classic",
            ),
            (self.checkout_payload(currency="unsupported-network"), "supported crypto"),
        )
        for payload, expected_error in invalid_cases:
            with self.subTest(payload=payload):
                with patch("app.get_firestore") as firestore_client:
                    with patch("app.nowpayments_api_request") as provider_request:
                        response = self.authenticated_post("/api/crypto/checkout", payload)
                self.assertEqual(response.status_code, 400)
                self.assertIn(expected_error, response.get_json()["error"])
                firestore_client.assert_not_called()
                provider_request.assert_not_called()

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

    def call_ipn(self, payload, purchase_data, provider_payment=None):
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
        provider_payment = provider_payment or {
            "payment_id": payload["payment_id"],
            "order_id": payload["order_id"],
            "payment_status": payload["payment_status"],
            "price_amount": payload["price_amount"],
            "price_currency": payload["price_currency"],
            "pay_currency": payload["pay_currency"],
        }
        with patch("app.nowpayments_configuration", return_value=self.config):
            with patch("app.find_purchase_document", return_value=purchase):
                with patch("app.get_firestore", return_value=database):
                    with patch("app.nowpayments_api_request", return_value=provider_payment) as provider_request:
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
            "ownerUid": "verified-user-a",
            "planKey": "1step",
            "accountSize": 5000,
            "totalCents": 2240,
            "paymentCurrency": "usdttrc20",
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

    def test_finished_ipn_is_idempotent_and_does_not_provision_an_account(self):
        payload = self.ipn_payload()
        existing_purchase = self.purchase_data(
            paymentStatus="finished",
            providerPaymentId=payload["payment_id"],
        )
        response, transaction, _provider_request = self.call_ipn(
            payload, existing_purchase
        )

        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.get_json()["duplicate"])
        transaction.update.assert_not_called()
        self.assertFalse(app_module.purchase_payment_allows_approval({
            "paymentProvider": "nowpayments",
            "paymentStatus": "waiting",
        }))
        self.assertTrue(app_module.purchase_payment_allows_approval({
            "paymentProvider": "nowpayments",
            "paymentStatus": "finished",
        }))

    def test_valid_finished_ipn_updates_payment_without_changing_purchase_or_account(self):
        payload = self.ipn_payload()
        response, transaction, _provider_request = self.call_ipn(
            payload, self.purchase_data()
        )

        self.assertEqual(response.status_code, 200)
        self.assertFalse(response.get_json()["duplicate"])
        updates = transaction.update.call_args.args[1]
        self.assertEqual(updates["paymentStatus"], "finished")
        self.assertEqual(updates["providerPaymentId"], payload["payment_id"])
        self.assertNotIn("status", updates)
        self.assertNotIn("accountId", updates)

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


if __name__ == "__main__":
    unittest.main()
