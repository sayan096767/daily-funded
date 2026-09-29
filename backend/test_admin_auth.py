import unittest
from datetime import datetime, timezone
from unittest.mock import MagicMock, patch

from flask import g

from app import app, require_admin


class RegistrationProfileApiTests(unittest.TestCase):
    def setUp(self):
        self.client = app.test_client()

    def submit_registration(self, profile_exists):
        claims = {"uid": "authenticated-user", "email": "verified@example.com"}
        fake_firestore = MagicMock()
        profile_ref = fake_firestore.collection.return_value.document.return_value
        profile_ref.get.return_value.exists = profile_exists
        payload = {
            "uid": "browser-selected-user",
            "email": "unverified@example.com",
            "password": "must-not-be-stored",
            "firstName": "Ada",
            "lastName": "Lovelace",
            "dateOfBirth": "1815-12-10",
            "country": "GB",
            "phone": "+441234567890",
        }

        with patch("app.firebase_auth.verify_id_token", return_value=claims):
            with patch("app.get_firebase_app"):
                with patch("app.get_firestore", return_value=fake_firestore):
                    response = self.client.post(
                        "/api/auth/register",
                        json=payload,
                        headers={"Authorization": "Bearer fake-token"},
                    )

        return response, fake_firestore, profile_ref

    def test_registration_creates_profile_for_authenticated_uid(self):
        response, fake_firestore, profile_ref = self.submit_registration(profile_exists=False)

        self.assertEqual(response.status_code, 201)
        self.assertEqual(response.get_json()["uid"], "authenticated-user")
        fake_firestore.collection.assert_called_once_with("users")
        fake_firestore.collection.return_value.document.assert_called_once_with("authenticated-user")
        profile_ref.set.assert_called_once()
        stored_profile = profile_ref.set.call_args.args[0]
        self.assertEqual(stored_profile["firstName"], "Ada")
        self.assertEqual(stored_profile["lastName"], "Lovelace")
        self.assertEqual(stored_profile["email"], "verified@example.com")
        self.assertEqual(stored_profile["phone"], "+441234567890")
        self.assertEqual(stored_profile["dateOfBirth"], "1815-12-10")
        self.assertEqual(stored_profile["country"], "GB")
        self.assertIn("createdAt", stored_profile)
        self.assertIn("updatedAt", stored_profile)
        self.assertNotIn("password", stored_profile)
        self.assertNotIn("uid", stored_profile)
        self.assertTrue(profile_ref.set.call_args.kwargs["merge"])

    def test_registration_update_preserves_existing_created_at(self):
        response, _fake_firestore, profile_ref = self.submit_registration(profile_exists=True)

        self.assertEqual(response.status_code, 201)
        stored_profile = profile_ref.set.call_args.args[0]
        self.assertNotIn("createdAt", stored_profile)
        self.assertIn("updatedAt", stored_profile)
        self.assertTrue(profile_ref.set.call_args.kwargs["merge"])


class RequireAdminTests(unittest.TestCase):
    def check_admin(self, claims):
        with app.test_request_context():
            g.firebase_claims = claims
            return require_admin()

    def test_authenticated_normal_user_is_forbidden(self):
        result = self.check_admin({"uid": "normal-user", "admin": False})
        self.assertEqual(result[1], 403)

    def test_boolean_admin_claim_is_allowed(self):
        self.assertIsNone(self.check_admin({"uid": "admin-user", "admin": True}))

    def test_string_admin_claim_is_forbidden(self):
        result = self.check_admin({"uid": "normal-user", "admin": "true"})
        self.assertEqual(result[1], 403)

    def test_missing_admin_claim_is_forbidden(self):
        result = self.check_admin({"uid": "normal-user"})
        self.assertEqual(result[1], 403)


class AdminPurchaseReviewApiTests(unittest.TestCase):
    def setUp(self):
        self.client = app.test_client()

    def test_pending_purchases_requires_admin_claim(self):
        with patch("app.firebase_auth.verify_id_token", return_value={"uid": "customer-1", "admin": False}):
            response = self.client.get(
                "/api/admin/purchases/pending",
                headers={"Authorization": "Bearer fake-token"},
            )
        self.assertEqual(response.status_code, 403)
        self.assertIn("Administrator authorization is required.", response.get_json()["error"])

    def test_pending_purchases_endpoint_returns_only_pending_records(self):
        purchase_doc = MagicMock()
        purchase_doc.id = "purchase-123"
        purchase_doc.to_dict.return_value = {
            "ownerUid": "user-abc",
            "planKey": "1step",
            "accountSize": 50000,
            "totalCents": 32000,
            "paymentCurrency": "usdt",
            "paymentNetwork": "trc20",
            "status": "pending_payment_verification",
            "createdAt": datetime.now(timezone.utc),
            "paymentProof": {
                "storagePath": "users/user-abc/paymentProofs/purchase-123.png",
                "format": "png",
                "sizeBytes": 123456,
                "contentType": "image/png",
            },
            "accountId": "account-abc",
        }
        fake_query = MagicMock()
        fake_query.stream.return_value = [purchase_doc]
        fake_firestore = MagicMock()
        fake_firestore.collection_group.return_value.where.return_value = fake_query

        with patch("app.firebase_auth.verify_id_token", return_value={"uid": "admin-1", "admin": True}):
            with patch("app.get_firestore", return_value=fake_firestore):
                response = self.client.get(
                    "/api/admin/purchases/pending",
                    headers={"Authorization": "Bearer fake-token"},
                )

        self.assertEqual(response.status_code, 200)
        payload = response.get_json()
        self.assertEqual(payload["purchases"][0]["purchaseId"], "purchase-123")
        self.assertEqual(payload["purchases"][0]["uid"], "user-abc")
        self.assertEqual(payload["purchases"][0]["plan"], "1step")
        self.assertEqual(payload["purchases"][0]["paymentNetwork"], "trc20")
        self.assertIn("paymentProof", payload["purchases"][0])


if __name__ == "__main__":
    unittest.main()