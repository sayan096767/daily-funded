import hashlib
import io
import json
import socket
import unittest
import uuid
from datetime import datetime, timezone
from urllib.error import HTTPError
from unittest.mock import MagicMock, call, patch

from botocore.exceptions import ClientError
from flask import g

import app as app_module
from app import app, require_admin


class PurchaseApiTests(unittest.TestCase):
    submission_id = "00000000-0000-4000-8000-000000000123"
    purchase_id = str(uuid.uuid5(uuid.NAMESPACE_URL, f"daily-funded:verified-user-a:{submission_id}"))
    proof_bytes = b"\x89PNG\r\n\x1a\nlocal test proof"

    def setUp(self):
        self.client = app.test_client()

    def purchase_fakes(self, existing_purchase=None, r2_error=None, firestore_error=None):
        fake_firestore = MagicMock()
        user_ref = MagicMock()
        fake_firestore.collection.return_value.document.return_value = user_ref
        purchase_ref = MagicMock()
        purchase_ref.id = self.purchase_id
        purchase_snapshot = MagicMock()
        purchase_snapshot.exists = existing_purchase is not None
        purchase_snapshot.to_dict.return_value = existing_purchase
        purchase_ref.get.return_value = purchase_snapshot
        account_ref = MagicMock()
        account_ref.id = self.purchase_id
        collections = {
            "purchases": MagicMock(document=MagicMock(return_value=purchase_ref)),
            "accounts": MagicMock(document=MagicMock(return_value=account_ref)),
        }
        user_ref.collection.side_effect = lambda name: collections[name]
        batch = MagicMock()
        batch.commit.side_effect = firestore_error
        fake_firestore.batch.return_value = batch
        fake_r2_client = MagicMock()
        fake_r2_client.put_object.side_effect = r2_error
        fake_r2_client.head_object.side_effect = ClientError(
            {"Error": {"Code": "404"}, "ResponseMetadata": {"HTTPStatusCode": 404}},
            "HeadObject",
        )
        return fake_firestore, fake_r2_client, user_ref, purchase_ref, account_ref

    def submit(self, coupon="", include_proof=True, claims=None, existing_purchase=None, r2_error=None, firestore_error=None):
        claims = claims or {"uid": "verified-user-a", "email": "a@example.com", "name": "User A"}
        fake_firestore, fake_r2_client, user_ref, purchase_ref, account_ref = self.purchase_fakes(
            existing_purchase, r2_error, firestore_error
        )
        payload = {
            "plan": "1step", "size": "5000", "coupon": coupon,
            "submissionId": self.submission_id, "currency": "usdt", "network": "trc20",
            "ownerUid": "user-b-supplied-by-browser",
        }
        if include_proof:
            payload["proof"] = (io.BytesIO(self.proof_bytes), "payment.png")
        with patch("app.firebase_auth.verify_id_token", return_value=claims):
            with patch("app.get_firebase_app"):
                with patch("app.get_firestore", return_value=fake_firestore):
                    with patch("app.get_r2_client", return_value=fake_r2_client):
                            with patch("app.get_r2_bucket_name", return_value="daily-funded-payment-proofs"):
                                response = self.client.post(
                                    "/api/purchases", data=payload,
                                    headers={"Authorization": "Bearer valid-test-token"},
                                    content_type="multipart/form-data",
                                )
        return response, fake_firestore, fake_r2_client, user_ref, purchase_ref, account_ref

    def test_no_coupon_creates_pending_purchase_and_owner_account(self):
        response, fake_firestore, fake_r2_client, _user_ref, _purchase_ref, _account_ref = self.submit()

        self.assertEqual(response.status_code, 201)
        result = response.get_json()
        self.assertEqual(result["status"], "pending")
        self.assertEqual(result["priceCents"], 3200)
        self.assertEqual(result["discountCents"], 0)
        self.assertEqual(result["totalCents"], 3200)
        purchase_ref, purchase_data = fake_firestore.batch.return_value.create.call_args_list[0].args
        account_ref, account_data = fake_firestore.batch.return_value.create.call_args_list[1].args
        self.assertEqual(result["purchaseId"], self.purchase_id)
        self.assertEqual(purchase_ref.id, self.purchase_id)
        self.assertEqual(purchase_data["ownerUid"], "verified-user-a")
        self.assertEqual(purchase_data["purchaseId"], self.purchase_id)
        self.assertEqual(purchase_data["submissionId"], self.submission_id)
        self.assertEqual(purchase_data["couponCode"], None)
        self.assertEqual(purchase_data["listPriceCents"], 3200)
        self.assertEqual(purchase_data["totalCents"], 3200)
        self.assertEqual(purchase_data["status"], "pending")
        self.assertEqual(purchase_data["paymentProof"]["sha256"], hashlib.sha256(self.proof_bytes).hexdigest())
        self.assertEqual(purchase_data["paymentProof"]["provider"], "r2")
        self.assertEqual(purchase_data["paymentProof"]["publicId"], purchase_data["paymentProof"]["storagePath"])
        self.assertEqual(account_ref.id, result["accountId"])
        self.assertEqual(account_data["ownerUid"], "verified-user-a")
        self.assertEqual(account_data["purchaseId"], self.purchase_id)
        self.assertEqual(account_data["accountId"], result["accountId"])
        self.assertEqual(account_data["accountSize"], 5000)
        self.assertEqual(account_data["status"], "pending")
        self.assertFalse(account_data["tradingEnabled"])
        fake_r2_client.put_object.assert_called_once()
        put_kwargs = fake_r2_client.put_object.call_args.kwargs
        self.assertEqual(put_kwargs["Bucket"], "daily-funded-payment-proofs")
        self.assertEqual(put_kwargs["Key"], purchase_data["paymentProof"]["publicId"])
        self.assertEqual(put_kwargs["Body"], self.proof_bytes)
        self.assertEqual(put_kwargs["Metadata"]["sha256"], hashlib.sha256(self.proof_bytes).hexdigest())
        self.assertEqual(put_kwargs["IfNoneMatch"], "*")
        self.assertNotIn("ACL", put_kwargs)

    def test_valid_coupon_is_server_calculated(self):
        response, fake_firestore, *_ = self.submit(coupon="dailyfunded30")

        self.assertEqual(response.status_code, 201)
        result = response.get_json()
        self.assertEqual((result["priceCents"], result["discountCents"], result["totalCents"]), (3200, 960, 2240))
        purchase_data = fake_firestore.batch.return_value.create.call_args_list[0].args[1]
        self.assertEqual(purchase_data["couponCode"], "DAILYFUNDED30")

    def test_invalid_coupon_is_rejected_before_r2_or_firestore(self):
        with patch("app.firebase_auth.verify_id_token", return_value={"uid": "verified-user-a"}):
            with patch("app.get_firebase_app"):
                with patch("app.get_firestore") as firestore_client:
                    with patch("app.get_r2_client") as r2_client:
                        response = self.client.post(
                            "/api/purchases",
                            data={"plan": "1step", "size": "5000", "coupon": "NOTVALID", "currency": "usdt", "network": "trc20"},
                            headers={"Authorization": "Bearer valid-test-token"},
                        )

        self.assertEqual(response.status_code, 400)
        self.assertIn("Invalid coupon", response.get_json()["error"])
        firestore_client.assert_not_called()
        r2_client.assert_not_called()

    def test_missing_screenshot_does_not_access_r2_or_firestore(self):
        with patch("app.firebase_auth.verify_id_token", return_value={"uid": "verified-user-a"}):
            with patch("app.get_firebase_app"):
                with patch("app.get_firestore") as firestore_client:
                    with patch("app.get_r2_client") as r2_client:
                        response = self.client.post(
                            "/api/purchases",
                            data={"plan": "1step", "size": "5000", "coupon": "", "submissionId": self.submission_id, "currency": "usdt", "network": "trc20"},
                            headers={"Authorization": "Bearer valid-test-token"},
                        )

        self.assertEqual(response.status_code, 400)
        self.assertIn("Attach a payment screenshot", response.get_json()["error"])
        firestore_client.assert_not_called()
        r2_client.assert_not_called()

    def test_unauthenticated_purchase_is_rejected_without_writes(self):
        with patch("app.get_firestore") as firestore_client:
            with patch("app.get_r2_client") as r2_client:
                response = self.client.post("/api/purchases", data={})

        self.assertEqual(response.status_code, 401)
        firestore_client.assert_not_called()
        r2_client.assert_not_called()

    def test_invalid_screenshot_is_rejected_without_writes(self):
        payload = {
            "plan": "1step", "size": "5000", "coupon": "",
            "submissionId": self.submission_id, "currency": "usdt", "network": "trc20",
            "proof": (io.BytesIO(b"not an image"), "fake.png"),
        }
        with patch("app.firebase_auth.verify_id_token", return_value={"uid": "verified-user-a"}):
            with patch("app.get_firebase_app"):
                with patch("app.get_firestore") as firestore_client:
                    with patch("app.get_r2_client") as r2_client:
                        response = self.client.post("/api/purchases", data=payload, headers={"Authorization": "Bearer valid-test-token"})

        self.assertEqual(response.status_code, 400)
        self.assertIn("valid PNG", response.get_json()["error"])
        firestore_client.assert_not_called()
        r2_client.assert_not_called()

    def test_submission_replay_returns_existing_purchase_without_duplicate_writes(self):
        existing_purchase = {
            "ownerUid": "verified-user-a", "planKey": "1step", "accountSize": 5000,
            "couponCode": None, "paymentCurrency": "usdt", "paymentNetwork": "trc20",
            "status": "pending", "accountId": self.submission_id,
            "listPriceCents": 3200, "discountCents": 0, "totalCents": 3200,
            "paymentProof": {"sha256": hashlib.sha256(self.proof_bytes).hexdigest(), "storagePath": "private-proof"},
        }
        response, fake_firestore, fake_r2_client, *_ = self.submit(existing_purchase=existing_purchase)

        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.get_json()["idempotentReplay"])
        self.assertEqual(response.get_json()["purchaseId"], self.purchase_id)
        fake_firestore.batch.assert_not_called()
        fake_r2_client.put_object.assert_not_called()

    def test_firestore_credential_failure_is_a_clear_503(self):
        payload = {
            "plan": "1step", "size": "5000", "coupon": "", "submissionId": self.submission_id,
            "currency": "usdt", "network": "trc20",
            "proof": (io.BytesIO(self.proof_bytes), "payment.png"),
        }
        with patch("app.firebase_auth.verify_id_token", return_value={"uid": "verified-user-a"}):
            with patch("app.get_firebase_app"):
                with patch("app.get_firestore", side_effect=RuntimeError("credentials missing")):
                    with patch("app.get_r2_client") as r2_client:
                        response = self.client.post("/api/purchases", data=payload, headers={"Authorization": "Bearer valid-test-token"})

        self.assertEqual(response.status_code, 503)
        self.assertIn("Firestore unavailable (RuntimeError)", response.get_json()["error"])
        r2_client.assert_not_called()

    def test_r2_failure_is_reported_and_purchase_is_not_created(self):
        response, fake_firestore, _fake_r2_client, *_ = self.submit(r2_error=RuntimeError("R2 credentials missing"))

        self.assertEqual(response.status_code, 503)
        self.assertIn("Payment screenshot storage failed", response.get_json()["error"])
        fake_firestore.batch.assert_not_called()

    def test_r2_upload_retry_accepts_existing_object_with_matching_hash(self):
        fake_firestore, fake_r2_client, *_ = self.purchase_fakes(
            r2_error=RuntimeError("upload response lost")
        )
        fake_r2_client.head_object.side_effect = None
        fake_r2_client.head_object.return_value = {
            "Metadata": {"sha256": hashlib.sha256(self.proof_bytes).hexdigest()}
        }
        payload = {
            "plan": "1step", "size": "5000", "coupon": "",
            "submissionId": self.submission_id, "currency": "usdt", "network": "trc20",
            "proof": (io.BytesIO(self.proof_bytes), "payment.png"),
        }
        with patch("app.firebase_auth.verify_id_token", return_value={"uid": "verified-user-a"}):
            with patch("app.get_firebase_app"):
                with patch("app.get_firestore", return_value=fake_firestore):
                    with patch("app.get_r2_client", return_value=fake_r2_client):
                        with patch("app.get_r2_bucket_name", return_value="daily-funded-payment-proofs"):
                            response = self.client.post(
                                "/api/purchases", data=payload,
                                headers={"Authorization": "Bearer valid-test-token"},
                                content_type="multipart/form-data",
                            )

        self.assertEqual(response.status_code, 201)
        fake_r2_client.head_object.assert_called_once_with(
            Bucket="daily-funded-payment-proofs",
            Key=f"users/verified-user-a/paymentProofs/{self.purchase_id}.png",
        )
        self.assertEqual(fake_firestore.batch.return_value.commit.call_count, 1)

    def test_r2_upload_retry_rejects_existing_object_with_different_hash(self):
        fake_firestore, fake_r2_client, *_ = self.purchase_fakes(
            r2_error=RuntimeError("object already exists")
        )
        fake_r2_client.head_object.side_effect = None
        fake_r2_client.head_object.return_value = {"Metadata": {"sha256": "different"}}
        payload = {
            "plan": "1step", "size": "5000", "coupon": "",
            "submissionId": self.submission_id, "currency": "usdt", "network": "trc20",
            "proof": (io.BytesIO(self.proof_bytes), "payment.png"),
        }
        with patch("app.firebase_auth.verify_id_token", return_value={"uid": "verified-user-a"}):
            with patch("app.get_firebase_app"):
                with patch("app.get_firestore", return_value=fake_firestore):
                    with patch("app.get_r2_client", return_value=fake_r2_client):
                        with patch("app.get_r2_bucket_name", return_value="daily-funded-payment-proofs"):
                            response = self.client.post(
                                "/api/purchases", data=payload,
                                headers={"Authorization": "Bearer valid-test-token"},
                                content_type="multipart/form-data",
                            )

        self.assertEqual(response.status_code, 409)
        fake_firestore.batch.assert_not_called()

    def test_firestore_commit_failure_is_reported_and_unreferenced_proof_is_cleaned(self):
        response, fake_firestore, fake_r2_client, *_ = self.submit(firestore_error=RuntimeError("firestore unavailable"))

        self.assertEqual(response.status_code, 503)
        self.assertIn("Firestore unavailable", response.get_json()["error"])
        self.assertEqual(fake_firestore.batch.return_value.create.call_count, 2)
        fake_r2_client.delete_object.assert_called_once_with(
            Bucket="daily-funded-payment-proofs",
            Key=f"users/verified-user-a/paymentProofs/{self.purchase_id}.png",
        )


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


class FirebaseAdminConfigurationTests(unittest.TestCase):
    def test_local_service_account_file_is_loaded_for_matching_project(self):
        fake_credential = MagicMock(project_id="daily-funded")
        fake_app = object()

        with patch.object(app_module, "_firebase_app", None):
            with patch("app.firebase_admin.get_app", side_effect=ValueError):
                with patch("app.Path.is_file", return_value=True):
                    with patch("app.credentials.Certificate", return_value=fake_credential) as certificate:
                        with patch("app.firebase_admin.initialize_app", return_value=fake_app) as initialize:
                            with patch.dict("os.environ", {"GOOGLE_CLOUD_PROJECT": "daily-funded"}, clear=True):
                                result = app_module.get_firebase_app()

        expected_path = str(app_module.Path(app_module.__file__).with_name(
            "daily-funded-firebase-adminsdk-fbsvc-f4528eb4b8.json"
        ))
        self.assertIs(result, fake_app)
        certificate.assert_called_once_with(expected_path)
        initialize.assert_called_once_with(fake_credential, options={
            "projectId": "daily-funded",
            "storageBucket": "daily-funded.firebasestorage.app",
        })

    def test_service_account_project_mismatch_fails_closed(self):
        fake_credential = MagicMock(project_id="different-project")

        with patch.object(app_module, "_firebase_app", None):
            with patch("app.firebase_admin.get_app", side_effect=ValueError):
                with patch("app.Path.is_file", return_value=True):
                    with patch("app.credentials.Certificate", return_value=fake_credential):
                        with patch("app.firebase_admin.initialize_app") as initialize:
                            with patch.dict("os.environ", {"GOOGLE_CLOUD_PROJECT": "daily-funded"}, clear=True):
                                with self.assertRaisesRegex(RuntimeError, "project does not match"):
                                    app_module.get_firebase_app()

        initialize.assert_not_called()

    def test_admin_initialization_failure_returns_503_before_token_verification(self):
        with patch("app.get_firebase_app", side_effect=RuntimeError("credential setup missing")):
            with patch("app.firebase_auth.verify_id_token") as verify_token:
                response = app.test_client().get(
                    "/api/accounts", headers={"Authorization": "Bearer any-token"}
                )

        self.assertEqual(response.status_code, 503)
        self.assertIn("Firebase Admin authentication is unavailable", response.get_json()["error"])
        verify_token.assert_not_called()

    def test_invalid_user_token_still_returns_401(self):
        with patch("app.get_firebase_app", return_value=object()):
            with patch("app.firebase_auth.verify_id_token", side_effect=ValueError("bad token")):
                response = app.test_client().get(
                    "/api/accounts", headers={"Authorization": "Bearer invalid-token"}
                )

        self.assertEqual(response.status_code, 401)
        self.assertIn("Invalid or expired Firebase ID token", response.get_json()["error"])


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

    def test_pending_purchase_summary_returns_pending_records(self):
        purchase_doc = MagicMock()
        purchase_doc.id = "purchase-123"
        purchase_doc.to_dict.return_value = {
            "ownerUid": "user-abc",
            "userEmail": "trader@example.com",
            "username": "Ada Lovelace",
            "planKey": "1step",
            "accountSize": 50000,
            "listPriceCents": 32000,
            "couponCode": "DAILYFUNDED30",
            "discountCents": 9600,
            "totalCents": 22400,
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
        empty_query = MagicMock()
        empty_query.stream.return_value = []
        purchase_collection = MagicMock()
        purchase_collection.where.side_effect = [fake_query, empty_query, empty_query]
        fake_firestore = MagicMock()
        fake_firestore.collection_group.return_value = purchase_collection

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
        self.assertEqual(payload["purchases"][0]["userEmail"], "trader@example.com")
        self.assertEqual(payload["purchases"][0]["plan"], "1step")
        self.assertEqual(payload["purchases"][0]["planLabel"], "1-Step")
        self.assertEqual(payload["purchases"][0]["originalPriceCents"], 32000)
        self.assertEqual(payload["purchases"][0]["couponCode"], "DAILYFUNDED30")
        self.assertEqual(payload["purchases"][0]["discountCents"], 9600)
        self.assertEqual(payload["purchases"][0]["amountCents"], 22400)
        self.assertEqual(payload["purchases"][0]["paymentNetwork"], "trc20")
        self.assertIn("paymentProof", payload["purchases"][0])
        self.assertEqual(payload["active"], [])
        self.assertEqual(payload["rejected"], [])

    def test_admin_queue_partitions_pending_active_and_rejected_records(self):
        def purchase_document(document_id, owner_uid, status, account_id):
            document = MagicMock()
            document.id = document_id
            document.to_dict.return_value = {
                "ownerUid": owner_uid,
                "userEmail": f"{owner_uid}@example.com",
                "planKey": "1step",
                "accountSize": 5000,
                "listPriceCents": 3200,
                "discountCents": 0,
                "totalCents": 3200,
                "paymentCurrency": "usdt",
                "paymentNetwork": "trc20",
                "status": status,
                "accountId": account_id,
                "paymentProof": {"storagePath": f"users/{owner_uid}/paymentProofs/{document_id}.png"},
            }
            return document

        pending_documents = [
            purchase_document("pending-a", "user-a", "pending", "pending-a"),
            purchase_document("pending-b", "user-b", "pending_payment_verification", "pending-b"),
        ]
        approved_documents = [
            purchase_document("active-a", "user-a", "approved", "active-a"),
            purchase_document("not-active-yet", "user-b", "approved", "not-active-yet"),
        ]
        rejected_documents = [purchase_document("rejected-a", "user-a", "rejected", "rejected-a")]
        pending_query = MagicMock()
        pending_query.stream.return_value = pending_documents
        approved_query = MagicMock()
        approved_query.stream.return_value = approved_documents
        rejected_query = MagicMock()
        rejected_query.stream.return_value = rejected_documents
        purchase_collection = MagicMock()
        purchase_collection.where.side_effect = [pending_query, approved_query, rejected_query]
        active_account_snapshot = MagicMock()
        active_account_snapshot.exists = True
        active_account_snapshot.to_dict.return_value = {
            "ownerUid": "user-a",
            "purchaseId": "active-a",
            "accountId": "active-a",
            "status": "active",
        }
        wrong_owner_account_snapshot = MagicMock()
        wrong_owner_account_snapshot.exists = True
        wrong_owner_account_snapshot.to_dict.return_value = {
            "ownerUid": "different-user",
            "purchaseId": "not-active-yet",
            "accountId": "not-active-yet",
            "status": "active",
        }
        user_a_ref = MagicMock()
        user_a_ref.collection.return_value.document.return_value.get.return_value = active_account_snapshot
        user_b_ref = MagicMock()
        user_b_ref.collection.return_value.document.return_value.get.return_value = wrong_owner_account_snapshot
        users_collection = MagicMock()
        users_collection.document.side_effect = lambda uid: {"user-a": user_a_ref, "user-b": user_b_ref}[uid]
        fake_firestore = MagicMock()
        fake_firestore.collection_group.return_value = purchase_collection
        fake_firestore.collection.return_value = users_collection

        with patch("app.firebase_auth.verify_id_token", return_value={"uid": "admin-1", "admin": True}):
            with patch("app.get_firestore", return_value=fake_firestore):
                response = self.client.get(
                    "/api/admin/purchases/pending",
                    headers={"Authorization": "Bearer admin-token"},
                )

        self.assertEqual(response.status_code, 200)
        payload = response.get_json()
        self.assertEqual(
            [(row["purchaseId"], row["status"]) for row in payload["purchases"]],
            [("pending-a", "pending"), ("pending-b", "pending_payment_verification")],
        )
        self.assertEqual([row["purchaseId"] for row in payload["active"]], ["active-a"])
        self.assertEqual(payload["active"][0]["accountStatus"], "active")
        self.assertEqual(payload["active"][0]["accountId"], "active-a")
        self.assertEqual([(row["purchaseId"], row["status"]) for row in payload["rejected"]], [("rejected-a", "rejected")])
        self.assertEqual(purchase_collection.where.call_args_list[0].args, ("status", "in", ["pending", "pending_payment_verification"]))
        self.assertEqual(purchase_collection.where.call_args_list[1].args, ("status", "==", "approved"))
        self.assertEqual(purchase_collection.where.call_args_list[2].args, ("status", "==", "rejected"))
        users_collection.document.assert_has_calls([call("user-a"), call("user-b")])

    def test_admin_can_retrieve_proof_privately(self):
        purchase_doc = MagicMock()
        purchase_doc.id = "purchase-123"
        purchase_doc.to_dict.return_value = {
            "ownerUid": "user-abc",
            "paymentProof": {
                "storagePath": "users/user-abc/paymentProofs/purchase-123.png",
                "contentType": "image/png",
            },
        }
        fake_firestore = MagicMock()
        fake_firestore.collection_group.return_value.stream.return_value = [purchase_doc]
        fake_bucket = MagicMock()
        fake_bucket.blob.return_value.download_as_bytes.return_value = b"private png"

        with patch("app.firebase_auth.verify_id_token", return_value={"uid": "admin-1", "admin": True}):
            with patch("app.get_firestore", return_value=fake_firestore):
                with patch("app.get_storage_bucket", return_value=fake_bucket):
                    response = self.client.get(
                        "/api/admin/purchases/purchase-123/proof",
                        headers={"Authorization": "Bearer admin-token"},
                    )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.data, b"private png")
        self.assertEqual(response.headers["Cache-Control"], "private, no-store")
        fake_bucket.blob.assert_called_once_with("users/user-abc/paymentProofs/purchase-123.png")

    def test_admin_can_retrieve_r2_proof_through_backend(self):
        purchase_doc = MagicMock()
        purchase_doc.id = "purchase-123"
        object_key = "users/user-abc/paymentProofs/purchase-123.png"
        purchase_doc.to_dict.return_value = {
            "ownerUid": "user-abc",
            "paymentProof": {
                "provider": "r2",
                "publicId": object_key,
                "storagePath": object_key,
                "format": "png",
                "contentType": "image/png",
            },
        }
        fake_firestore = MagicMock()
        fake_firestore.collection_group.return_value.stream.return_value = [purchase_doc]
        fake_r2_client = MagicMock()
        fake_r2_client.get_object.return_value = {"Body": io.BytesIO(b"private r2 png")}

        with patch("app.firebase_auth.verify_id_token", return_value={"uid": "admin-1", "admin": True}):
            with patch("app.get_firestore", return_value=fake_firestore):
                with patch("app.get_r2_client", return_value=fake_r2_client):
                    with patch("app.get_r2_bucket_name", return_value="daily-funded-payment-proofs"):
                        response = self.client.get(
                            "/api/admin/purchases/purchase-123/proof",
                            headers={"Authorization": "Bearer admin-token"},
                        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.data, b"private r2 png")
        self.assertEqual(response.headers["Cache-Control"], "private, no-store")
        fake_r2_client.get_object.assert_called_once_with(
            Bucket="daily-funded-payment-proofs",
            Key=object_key,
        )

    def test_admin_cannot_retrieve_r2_proof_with_mismatched_owner_or_purchase(self):
        purchase_doc = MagicMock()
        purchase_doc.id = "purchase-123"
        purchase_doc.to_dict.return_value = {
            "ownerUid": "user-abc",
            "paymentProof": {
                "provider": "r2",
                "publicId": "users/other-user/paymentProofs/purchase-123.png",
                "storagePath": "users/other-user/paymentProofs/purchase-123.png",
                "format": "png",
            },
        }
        fake_firestore = MagicMock()
        fake_firestore.collection_group.return_value.stream.return_value = [purchase_doc]

        with patch("app.firebase_auth.verify_id_token", return_value={"uid": "admin-1", "admin": True}):
            with patch("app.get_firestore", return_value=fake_firestore):
                with patch("app.get_r2_client") as r2_client:
                    response = self.client.get(
                        "/api/admin/purchases/purchase-123/proof",
                        headers={"Authorization": "Bearer admin-token"},
                    )

        self.assertEqual(response.status_code, 404)
        r2_client.assert_not_called()

    def test_admin_can_retrieve_legacy_cloudinary_proof(self):
        purchase_doc = MagicMock()
        purchase_doc.id = "purchase-123"
        purchase_doc.to_dict.return_value = {
            "ownerUid": "user-abc",
            "paymentProof": {
                "publicId": "users/user-abc/paymentProofs/purchase-123",
                "version": 1234567890,
                "format": "png",
                "contentType": "image/png",
            },
        }
        fake_firestore = MagicMock()
        fake_firestore.collection_group.return_value.stream.return_value = [purchase_doc]

        with patch("app.firebase_auth.verify_id_token", return_value={"uid": "admin-1", "admin": True}):
            with patch("app.get_firestore", return_value=fake_firestore):
                with patch("app.download_cloudinary_proof", return_value=b"legacy cloudinary png") as download_proof:
                    response = self.client.get(
                        "/api/admin/purchases/purchase-123/proof",
                        headers={"Authorization": "Bearer admin-token"},
                    )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.data, b"legacy cloudinary png")
        download_proof.assert_called_once_with(
            "users/user-abc/paymentProofs/purchase-123",
            1234567890,
            "png",
        )

    def test_normal_user_cannot_retrieve_payment_proof(self):
        with patch("app.firebase_auth.verify_id_token", return_value={"uid": "customer-1", "admin": False}):
            with patch("app.get_firestore") as firestore_client:
                with patch("app.get_r2_client") as r2_client:
                    with patch("app.download_cloudinary_proof") as cloudinary_download:
                        with patch("app.get_storage_bucket") as storage_bucket:
                            response = self.client.get(
                                "/api/admin/purchases/purchase-123/proof",
                                headers={"Authorization": "Bearer fake-token"},
                            )

        self.assertEqual(response.status_code, 403)
        firestore_client.assert_not_called()
        r2_client.assert_not_called()
        cloudinary_download.assert_not_called()
        storage_bucket.assert_not_called()


class AccountOwnershipApiTests(unittest.TestCase):
    def setUp(self):
        self.client = app.test_client()

    @patch("app.get_firebase_app", return_value=object())
    def test_my_accounts_uses_verified_uid_and_returns_only_its_subcollection(self, _get_firebase_app):
        account = MagicMock()
        account.id = "user-a-account"
        account.to_dict.return_value = {
            "planKey": "1step",
            "accountSize": 5000,
            "status": "active",
            "tradingEnabled": True,
        }
        user_ref = MagicMock()
        user_ref.collection.return_value.order_by.return_value.stream.return_value = [account]

        with patch("app.firebase_auth.verify_id_token", return_value={"uid": "user-a"}):
            with patch("app.user_document", return_value=user_ref) as document_for_user:
                response = self.client.get("/api/my/accounts?ownerUid=user-b", headers={"Authorization": "Bearer test-token"})

        self.assertEqual(response.status_code, 200)
        self.assertEqual([row["id"] for row in response.get_json()], ["user-a-account"])
        self.assertEqual(response.get_json()[0]["accountId"], "user-a-account")
        self.assertTrue(response.get_json()[0]["tradingEnabled"])
        document_for_user.assert_called_once_with("user-a")

    @patch("app.get_firebase_app", return_value=object())
    def test_my_accounts_returns_false_when_own_account_is_not_trading_enabled(self, _get_firebase_app):
        account = MagicMock()
        account.id = "user-a-account"
        account.to_dict.return_value = {
            "planKey": "1step",
            "accountSize": 5000,
            "status": "active",
            "tradingEnabled": False,
        }
        user_ref = MagicMock()
        user_ref.collection.return_value.order_by.return_value.stream.return_value = [account]

        with patch("app.firebase_auth.verify_id_token", return_value={"uid": "user-a"}):
            with patch("app.user_document", return_value=user_ref) as document_for_user:
                response = self.client.get(
                    "/api/my/accounts",
                    headers={"Authorization": "Bearer test-token"},
                )

        self.assertEqual(response.status_code, 200)
        self.assertIs(response.get_json()[0]["tradingEnabled"], False)
        document_for_user.assert_called_once_with("user-a")

    @patch("app.get_firebase_app", return_value=object())
    def test_my_accounts_does_not_read_another_users_account(self, _get_firebase_app):
        own_account = MagicMock()
        own_account.id = "user-a-account"
        own_account.to_dict.return_value = {
            "planKey": "1step",
            "accountSize": 5000,
            "status": "active",
            "tradingEnabled": True,
        }
        other_account = MagicMock()
        other_account.id = "user-b-account"
        other_account.to_dict.return_value = {
            "planKey": "1step",
            "accountSize": 200000,
            "status": "active",
            "tradingEnabled": False,
        }
        own_user_ref = MagicMock()
        own_user_ref.collection.return_value.order_by.return_value.stream.return_value = [own_account]
        other_user_ref = MagicMock()
        other_user_ref.collection.return_value.order_by.return_value.stream.return_value = [other_account]

        with patch("app.firebase_auth.verify_id_token", return_value={"uid": "user-a"}):
            with patch(
                "app.user_document",
                side_effect=lambda uid: {"user-a": own_user_ref, "user-b": other_user_ref}[uid],
            ) as document_for_user:
                response = self.client.get("/api/my/accounts?ownerUid=user-b", headers={"Authorization": "Bearer test-token"})

        self.assertEqual(response.status_code, 200)
        rows = response.get_json()
        self.assertEqual([row["id"] for row in rows], ["user-a-account"])
        self.assertTrue(rows[0]["tradingEnabled"])
        document_for_user.assert_called_once_with("user-a")
        other_user_ref.collection.assert_not_called()

class AdminPurchaseTransitionTests(unittest.TestCase):
    def setUp(self):
        self.client = app.test_client()

    def review_fakes(
        self,
        purchase_status="pending",
        account_exists=True,
        engine_account_id=None,
        trading_enabled=False,
        plan_key="1step",
        account_size=25000,
    ):
        purchase_data = {
            "purchaseId": "purchase-a",
            "ownerUid": "user-a",
            "accountId": "account-a",
            "planKey": plan_key,
            "accountSize": account_size,
            "status": purchase_status,
        }
        account_data = {
            "ownerUid": "user-a",
            "purchaseId": "purchase-a",
            "accountId": "account-a",
            "planKey": plan_key,
            "accountSize": account_size,
            "status": "pending",
            "tradingEnabled": trading_enabled,
        }
        if engine_account_id is not None:
            account_data["tradingEngineAccountId"] = engine_account_id
        events = []
        purchase_ref = MagicMock()
        purchase_snapshot = MagicMock()
        purchase_snapshot.to_dict.side_effect = lambda: dict(purchase_data)
        purchase_ref.get.side_effect = lambda transaction=None: (events.append("purchase-read"), purchase_snapshot)[1]
        purchase_doc = MagicMock()
        purchase_doc.id = "purchase-a"
        purchase_doc.reference = purchase_ref
        account_ref = MagicMock()
        account_snapshot = MagicMock()
        account_snapshot.exists = account_exists
        account_snapshot.to_dict.side_effect = lambda: dict(account_data)
        account_ref.get.side_effect = lambda transaction=None: (events.append("account-read"), account_snapshot)[1]
        user_ref = MagicMock()
        user_ref.collection.return_value.document.return_value = account_ref
        transaction = MagicMock()

        def update_document(reference, updates):
            if reference is purchase_ref:
                events.append("purchase-update")
                purchase_data.update(updates)
            else:
                account_data.update(updates)
                if updates.get("tradingEngineAccountId"):
                    events.append("engine-id-saved")
                if updates.get("tradingEnabled") is False:
                    events.append("account-disabled")
                if updates.get("tradingEnabled") is True:
                    events.append("trading-enabled")

        def create_document(reference, values):
            events.append("account-created")
            account_snapshot.exists = True
            account_data.update(values)

        transaction.update.side_effect = update_document
        transaction.set.side_effect = create_document
        fake_firestore = MagicMock()
        fake_firestore.transaction.return_value = transaction
        return (
            purchase_data, account_data, purchase_doc, user_ref,
            fake_firestore, transaction, events,
        )

    def call_admin(
        self,
        purchase_doc,
        user_ref,
        fake_firestore,
        events,
        worker_status=201,
        worker_payload=None,
        worker_error=None,
        request_payload=None,
    ):
        if worker_payload is None:
            worker_payload = {
                "success": True,
                "account": {"id": "ACC_11111111-1111-4111-8111-111111111111"},
            }
        worker_response = MagicMock()
        worker_response.status = worker_status
        worker_response.read.return_value = json.dumps(worker_payload).encode("utf-8")
        response_context = MagicMock()
        response_context.__enter__.return_value = worker_response
        opened_requests = []

        def open_worker_request(outbound_request, timeout):
            events.append("worker-called")
            opened_requests.append((outbound_request, timeout))
            if worker_error is not None:
                raise worker_error
            return response_context

        with patch("app.firebase_auth.verify_id_token", return_value={"uid": "admin-1", "admin": True}):
            with patch("app.get_firebase_app"):
                with patch("app.firestore.transactional", side_effect=lambda function: function):
                    with patch("app.find_purchase_document", return_value=purchase_doc):
                        with patch("app.get_firestore", return_value=fake_firestore):
                            with patch("app.user_document", return_value=user_ref):
                                with patch(
                                    "app.cloudflare_worker_configuration",
                                    return_value=("https://worker.example", "unit-test-token"),
                                ):
                                    with patch("app.urlopen", side_effect=open_worker_request) as mocked_urlopen:
                                        response = self.client.post(
                                            "/api/admin/purchases/purchase-a/approve",
                                            json=request_payload,
                                            headers={"Authorization": "Bearer admin-token"},
                                        )
        return response, mocked_urlopen, opened_requests

    def test_pending_approval_provisions_and_saves_engine_account_id(self):
        purchase_data, account_data, purchase_doc, user_ref, fake_firestore, _transaction, events = self.review_fakes()

        response, mocked_urlopen, opened_requests = self.call_admin(
            purchase_doc, user_ref, fake_firestore, events
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(purchase_data["status"], "approved")
        self.assertEqual(
            account_data["tradingEngineAccountId"],
            "ACC_11111111-1111-4111-8111-111111111111",
        )
        self.assertTrue(account_data["tradingEnabled"])
        self.assertEqual(account_data["status"], "active")
        self.assertEqual(response.get_json()["tradingEngineAccountId"], account_data["tradingEngineAccountId"])
        mocked_urlopen.assert_called_once()
        self.assertEqual(len(opened_requests), 1)

    def test_account_is_enabled_only_after_worker_success_and_id_persistence(self):
        _purchase_data, _account_data, purchase_doc, user_ref, fake_firestore, _transaction, events = self.review_fakes()

        response, _mocked_urlopen, _opened_requests = self.call_admin(
            purchase_doc, user_ref, fake_firestore, events
        )

        self.assertEqual(response.status_code, 200)
        self.assertLess(events.index("worker-called"), events.index("engine-id-saved"))
        self.assertLess(events.index("engine-id-saved"), events.index("trading-enabled"))

    def test_worker_failure_leaves_trading_disabled_and_approval_retryable(self):
        purchase_data, account_data, purchase_doc, user_ref, fake_firestore, _transaction, events = self.review_fakes()

        failed, first_worker, _first_requests = self.call_admin(
            purchase_doc, user_ref, fake_firestore, events, worker_status=503
        )
        self.assertEqual(failed.status_code, 502)
        self.assertEqual(purchase_data["status"], "approved")
        self.assertFalse(account_data["tradingEnabled"])
        self.assertNotIn("tradingEngineAccountId", account_data)

        retried, second_worker, _second_requests = self.call_admin(
            purchase_doc, user_ref, fake_firestore, events
        )
        self.assertEqual(retried.status_code, 200)
        self.assertTrue(account_data["tradingEnabled"])
        self.assertEqual(first_worker.call_count, 1)
        self.assertEqual(second_worker.call_count, 1)

    def test_worker_timeout_leaves_trading_disabled_and_can_be_retried(self):
        purchase_data, account_data, purchase_doc, user_ref, fake_firestore, _transaction, events = self.review_fakes()

        timed_out, first_worker, _first_requests = self.call_admin(
            purchase_doc,
            user_ref,
            fake_firestore,
            events,
            worker_error=socket.timeout("local mocked timeout"),
        )
        self.assertEqual(timed_out.status_code, 504)
        self.assertEqual(timed_out.get_json()["code"], "worker_timeout")
        self.assertEqual(purchase_data["status"], "approved")
        self.assertFalse(account_data["tradingEnabled"])

        retried, second_worker, _second_requests = self.call_admin(
            purchase_doc, user_ref, fake_firestore, events
        )
        self.assertEqual(retried.status_code, 200)
        self.assertTrue(account_data["tradingEnabled"])
        first_worker.assert_called_once()
        second_worker.assert_called_once()

    def test_approved_purchase_with_saved_engine_id_does_not_reprovision(self):
        engine_id = "ACC_22222222-2222-4222-8222-222222222222"
        _purchase_data, account_data, purchase_doc, user_ref, fake_firestore, _transaction, events = self.review_fakes(
            purchase_status="approved",
            engine_account_id=engine_id,
            trading_enabled=False,
        )

        response, mocked_urlopen, _opened_requests = self.call_admin(
            purchase_doc, user_ref, fake_firestore, events
        )

        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.get_json()["alreadyApproved"])
        self.assertEqual(account_data["tradingEngineAccountId"], engine_id)
        self.assertTrue(account_data["tradingEnabled"])
        mocked_urlopen.assert_not_called()

    def test_approved_purchase_without_engine_id_is_reconciled(self):
        purchase_data, account_data, purchase_doc, user_ref, fake_firestore, _transaction, events = self.review_fakes(
            purchase_status="approved",
            trading_enabled=False,
        )

        response, mocked_urlopen, _opened_requests = self.call_admin(
            purchase_doc, user_ref, fake_firestore, events
        )

        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.get_json()["alreadyApproved"])
        self.assertEqual(purchase_data["status"], "approved")
        self.assertEqual(account_data["tradingEngineAccountId"], "ACC_11111111-1111-4111-8111-111111111111")
        self.assertTrue(account_data["tradingEnabled"])
        mocked_urlopen.assert_called_once()

    def test_reconciliation_failure_disables_legacy_enabled_account_before_worker_call(self):
        _purchase_data, account_data, purchase_doc, user_ref, fake_firestore, _transaction, events = self.review_fakes(
            purchase_status="approved",
            trading_enabled=True,
        )

        response, _mocked_urlopen, _opened_requests = self.call_admin(
            purchase_doc, user_ref, fake_firestore, events, worker_status=500
        )

        self.assertEqual(response.status_code, 502)
        self.assertFalse(account_data["tradingEnabled"])
        self.assertLess(events.index("account-disabled"), events.index("worker-called"))
        self.assertNotIn("tradingEngineAccountId", account_data)

    def test_invalid_worker_account_id_fails_closed(self):
        for invalid_id in (None, "", "   ", 123, "not-an-account-id"):
            with self.subTest(invalid_id=invalid_id):
                _purchase_data, account_data, purchase_doc, user_ref, fake_firestore, _transaction, events = self.review_fakes()
                response, _mocked_urlopen, _opened_requests = self.call_admin(
                    purchase_doc,
                    user_ref,
                    fake_firestore,
                    events,
                    worker_payload={"success": True, "account": {"id": invalid_id}},
                )

                self.assertEqual(response.status_code, 502)
                self.assertFalse(account_data["tradingEnabled"])
                self.assertNotIn("tradingEngineAccountId", account_data)

        _purchase_data, account_data, purchase_doc, user_ref, fake_firestore, _transaction, events = self.review_fakes()
        response, _mocked_urlopen, _opened_requests = self.call_admin(
            purchase_doc, user_ref, fake_firestore, events, worker_status=202
        )
        self.assertEqual(response.status_code, 502)
        self.assertFalse(account_data["tradingEnabled"])
        self.assertNotIn("tradingEngineAccountId", account_data)

    def test_worker_payload_uses_firestore_purchase_values_and_exact_worker_keys(self):
        _purchase_data, _account_data, purchase_doc, user_ref, fake_firestore, _transaction, events = self.review_fakes()

        response, _mocked_urlopen, opened_requests = self.call_admin(
            purchase_doc, user_ref, fake_firestore, events
        )

        self.assertEqual(response.status_code, 200)
        outbound_request, timeout = opened_requests[0]
        self.assertEqual(json.loads(outbound_request.data), {
            "user_id": "user-a",
            "purchase_id": "purchase-a",
            "plan_key": "1step",
            "account_size": 25000,
        })
        self.assertEqual(outbound_request.full_url, "https://worker.example/accounts/from-model")
        self.assertEqual(outbound_request.get_header("Authorization"), "Bearer unit-test-token")
        self.assertGreater(timeout, 0)

    def test_request_supplied_identity_plan_and_size_cannot_override_purchase(self):
        _purchase_data, _account_data, purchase_doc, user_ref, fake_firestore, _transaction, events = self.review_fakes()

        response, _mocked_urlopen, opened_requests = self.call_admin(
            purchase_doc,
            user_ref,
            fake_firestore,
            events,
            request_payload={
                "ownerUid": "browser-user",
                "user_id": "browser-user",
                "purchaseId": "browser-purchase",
                "purchase_id": "browser-purchase",
                "planKey": "instant",
                "plan_key": "instant",
                "accountSize": 200000,
                "account_size": 200000,
            },
        )

        self.assertEqual(response.status_code, 200)
        outbound_request, _timeout = opened_requests[0]
        self.assertEqual(json.loads(outbound_request.data), {
            "user_id": "user-a",
            "purchase_id": "purchase-a",
            "plan_key": "1step",
            "account_size": 25000,
        })

    def test_rejection_reads_before_writes_and_never_activates(self):
        purchase_data, account_data, purchase_doc, user_ref, fake_firestore, _transaction, events = self.review_fakes()

        with patch("app.firebase_auth.verify_id_token", return_value={"uid": "admin-1", "admin": True}):
            with patch("app.get_firebase_app"):
                with patch("app.firestore.transactional", side_effect=lambda function: function):
                    with patch("app.find_purchase_document", return_value=purchase_doc):
                        with patch("app.get_firestore", return_value=fake_firestore):
                            with patch("app.user_document", return_value=user_ref):
                                response = self.client.post(
                                    "/api/admin/purchases/purchase-a/reject",
                                    headers={"Authorization": "Bearer admin-token"},
                                )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(purchase_data["status"], "rejected")
        self.assertEqual(purchase_data["reviewedBy"], "admin-1")
        self.assertIn("reviewedAt", purchase_data)
        self.assertEqual(account_data["status"], "rejected")
        self.assertFalse(account_data["tradingEnabled"])
        self.assertNotEqual(account_data["status"], "active")
        self.assertLess(events.index("account-read"), events.index("purchase-update"))


class CloudflareTradingApiClientTests(unittest.TestCase):
    worker_environment = {
        "CLOUDFLARE_TRADING_WORKER_URL": "https://worker.example",
        "CLOUDFLARE_TRADING_API_TOKEN": "local-test-trading-token",
    }

    def response_context(self, status=200, body=b'{"success":true}'):
        response = MagicMock()
        response.status = status
        response.getcode.return_value = status
        response.read.return_value = body
        context = MagicMock()
        context.__enter__.return_value = response
        return context

    def test_missing_worker_configuration_fails_closed_without_http(self):
        for environment in (
            {"CLOUDFLARE_TRADING_WORKER_URL": "", "CLOUDFLARE_TRADING_API_TOKEN": "local-test-token"},
            {"CLOUDFLARE_TRADING_WORKER_URL": "https://worker.example", "CLOUDFLARE_TRADING_API_TOKEN": ""},
        ):
            with self.subTest(missing=not any(environment.values())):
                with app.test_request_context("/"):
                    g.firebase_uid = "verified-user-123"
                    with patch.dict("os.environ", environment, clear=True):
                        with patch("app.urlopen") as urlopen_mock:
                            with self.assertRaises(app_module.CloudflareTradingApiError):
                                app_module.call_cloudflare_trading_worker(
                                    "/accounts",
                                    {"account_id": "ACC_TEST"},
                                )
                urlopen_mock.assert_not_called()

    def test_worker_url_must_use_https(self):
        environment = {
            "CLOUDFLARE_TRADING_WORKER_URL": "http://worker.example",
            "CLOUDFLARE_TRADING_API_TOKEN": "local-test-token",
        }
        with app.test_request_context("/"):
            g.firebase_uid = "verified-user-123"
            with patch.dict("os.environ", environment, clear=True):
                with patch("app.urlopen") as urlopen_mock:
                    with self.assertRaises(app_module.CloudflareTradingApiError):
                        app_module.call_cloudflare_trading_worker("/accounts", {})
        urlopen_mock.assert_not_called()

    def test_worker_request_uses_verified_uid_and_ignores_payload_identity(self):
        response_context = self.response_context()
        payload = {
            "account_id": "ACC_TEST",
            "user_id": "browser-user",
            "uid": "browser-user",
            "ownerUid": "browser-user",
            "owner_uid": "browser-user",
        }
        with app.test_request_context("/"):
            g.firebase_uid = "verified-firebase-uid"
            with patch.dict("os.environ", self.worker_environment, clear=True):
                with patch("app.urlopen", return_value=response_context) as urlopen_mock:
                    result, worker_status = app_module.call_cloudflare_trading_worker("/accounts", payload)

        self.assertEqual((result, worker_status), ({"success": True}, 200))
        outbound_request = urlopen_mock.call_args.args[0]
        self.assertEqual(outbound_request.full_url, "https://worker.example/accounts")
        self.assertEqual(
            outbound_request.get_header("X-authenticated-user-uid"),
            "verified-firebase-uid",
        )
        self.assertEqual(
            json.loads(outbound_request.data),
            {"account_id": "ACC_TEST"},
        )
        self.assertGreater(urlopen_mock.call_args.kwargs["timeout"], 0)

    def test_worker_http_error_and_invalid_response_fail_closed(self):
        cases = (
            (503, b'{"success":false}'),
            (200, b"not-json"),
            (200, b'{"success":false}'),
        )
        for status, body in cases:
            with self.subTest(status=status, body=body):
                with app.test_request_context("/"):
                    g.firebase_uid = "verified-firebase-uid"
                    with patch.dict("os.environ", self.worker_environment, clear=True):
                        with patch("app.urlopen", return_value=self.response_context(status, body)):
                            with self.assertRaises(app_module.CloudflareTradingApiError):
                                app_module.call_cloudflare_trading_worker("/accounts", {})

    def test_worker_http_error_logs_only_allowlisted_response_headers(self):
        upstream_error = HTTPError(
            "https://worker.example/account-rules",
            403,
            "forbidden",
            {
                "Server": "cloudflare",
                "Content-Type": "text/html",
                "CF-Ray": "abc123-LAX",
                "CF-Cache-Status": "DYNAMIC",
                "CF-Mitigated": "challenge",
                "CF-Mitigated-Reason": "managed_rule",
                "Allow": "GET",
                "Set-Cookie": "private-cookie",
                "Authorization": "private-token",
            },
            None,
        )
        upstream_error.read = MagicMock(return_value=b"forbidden")
        with app.test_request_context("/"):
            g.firebase_uid = "verified-firebase-uid"
            with patch.dict("os.environ", self.worker_environment, clear=True):
                with patch("app.urlopen", side_effect=upstream_error):
                    with patch.object(app_module.app.logger, "warning") as warning:
                        with self.assertRaises(app_module.CloudflareTradingApiError):
                            app_module.call_cloudflare_trading_worker(
                                "/account-rules",
                                method="GET",
                                query={"account_id": "ACC_TEST"},
                            )

        diagnostic = warning.call_args.args[-1]
        self.assertEqual(
            json.loads(diagnostic),
            {
                "Allow": "GET",
                "CF-Cache-Status": "DYNAMIC",
                "CF-Mitigated": "challenge",
                "CF-Mitigated-Reason": "managed_rule",
                "CF-Ray": "abc123-LAX",
                "Content-Type": "text/html",
                "Server": "cloudflare",
            },
        )
        self.assertNotIn("private-cookie", diagnostic)
        self.assertNotIn("private-token", diagnostic)

    def test_worker_network_error_is_sanitized(self):
        with app.test_request_context("/"):
            g.firebase_uid = "verified-firebase-uid"
            with patch.dict("os.environ", self.worker_environment, clear=True):
                with patch("app.urlopen", side_effect=OSError("offline")):
                    with self.assertRaisesRegex(app_module.CloudflareTradingApiError, "could not be reached"):
                        app_module.call_cloudflare_trading_worker("/accounts", {})

    def test_worker_oversized_response_is_rejected_with_bounded_read(self):
        response = MagicMock()
        response.status = 200
        response.getcode.return_value = 200
        response.read.return_value = b"x" * (app_module.MAX_CLOUDFLARE_RESPONSE_BYTES + 1)
        response_context = MagicMock()
        response_context.__enter__.return_value = response

        with app.test_request_context("/"):
            g.firebase_uid = "verified-firebase-uid"
            with patch.dict("os.environ", self.worker_environment, clear=True):
                with patch("app.urlopen", return_value=response_context):
                    with self.assertRaises(app_module.CloudflareTradingApiError) as raised:
                        app_module.call_cloudflare_trading_worker("/accounts", {})

        self.assertEqual(raised.exception.code, "worker_response_invalid")
        self.assertEqual(raised.exception.status_code, 502)
        self.assertNotIn("local-test-trading-token", str(raised.exception))
        response.read.assert_called_once_with(app_module.MAX_CLOUDFLARE_RESPONSE_BYTES + 1)


class CloudflareTradingProxyRouteTests(unittest.TestCase):
    worker_account_id = "ACC_11111111-1111-4111-8111-111111111111"
    worker_environment = {
        "CLOUDFLARE_TRADING_WORKER_URL": "https://worker.example",
        "CLOUDFLARE_TRADING_API_TOKEN": "local-test-trading-token",
        "CLOUDFLARE_PROVISIONING_TOKEN": "local-test-provisioning-token",
    }

    def response_context(self, status=200, payload=None, raw_body=None):
        response = MagicMock()
        response.status = status
        response.getcode.return_value = status
        response.read.return_value = raw_body if raw_body is not None else json.dumps(
            payload if payload is not None else {"success": True, "data": {"id": "ACC_TEST"}}
        ).encode("utf-8")
        context = MagicMock()
        context.__enter__.return_value = response
        return context

    def call_proxy(
        self,
        path,
        method="GET",
        body=None,
        claims=None,
        worker_status=200,
        worker_payload=None,
        raw_worker_body=None,
        worker_error=None,
        environment=None,
        include_firebase_token=True,
        account_exists=True,
        account_data=None,
    ):
        claims = claims if claims is not None else {"uid": "verified-user-123"}
        request_headers = {"Authorization": "Bearer firebase-id-token"} if include_firebase_token else {}
        request_options = {"method": method, "headers": request_headers}
        if body is not None:
            request_options["json"] = body
        environment = environment or self.worker_environment
        if account_data is None:
            account_data = {
                "ownerUid": "verified-user-123",
                "tradingEnabled": True,
                "tradingEngineAccountId": self.worker_account_id,
            }
        account_snapshot = MagicMock()
        account_snapshot.exists = account_exists
        account_snapshot.to_dict.return_value = account_data
        account_ref = MagicMock()
        account_ref.get.return_value = account_snapshot
        user_ref = MagicMock()
        user_ref.collection.return_value.document.return_value = account_ref

        with patch("app.get_firebase_app", return_value=object()):
            with patch("app.firebase_auth.verify_id_token", side_effect=claims if isinstance(claims, Exception) else None, return_value=None if isinstance(claims, Exception) else claims) as verify_token:
                with patch("app.user_document", return_value=user_ref) as user_document_mock:
                    self.user_document_mock = user_document_mock
                    self.account_ref = account_ref
                    self.user_ref = user_ref
                    with patch.dict("os.environ", environment, clear=False):
                        if worker_error is not None:
                            urlopen_patch = patch("app.urlopen", side_effect=worker_error)
                        else:
                            urlopen_patch = patch(
                                "app.urlopen",
                                return_value=self.response_context(worker_status, worker_payload, raw_worker_body),
                            )
                        with urlopen_patch as worker_urlopen:
                            response = app.test_client().open(path, **request_options)

        return response, worker_urlopen, verify_token

    def test_missing_and_invalid_firebase_tokens_are_rejected_before_worker_call(self):
        missing, missing_worker, _verify = self.call_proxy(
            "/api/trading/accounts?account_id=ACC_TEST",
            include_firebase_token=False,
        )
        self.assertEqual(missing.status_code, 401)
        missing_worker.assert_not_called()

        invalid, invalid_worker, verify_token = self.call_proxy(
            "/api/trading/accounts?account_id=ACC_TEST",
            claims=ValueError("invalid token"),
        )
        self.assertEqual(invalid.status_code, 401)
        verify_token.assert_called_once()
        invalid_worker.assert_not_called()

    def test_each_existing_worker_proxy_uses_verified_uid_and_supported_fields(self):
        cases = (
            (
                "GET", "/api/trading/accounts?account_id=ACC_TEST&uid=browser&user_id=browser",
                None, "GET", "https://worker.example/accounts?account_id=" + self.worker_account_id, None,
            ),
            (
                "POST", "/api/trading/positions",
                {"account_id": "ACC_TEST", "symbol": "EURUSD", "side": "BUY", "volume": 0.1, "open_price": 1.25,
                 "user_id": "browser", "uid": "browser", "owner_uid": "browser", "authenticated_uid": "browser",
                 "provisioning_token": "browser", "api_token": "browser", "authorization": "browser",
                 "tradingEngineAccountId": "ACC_22222222-2222-4222-8222-222222222222"},
                "POST", "https://worker.example/positions",
                {"account_id": self.worker_account_id, "symbol": "EURUSD", "side": "BUY", "volume": 0.1, "open_price": 1.25},
            ),
            (
                "POST", "/api/trading/positions/price",
                {"position_id": "POS_TEST", "current_price": 1.26, "user_id": "browser"},
                "POST", "https://worker.example/positions/price",
                {"position_id": "POS_TEST", "current_price": 1.26},
            ),
            (
                "POST", "/api/trading/positions/close",
                {"position_id": "POS_TEST", "close_price": 1.26, "uid": "browser"},
                "POST", "https://worker.example/positions/close",
                {"position_id": "POS_TEST", "close_price": 1.26},
            ),
            (
                "GET", "/api/trading/trades?account_id=ACC_TEST&owner_uid=browser",
                None, "GET", "https://worker.example/trades?account_id=" + self.worker_account_id, None,
            ),
            (
                "GET", "/api/trading/account-rules?account_id=ACC_TEST&authenticated_uid=browser",
                None, "GET", "https://worker.example/account-rules?account_id=" + self.worker_account_id, None,
            ),
        )

        for frontend_method, frontend_path, body, worker_method, worker_url, worker_body in cases:
            with self.subTest(path=frontend_path):
                response, worker_urlopen, _verify_token = self.call_proxy(
                    frontend_path,
                    method=frontend_method,
                    body=body,
                    claims={"uid": "verified-user-123"},
                )

                self.assertEqual(response.status_code, 200)
                outbound_request = worker_urlopen.call_args.args[0]
                self.assertEqual(outbound_request.get_method(), worker_method)
                self.assertEqual(outbound_request.full_url, worker_url)
                self.assertEqual(outbound_request.get_header("Authorization"), "Bearer local-test-trading-token")
                self.assertEqual(
                    outbound_request.get_header("X-authenticated-user-uid"),
                    "verified-user-123",
                )
                if worker_body is None:
                    self.assertIsNone(outbound_request.data)
                else:
                    self.assertEqual(json.loads(outbound_request.data), worker_body)

    def test_missing_worker_token_and_url_fail_closed(self):
        for environment in (
            {**self.worker_environment, "CLOUDFLARE_TRADING_API_TOKEN": ""},
            {**self.worker_environment, "CLOUDFLARE_TRADING_WORKER_URL": ""},
        ):
            with self.subTest(url=bool(environment["CLOUDFLARE_TRADING_WORKER_URL"])):
                response, worker_urlopen, _verify_token = self.call_proxy(
                    "/api/trading/accounts?account_id=ACC_TEST",
                    environment=environment,
                )
                self.assertEqual(response.status_code, 503)
                self.assertNotIn("local-test-trading-token", response.get_data(as_text=True))
                worker_urlopen.assert_not_called()

    def test_non_https_worker_url_fails_closed(self):
        environment = {
            **self.worker_environment,
            "CLOUDFLARE_TRADING_WORKER_URL": "http://worker.example",
        }
        response, worker_urlopen, _verify_token = self.call_proxy(
            "/api/trading/accounts?account_id=ACC_TEST",
            environment=environment,
        )
        self.assertEqual(response.status_code, 503)
        worker_urlopen.assert_not_called()

    def test_upstream_status_malformed_json_and_network_errors_are_controlled(self):
        upstream_error = HTTPError(
            "https://worker.example/accounts?account_id=ACC_TEST",
            404,
            "private upstream detail",
            None,
            io.BytesIO(b"private upstream body"),
        )
        not_found, _worker_urlopen, _verify_token = self.call_proxy(
            "/api/trading/accounts?account_id=ACC_TEST",
            worker_error=upstream_error,
        )
        self.assertEqual(not_found.status_code, 404)
        self.assertNotIn("private upstream", not_found.get_data(as_text=True))

        malformed, _worker_urlopen, _verify_token = self.call_proxy(
            "/api/trading/accounts?account_id=ACC_TEST",
            raw_worker_body=b"not-json",
        )
        self.assertEqual(malformed.status_code, 502)

        network_error, _worker_urlopen, _verify_token = self.call_proxy(
            "/api/trading/accounts?account_id=ACC_TEST",
            worker_error=OSError("private network detail"),
        )
        self.assertEqual(network_error.status_code, 502)
        self.assertNotIn("private network detail", network_error.get_data(as_text=True))

    def test_worker_timeout_is_sanitized_and_maps_to_gateway_timeout(self):
        response, worker_urlopen, _verify_token = self.call_proxy(
            "/api/trading/accounts?account_id=ACC_TEST",
            worker_error=socket.timeout("private timeout detail local-test-trading-token"),
        )

        self.assertEqual(response.status_code, 504)
        self.assertEqual(response.get_json()["code"], "worker_timeout")
        self.assertNotIn("private timeout detail", response.get_data(as_text=True))
        self.assertNotIn("local-test-trading-token", response.get_data(as_text=True))
        worker_urlopen.assert_called_once()

    def test_worker_success_status_and_payload_are_passed_through(self):
        payload = {"success": True, "position": {"id": "POS_TEST"}}
        response, _worker_urlopen, _verify_token = self.call_proxy(
            "/api/trading/positions",
            method="POST",
            body={"account_id": "ACC_TEST", "symbol": "EURUSD", "side": "BUY", "volume": 0.1, "open_price": 1.25},
            worker_status=201,
            worker_payload=payload,
        )
        self.assertEqual(response.status_code, 201)
        self.assertEqual(response.get_json(), payload)


    def test_trading_account_proxy_resolves_owned_firestore_account(self):
        response, worker_urlopen, _verify_token = self.call_proxy(
            "/api/trading/accounts?account_id=firestore-account-123",
            claims={"uid": "verified-user-123"},
        )

        self.assertEqual(response.status_code, 200)
        self.user_document_mock.assert_called_once_with("verified-user-123")
        self.user_ref.collection.assert_called_once_with("accounts")
        self.user_ref.collection.return_value.document.assert_called_once_with("firestore-account-123")
        outbound_request = worker_urlopen.call_args.args[0]
        self.assertEqual(
            outbound_request.full_url,
            "https://worker.example/accounts?account_id=" + self.worker_account_id,
        )
        self.assertEqual(outbound_request.get_header("Authorization"), "Bearer local-test-trading-token")
        self.assertEqual(outbound_request.get_header("X-authenticated-user-uid"), "verified-user-123")

    def test_nonexistent_firestore_account_is_not_forwarded_to_worker(self):
        response, worker_urlopen, _verify_token = self.call_proxy(
            "/api/trading/accounts?account_id=missing-account",
            account_exists=False,
        )

        self.assertEqual(response.status_code, 404)
        self.assertEqual(response.get_json()["code"], "trading_account_not_found")
        worker_urlopen.assert_not_called()

    def test_account_owned_by_another_uid_is_hidden_as_not_found(self):
        response, worker_urlopen, _verify_token = self.call_proxy(
            "/api/trading/accounts?account_id=foreign-account",
            account_data={
                "ownerUid": "another-user",
                "tradingEnabled": True,
                "tradingEngineAccountId": "ACC_22222222-2222-4222-8222-222222222222",
            },
        )

        self.assertEqual(response.status_code, 404)
        self.assertEqual(response.get_json()["code"], "trading_account_not_found")
        self.assertNotIn("another-user", response.get_data(as_text=True))
        self.assertNotIn("ACC_22222222", response.get_data(as_text=True))
        worker_urlopen.assert_not_called()

    def test_missing_or_invalid_engine_account_id_fails_without_provisioning(self):
        account_records = (
            {"ownerUid": "verified-user-123", "tradingEnabled": True},
            {
                "ownerUid": "verified-user-123",
                "tradingEnabled": True,
                "tradingEngineAccountId": "not-a-worker-id",
            },
        )
        with patch("app.provision_cloudflare_account") as provision_account:
            for account_data in account_records:
                with self.subTest(account_data=account_data):
                    response, worker_urlopen, _verify_token = self.call_proxy(
                        "/api/trading/accounts?account_id=firestore-account-123",
                        account_data=account_data,
                    )

                    self.assertEqual(response.status_code, 409)
                    self.assertEqual(response.get_json()["code"], "trading_account_unavailable")
                    worker_urlopen.assert_not_called()
            provision_account.assert_not_called()

    def test_trading_disabled_account_is_not_forwarded_or_mutated(self):
        response, worker_urlopen, _verify_token = self.call_proxy(
            "/api/trading/accounts?account_id=firestore-account-123",
            account_data={
                "ownerUid": "verified-user-123",
                "tradingEnabled": False,
                "tradingEngineAccountId": self.worker_account_id,
            },
        )

        self.assertEqual(response.status_code, 409)
        self.assertEqual(response.get_json()["code"], "trading_disabled")
        self.account_ref.update.assert_not_called()
        worker_urlopen.assert_not_called()

    def test_request_cannot_override_stored_engine_account_id(self):
        cases = (
            (
                "/api/trading/accounts?account_id=firestore-account-123&tradingEngineAccountId=ACC_22222222-2222-4222-8222-222222222222",
                None,
            ),
            (
                "/api/trading/positions",
                {
                    "account_id": "firestore-account-123",
                    "tradingEngineAccountId": "ACC_22222222-2222-4222-8222-222222222222",
                    "symbol": "EURUSD",
                    "side": "BUY",
                    "volume": 0.1,
                    "open_price": 1.25,
                },
            ),
        )
        for path, body in cases:
            with self.subTest(path=path):
                response, worker_urlopen, _verify_token = self.call_proxy(
                    path,
                    method="POST" if body else "GET",
                    body=body,
                    claims={"uid": "verified-user-123"},
                )

                self.assertEqual(response.status_code, 200)
                outbound_request = worker_urlopen.call_args.args[0]
                if body:
                    outbound_payload = json.loads(outbound_request.data)
                    self.assertEqual(outbound_payload["account_id"], self.worker_account_id)
                    self.assertNotIn("tradingEngineAccountId", outbound_payload)
                else:
                    self.assertIn("account_id=" + self.worker_account_id, outbound_request.full_url)
                self.assertNotIn("ACC_22222222", outbound_request.full_url + (outbound_request.data or b"").decode())

class LocalCorsTests(unittest.TestCase):
    def test_local_origins_on_port_5500_are_allowed_but_other_origins_are_not(self):
        client = app.test_client()
        for origin in ("http://127.0.0.1:5500", "http://localhost:5500"):
            response = client.options("/api/purchases", headers={
                "Origin": origin,
                "Access-Control-Request-Method": "POST",
                "Access-Control-Request-Headers": "authorization",
            })
            self.assertEqual(response.headers.get("Access-Control-Allow-Origin"), origin)
        for origin in ("http://localhost:5501", "https://unapproved.example"):
            response = client.options("/api/purchases", headers={"Origin": origin})
            self.assertIsNone(response.headers.get("Access-Control-Allow-Origin"))


if __name__ == "__main__":
    unittest.main()