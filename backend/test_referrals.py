import base64
import hashlib
import hmac
import unittest
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import app as app_module
from app import app


class FakeSnapshot:
    def __init__(self, document_id, data):
        self.id = document_id
        self.exists = data is not None
        self._data = data

    def to_dict(self):
        return dict(self._data) if self._data is not None else None


class FakeReference:
    def __init__(self, database, collection, document_id):
        self.database = database
        self.collection = collection
        self.id = document_id

    def get(self, transaction=None):
        return FakeSnapshot(self.id, self.database.documents.get((self.collection, self.id)))

    def create(self, data):
        key = (self.collection, self.id)
        if key in self.database.documents:
            raise ValueError("Document already exists.")
        self.database.documents[key] = dict(data)

    def set(self, data, merge=False):
        key = (self.collection, self.id)
        existing = self.database.documents.get(key, {}) if merge else {}
        self.database.documents[key] = {**existing, **data}


class FakeQuery:
    def __init__(self, database, collection, filters=()):
        self.database = database
        self.collection = collection
        self.filters = filters

    def where(self, field, operator, value):
        return FakeQuery(self.database, self.collection, self.filters + ((field, operator, value),))

    def stream(self):
        results = []
        for (collection, document_id), data in self.database.documents.items():
            if collection != self.collection:
                continue
            if all(operator == "==" and data.get(field) == value for field, operator, value in self.filters):
                results.append(FakeSnapshot(document_id, data))
        return results


class FakeCollection(FakeQuery):
    def document(self, document_id):
        return FakeReference(self.database, self.collection, document_id)


class FakeTransaction:
    def create(self, reference, data):
        reference.create(data)

    def set(self, reference, data, merge=False):
        reference.set(data, merge=merge)


class FakeDatabase:
    def __init__(self, documents=None):
        self.documents = dict(documents or {})

    def collection(self, name):
        return FakeCollection(self, name)

    def transaction(self):
        return FakeTransaction()


class ReferralTokenTests(unittest.TestCase):
    def test_signed_token_round_trips_and_tampering_is_rejected(self):
        with patch.dict("os.environ", {"DAILYFUNDED_SECRET_KEY": "test-secret-" * 4}):
            token = app_module.encode_referral_token("A" * 32)
            decoded = app_module.decode_referral_token(token)
            encoded_payload, encoded_signature = token.split(".", 1)
            tampered_payload = (
                "A" if encoded_payload[0] != "A" else "B"
            ) + encoded_payload[1:]
            tampered_signature = (
                "A" if encoded_signature[0] != "A" else "B"
            ) + encoded_signature[1:]
            alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
            payload_last_character_index = alphabet.index(encoded_payload[-1])
            noncanonical_payload = (
                encoded_payload[:-1] + alphabet[payload_last_character_index ^ 1]
            )
            last_character_index = alphabet.index(encoded_signature[-1])
            noncanonical_signature = (
                encoded_signature[:-1] + alphabet[last_character_index ^ 1]
            )
            noncanonical_payload_signature = base64.urlsafe_b64encode(
                hmac.new(
                    app_module.referral_token_signing_key(),
                    noncanonical_payload.encode("ascii"),
                    hashlib.sha256,
                ).digest()
            ).rstrip(b"=").decode("ascii")

            self.assertEqual(decoded[0], "A" * 32)
            self.assertIsNone(
                app_module.decode_referral_token(
                    f"{tampered_payload}.{encoded_signature}"
                )
            )
            self.assertIsNone(
                app_module.decode_referral_token(
                    f"{encoded_payload}.{tampered_signature}"
                )
            )
            self.assertEqual(
                base64.urlsafe_b64decode(
                    encoded_payload + "=" * (-len(encoded_payload) % 4)
                ),
                base64.urlsafe_b64decode(
                    noncanonical_payload + "=" * (-len(noncanonical_payload) % 4)
                ),
            )
            self.assertIsNone(
                app_module.decode_referral_token(
                    f"{noncanonical_payload}.{noncanonical_payload_signature}"
                )
            )
            self.assertEqual(
                base64.urlsafe_b64decode(encoded_signature + "="),
                base64.urlsafe_b64decode(noncanonical_signature + "="),
            )
            self.assertIsNone(
                app_module.decode_referral_token(
                    f"{encoded_payload}.{noncanonical_signature}"
                )
            )

    def test_malformed_and_oversized_tokens_are_rejected(self):
        malformed_tokens = (
            "",
            ".",
            "not-a-token",
            "one.two.three",
            "****.****",
            "é.signature",
            None,
            123,
            "x." + "A" * 2049,
        )
        with patch.dict("os.environ", {"DAILYFUNDED_SECRET_KEY": ""}):
            for token in malformed_tokens:
                with self.subTest(token=token):
                    self.assertIsNone(app_module.decode_referral_token(token))

        with patch.dict("os.environ", {"DAILYFUNDED_SECRET_KEY": "test-secret-" * 4}):
            payload = base64.urlsafe_b64encode(b"not-json").rstrip(b"=").decode("ascii")
            signature = base64.urlsafe_b64encode(
                hmac.new(
                    app_module.referral_token_signing_key(),
                    payload.encode("ascii"),
                    hashlib.sha256,
                ).digest()
            ).rstrip(b"=").decode("ascii")
            self.assertIsNone(app_module.decode_referral_token(f"{payload}.{signature}"))

    def test_signing_fails_explicitly_without_configured_secret(self):
        with patch.dict("os.environ", {"DAILYFUNDED_SECRET_KEY": ""}):
            with self.assertRaisesRegex(RuntimeError, "DAILYFUNDED_SECRET_KEY"):
                app_module.referral_token_signing_key()


class ReferralPersistenceTests(unittest.TestCase):
    def setUp(self):
        self.database = FakeDatabase()

    def test_referral_code_is_persistent_and_mapped_to_the_owner(self):
        with patch("app.firestore.transactional", side_effect=lambda function: function):
            with patch("app.secrets.token_hex", return_value="ab" * 16):
                first_code = app_module.ensure_referral_code("owner-uid", self.database)
                second_code = app_module.ensure_referral_code("owner-uid", self.database)

        self.assertEqual(first_code, "AB" * 16)
        self.assertEqual(second_code, first_code)
        self.assertEqual(
            self.database.documents[("referralCodes", first_code)]["ownerUid"],
            "owner-uid",
        )
        self.assertEqual(
            self.database.documents[("users", "owner-uid")]["referralCode"],
            first_code,
        )

    def test_referral_attribution_requires_link_to_precede_account_creation(self):
        code = "C" * 32
        self.database.documents[("referralCodes", code)] = {"ownerUid": "referrer-uid"}
        with patch.dict("os.environ", {"DAILYFUNDED_SECRET_KEY": "test-secret-" * 4}):
            token = app_module.encode_referral_token(code)
            decoded = app_module.decode_referral_token(token)
            self.assertIsNotNone(decoded)
            firebase_user = SimpleNamespace(
                user_metadata=SimpleNamespace(creation_timestamp=decoded[1] + 1000)
            )

            with patch("app.firebase_auth.get_user", return_value=firebase_user):
                with patch("app.get_firebase_app"):
                    with patch("app.firestore.transactional", side_effect=lambda function: function):
                        result = app_module.record_referral_attribution("new-user-uid", token, self.database)
                        replay = app_module.record_referral_attribution("new-user-uid", token, self.database)

        self.assertTrue(result["applied"])
        self.assertFalse(result["existing"])
        self.assertTrue(replay["applied"])
        self.assertTrue(replay["existing"])
        attribution = self.database.documents[("referralAttributions", "new-user-uid")]
        self.assertEqual(attribution["referrerUid"], "referrer-uid")

    def test_account_created_before_referral_link_is_not_attributed(self):
        code = "D" * 32
        self.database.documents[("referralCodes", code)] = {"ownerUid": "referrer-uid"}
        with patch.dict("os.environ", {"DAILYFUNDED_SECRET_KEY": "test-secret-" * 4}):
            token = app_module.encode_referral_token(code)
            firebase_user = SimpleNamespace(
                user_metadata=SimpleNamespace(
                    creation_timestamp=int((datetime.now(timezone.utc) - timedelta(days=1)).timestamp() * 1000)
                )
            )

            with patch("app.firebase_auth.get_user", return_value=firebase_user):
                with patch("app.get_firebase_app"):
                    result = app_module.record_referral_attribution("existing-user-uid", token, self.database)

        self.assertFalse(result["applied"])
        self.assertNotIn(("referralAttributions", "existing-user-uid"), self.database.documents)

    def test_invalid_referral_token_cannot_create_attribution(self):
        with patch.dict("os.environ", {"DAILYFUNDED_SECRET_KEY": "test-secret-" * 4}):
            with patch("app.firebase_auth.get_user") as get_user:
                result = app_module.record_referral_attribution(
                    "new-user-uid",
                    "invalid-token",
                    self.database,
                )

        self.assertFalse(result["applied"])
        self.assertIn("invalid", result["reason"].lower())
        get_user.assert_not_called()
        self.assertNotIn(("referralAttributions", "new-user-uid"), self.database.documents)

    def test_self_referral_is_rejected(self):
        code = "E" * 32
        self.database.documents[("referralCodes", code)] = {"ownerUid": "same-uid"}
        with patch.dict("os.environ", {"DAILYFUNDED_SECRET_KEY": "test-secret-" * 4}):
            token = app_module.encode_referral_token(code)
            decoded = app_module.decode_referral_token(token)
            firebase_user = SimpleNamespace(
                user_metadata=SimpleNamespace(
                    creation_timestamp=decoded[1] + 1000
                )
            )

            with patch("app.firebase_auth.get_user", return_value=firebase_user):
                with patch("app.get_firebase_app"):
                    with patch("app.firestore.transactional", side_effect=lambda function: function):
                        result = app_module.record_referral_attribution("same-uid", token, self.database)

        self.assertFalse(result["applied"])
        self.assertNotIn(("referralAttributions", "same-uid"), self.database.documents)

    def test_invalid_account_and_referrer_identities_are_rejected(self):
        code = "B" * 32
        self.database.documents[("referralCodes", code)] = {"ownerUid": "   "}
        with patch.dict("os.environ", {"DAILYFUNDED_SECRET_KEY": "test-secret-" * 4}):
            token = app_module.encode_referral_token(code)
            decoded = app_module.decode_referral_token(token)
            firebase_user = SimpleNamespace(
                user_metadata=SimpleNamespace(creation_timestamp=decoded[1] + 1000)
            )
            firebase_app = object()
            with patch("app.get_firebase_app", return_value=firebase_app):
                with patch(
                    "app.firebase_auth.get_user",
                    return_value=firebase_user,
                ) as get_user:
                    with patch(
                        "app.firestore.transactional",
                        side_effect=lambda function: function,
                    ):
                        invalid_uid_results = [
                            app_module.record_referral_attribution(
                                uid, token, self.database
                            )
                            for uid in ("", "   ")
                        ]
                        invalid_owner_result = app_module.record_referral_attribution(
                            "new-user-uid", token, self.database
                        )

        self.assertTrue(all(not result["applied"] for result in invalid_uid_results))
        self.assertFalse(invalid_owner_result["applied"])
        get_user.assert_called_once_with("new-user-uid", app=firebase_app)
        self.assertNotIn(("referralAttributions", "new-user-uid"), self.database.documents)

    def test_reward_is_one_time_and_separate_from_trading_balance(self):
        self.database.documents[("referralAttributions", "referred-uid")] = {
            "referrerUid": "referrer-uid",
            "referredUid": "referred-uid",
        }
        transaction = self.database.transaction()
        first_result = app_module.award_referral_reward(
            transaction, self.database, "referred-uid", "purchase-a"
        )
        second_result = app_module.award_referral_reward(
            transaction, self.database, "referred-uid", "purchase-b"
        )

        reward = self.database.documents[("referralRewards", "referred-uid")]
        self.assertTrue(first_result)
        self.assertFalse(second_result)
        self.assertEqual(reward["amountCents"], 1000)
        self.assertEqual(reward["currency"], "USD")
        self.assertEqual(reward["qualifyingPurchaseId"], "purchase-a")
        self.assertEqual(reward["status"], "available")
        self.assertEqual(reward["creditEvent"], "first_approved_purchase")
        self.assertFalse({"balance", "equity", "tradingBalance"} & set(reward))


class ReferralApiTests(unittest.TestCase):
    def setUp(self):
        self.client = app.test_client()
        self.database = FakeDatabase()

    def test_referral_dashboard_requires_authentication(self):
        with patch("app.get_firestore") as get_firestore:
            response = self.client.get("/api/referrals")

        self.assertEqual(response.status_code, 401)
        self.assertEqual(response.get_json()["error"], "Sign in is required.")
        get_firestore.assert_not_called()

    def test_authenticated_dashboard_retrieval_returns_a_stable_referral_code(self):
        with patch("app.firebase_auth.verify_id_token", return_value={"uid": "owner-uid"}):
            with patch("app.get_firebase_app"):
                with patch("app.get_firestore", return_value=self.database):
                    with patch("app.firestore.transactional", side_effect=lambda function: function):
                        with patch(
                            "app.secrets.token_hex",
                            side_effect=["A" * 32, "B" * 32],
                        ):
                            responses = [
                                self.client.get(
                                    "/api/referrals",
                                    headers={"Authorization": "Bearer test-id-token"},
                                )
                                for _ in range(2)
                            ]

        self.assertEqual([response.status_code for response in responses], [200, 200])
        first_result, second_result = [response.get_json() for response in responses]
        self.assertEqual(first_result["referralCode"], "A" * 32)
        self.assertEqual(second_result["referralCode"], first_result["referralCode"])
        self.assertEqual(
            self.database.documents[("referralCodes", "A" * 32)]["ownerUid"],
            "owner-uid",
        )
        self.assertNotIn(("referralCodes", "B" * 32), self.database.documents)

    def test_registration_forwards_signed_referral_to_backend_attribution(self):
        profile_ref = MagicMock()
        profile_ref.get.return_value.exists = False
        referral_result = {"applied": True, "existing": False}
        payload = {
            "firstName": "Ada",
            "lastName": "Lovelace",
            "dateOfBirth": "1815-12-10",
            "country": "GB",
            "phone": "+441234567890",
            "referralToken": "signed-referral-token",
        }

        with patch("app.firebase_auth.verify_id_token", return_value={"uid": "new-user", "email": "ada@example.com"}):
            with patch("app.get_firebase_app"):
                with patch("app.get_firestore", return_value=self.database):
                    with patch("app.user_document", return_value=profile_ref):
                        with patch("app.record_referral_attribution", return_value=referral_result) as record_referral:
                            response = self.client.post(
                                "/api/auth/register",
                                json=payload,
                                headers={"Authorization": "Bearer test-token"},
                            )

        self.assertEqual(response.status_code, 201)
        self.assertEqual(response.get_json()["referral"], referral_result)
        record_referral.assert_called_once_with("new-user", "signed-referral-token", self.database)

    def test_resolve_endpoint_returns_signed_token_without_referrer_identity(self):
        code = "F" * 32
        database = FakeDatabase({("referralCodes", code): {"ownerUid": "private-owner-uid"}})
        with patch.dict("os.environ", {"DAILYFUNDED_SECRET_KEY": "test-secret-" * 4}):
            with patch("app.get_firestore", return_value=database):
                response = self.client.post("/api/referrals/resolve", json={"code": code.lower()})
            self.assertEqual(response.status_code, 200)
            result = response.get_json()
            self.assertEqual(app_module.decode_referral_token(result["referralToken"])[0], code)
        self.assertNotIn("private-owner-uid", response.get_data(as_text=True))

    def test_dashboard_returns_private_summary_without_referred_user_ids(self):
        code = "1" * 32
        database = FakeDatabase({
            ("referralCodes", code): {"ownerUid": "owner-uid"},
            ("users", "owner-uid"): {"referralCode": code},
            ("referralAttributions", "referred-private-uid"): {
                "referrerUid": "owner-uid",
                "referredUid": "referred-private-uid",
                "createdAt": datetime(2025, 1, 1, tzinfo=timezone.utc),
            },
            ("referralRewards", "referred-private-uid"): {
                "referrerUid": "owner-uid",
                "referredUid": "referred-private-uid",
                "amountCents": 1000,
                "status": "credited",
            },
            ("referralAttributions", "another-referred-uid"): {
                "referrerUid": "owner-uid",
                "referredUid": "another-referred-uid",
                "createdAt": datetime(2025, 1, 2, tzinfo=timezone.utc),
            },
            ("referralRewards", "another-referred-uid"): {
                "referrerUid": "owner-uid",
                "referredUid": "another-referred-uid",
                "amountCents": 1000,
                "status": "paid",
            },
        })
        with patch("app.firebase_auth.verify_id_token", return_value={"uid": "owner-uid"}):
            with patch("app.get_firebase_app"):
                with patch("app.get_firestore", return_value=database):
                    with patch("app.firestore.transactional", side_effect=lambda function: function):
                        response = self.client.get(
                            "/api/referrals",
                            headers={"Authorization": "Bearer test-token"},
                        )

        self.assertEqual(response.status_code, 200)
        result = response.get_json()
        self.assertEqual(result["availableCount"], 1)
        self.assertEqual(result["paidCount"], 1)
        self.assertEqual(result["availableAmountCents"], 1000)
        statuses = {entry["status"] for entry in result["history"]}
        self.assertEqual(statuses, {"available", "paid"})
        self.assertNotIn("referred-private-uid", response.get_data(as_text=True))
