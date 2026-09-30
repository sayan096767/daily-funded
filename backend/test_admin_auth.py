import hashlib
import io
import unittest
import uuid
from datetime import datetime, timezone
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

    def test_my_accounts_uses_verified_uid_and_returns_only_its_subcollection(self):
        account = MagicMock()
        account.id = "user-a-account"
        account.to_dict.return_value = {"planKey": "1step", "accountSize": 5000, "status": "active"}
        user_ref = MagicMock()
        user_ref.collection.return_value.order_by.return_value.stream.return_value = [account]

        with patch("app.firebase_auth.verify_id_token", return_value={"uid": "user-a"}):
            with patch("app.user_document", return_value=user_ref) as document_for_user:
                response = self.client.get("/api/my/accounts?ownerUid=user-b", headers={"Authorization": "Bearer user-a-token"})

        self.assertEqual(response.status_code, 200)
        self.assertEqual([row["id"] for row in response.get_json()], ["user-a-account"])
        self.assertEqual(response.get_json()[0]["accountId"], "user-a-account")
        document_for_user.assert_called_once_with("user-a")

class AdminPurchaseTransitionTests(unittest.TestCase):
    def setUp(self):
        self.client = app.test_client()

    def review_fakes(self, account_exists):
        purchase_data = {
            "ownerUid": "user-a", "accountId": "account-a", "planKey": "1step",
            "accountSize": 25000, "status": "pending",
        }
        account_data = {"ownerUid": "user-a", "purchaseId": "purchase-a", "accountSize": 25000, "status": "pending"}
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
        account_ref.get.side_effect = lambda transaction=None: (events.append("account-read"), account_snapshot)[1]
        user_ref = MagicMock()
        user_ref.collection.return_value.document.return_value = account_ref
        transaction = MagicMock()

        def update_document(reference, updates):
            events.append("write")
            (purchase_data if reference is purchase_ref else account_data).update(updates)

        def create_document(reference, values):
            events.append("write")
            account_snapshot.exists = True
            account_data.update(values)

        transaction.update.side_effect = update_document
        transaction.set.side_effect = create_document
        fake_firestore = MagicMock()
        fake_firestore.transaction.return_value = transaction
        return purchase_data, account_data, purchase_doc, user_ref, fake_firestore, transaction, events

    def call_admin(self, route, purchase_doc, user_ref, fake_firestore):
        with patch("app.firebase_auth.verify_id_token", return_value={"uid": "admin-1", "admin": True}):
            with patch("app.firestore.transactional", side_effect=lambda function: function):
                with patch("app.find_purchase_document", return_value=purchase_doc):
                    with patch("app.get_firestore", return_value=fake_firestore):
                        with patch("app.user_document", return_value=user_ref):
                            return self.client.post(route, headers={"Authorization": "Bearer admin-token"})

    def test_approval_activates_exact_account_once_on_replay(self):
        purchase_data, account_data, purchase_doc, user_ref, fake_firestore, transaction, _events = self.review_fakes(False)
        route = "/api/admin/purchases/purchase-a/approve"

        first = self.call_admin(route, purchase_doc, user_ref, fake_firestore)
        second = self.call_admin(route, purchase_doc, user_ref, fake_firestore)

        self.assertEqual(first.status_code, 200)
        self.assertEqual(first.get_json()["status"], "approved")
        self.assertEqual(second.status_code, 200)
        self.assertTrue(second.get_json()["alreadyApproved"])
        self.assertEqual(purchase_data["status"], "approved")
        self.assertEqual(account_data["ownerUid"], "user-a")
        self.assertEqual(account_data["purchaseId"], "purchase-a")
        self.assertEqual(account_data["accountId"], "account-a")
        self.assertEqual(account_data["accountSize"], 25000)
        self.assertEqual(account_data["status"], "active")
        self.assertEqual(transaction.set.call_count, 1)

    def test_rejection_reads_before_writes_and_never_activates(self):
        purchase_data, account_data, purchase_doc, user_ref, fake_firestore, _transaction, events = self.review_fakes(True)

        response = self.call_admin("/api/admin/purchases/purchase-a/reject", purchase_doc, user_ref, fake_firestore)

        self.assertEqual(response.status_code, 200)
        self.assertEqual(purchase_data["status"], "rejected")
        self.assertEqual(purchase_data["reviewedBy"], "admin-1")
        self.assertIn("reviewedAt", purchase_data)
        self.assertEqual(account_data["status"], "rejected")
        self.assertNotEqual(account_data["status"], "active")
        self.assertLess(events.index("account-read"), events.index("write"))


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