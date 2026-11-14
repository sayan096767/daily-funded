import os
import re
import uuid
import hashlib
import base64
import binascii
import hmac
import secrets
import json
import math
import socket
import traceback
from io import BytesIO
from pathlib import Path
from datetime import datetime, timedelta, timezone
from decimal import Decimal, InvalidOperation
from functools import wraps

import firebase_admin
import boto3
import cloudinary
import cloudinary.utils
from firebase_admin import exceptions as firebase_exceptions
from firebase_admin import auth as firebase_auth, credentials, firestore, storage
from flask import Flask, g, jsonify, request, send_file
from google.api_core.exceptions import AlreadyExists
from botocore.config import Config
from urllib.parse import urlencode, urlsplit
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from coupon_config import COUPONS


FRONTEND_ORIGINS = {
    origin.strip().rstrip("/")
    for origin in os.environ.get("DAILYFUNDED_FRONTEND_ORIGINS", "").split(",")
    if origin.strip()
}
MAX_PROOF_BYTES = 5 * 1024 * 1024
CLOUDFLARE_PROVISIONING_TIMEOUT_SECONDS = 15
CLOUDFLARE_PROVISIONING_LEASE_SECONDS = 60
CLOUDFLARE_TRADING_TIMEOUT_SECONDS = 15
MAX_CLOUDFLARE_RESPONSE_BYTES = 64 * 1024

CATALOG = {
    "1step": {
        "label": "1-Step",
        "prices": {5000: 32, 10000: 64, 25000: 160, 50000: 320, 100000: 640, 200000: 1280},
        "rules": ["10% profit target", "5% daily drawdown", "10% max drawdown", "3 min trading days", "5 day reward cycle"],
        "profit_split": "80% profit split",
    },
    "2step": {
        "label": "2-Step",
        "prices": {5000: 27, 10000: 52, 25000: 130, 50000: 260, 100000: 520, 200000: 1040},
        "rules": ["Ph 1: 6% / Ph 2: 6%", "5% daily drawdown", "10% max drawdown", "5 min trading days", "7 day reward cycle"],
        "profit_split": "90% profit split",
    },
    "instant": {
        "label": "Instant",
        "prices": {2500: 20, 5000: 39, 10000: 78, 25000: 190, 50000: 349, 100000: 689, 200000: 1299},
        "rules": ["No profit target", "5% daily drawdown", "10% max drawdown", "0 min trading days", "Daily reward cycle"],
        "profit_split": "80% profit split",
    },
    "spark_1step": {
        "label": "Spark 1-Step",
        "product_model": "spark",
        "product_id": "MODEL_FX_SPARK_1STEP",
        "prices": {25000: 39, 50000: 59, 100000: 79},
        "profit_target_percent": 6,
        "daily_drawdown_percent": 3,
        "max_drawdown_percent": 7,
        "max_drawdown_type": "TRAILING",
        "minimum_trading_days": 5,
        "consistency_rule_percent": 30,
        "reward_cycle": "On demand",
        "rules": [
            "6% profit target", "3% [EOD] daily loss",
            "7% [EOD] max loss",
            "5 min trading days", "70% profit split", "30% consistency rule",
            "On-demand reward cycle",
        ],
        "profit_split": "70% profit split",
    },
    "spark_instant": {
        "label": "Spark Instant",
        "product_model": "spark",
        "product_id": "MODEL_FX_SPARK_INSTANT",
        "prices": {25000: 59, 50000: 79, 100000: 99},
        "profit_target_percent": None,
        "daily_drawdown_percent": 3,
        "max_drawdown_percent": 7,
        "max_drawdown_type": "TRAILING",
        "minimum_trading_days": 5,
        "consistency_rule_percent": 30,
        "reward_cycle": "On demand",
        "rules": [
            "3% [EOD] daily loss",
            "7% [EOD] max loss",
            "5 min trading days", "70% profit split", "30% consistency rule",
            "On-demand reward cycle",
        ],
        "profit_split": "70% profit split",
    },
}
NETWORKS = {
    "usdt": {"trc20", "erc20", "bep20"},
    "btc": {"btc_native", "btc_bep20"},
    "eth": {"eth_erc20", "eth_bep20"},
}
NOWPAYMENTS_API_BASE = "https://api.nowpayments.io/v1"
NOWPAYMENTS_TIMEOUT_SECONDS = 15
NOWPAYMENTS_PAYMENT_STATUSES = {
    "waiting", "confirming", "confirmed", "sending", "partially_paid",
    "finished", "failed", "refunded", "expired", "reversed",
}
TRADING_PLATFORMS = {"mt5", "ctrader", "match_trader", "cf"}
TRADING_ENGINE_MODEL_CODES = {
    "1step": "1_STEP",
    "2step": "2_STEP",
    "instant": "INSTANT",
    "spark_1step": "SPARK_1_STEP",
    "spark_instant": "SPARK_INSTANT",
}
IMAGE_SIGNATURES = (
    (b"\x89PNG\r\n\x1a\n", "png"),
    (b"\xff\xd8\xff", "jpeg"),
    (b"GIF87a", "gif"),
    (b"GIF89a", "gif"),
    (b"RIFF", "webp"),
)

app = Flask(__name__)
app.config.update(
    MAX_CONTENT_LENGTH=MAX_PROOF_BYTES + 64 * 1024,
)


@app.after_request
def add_frontend_cors_headers(response):
    origin = request.headers.get("Origin", "").rstrip("/")
    try:
        parsed_origin = urlsplit(origin)
        local_origin = (
            parsed_origin.scheme == "http"
            and parsed_origin.hostname in {"127.0.0.1", "localhost"}
            and parsed_origin.port == 5500
            and parsed_origin.username is None
            and parsed_origin.password is None
        )
    except ValueError:
        local_origin = False
    if origin in FRONTEND_ORIGINS or local_origin:
        response.headers["Access-Control-Allow-Origin"] = origin
        response.headers["Access-Control-Allow-Headers"] = "Content-Type, X-CSRF-Token, Authorization"
        response.headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS"
        response.headers.add("Vary", "Origin")
    return response


_firebase_app = None


def get_firebase_app():
    global _firebase_app
    if _firebase_app is None:
        try:
            _firebase_app = firebase_admin.get_app()
        except ValueError:
            options = {
                "projectId": os.environ.get("GOOGLE_CLOUD_PROJECT", "daily-funded"),
                "storageBucket": os.environ.get("FIREBASE_STORAGE_BUCKET", "daily-funded.firebasestorage.app"),
            }
            service_account_json = os.environ.get("FIREBASE_SERVICE_ACCOUNT_JSON")
            service_account_path = os.environ.get("FIREBASE_SERVICE_ACCOUNT_PATH")
            if service_account_json:
                try:
                    credential_info = json.loads(service_account_json)
                    credential = credentials.Certificate(credential_info)
                except (TypeError, ValueError) as error:
                    raise RuntimeError("FIREBASE_SERVICE_ACCOUNT_JSON must contain a valid service-account JSON object.") from error
            elif service_account_path:
                credential = credentials.Certificate(service_account_path)
            else:
                local_service_account = Path(__file__).with_name(
                    "daily-funded-firebase-adminsdk-fbsvc-f4528eb4b8.json"
                )
                credential = credentials.Certificate(str(local_service_account)) if local_service_account.is_file() else None

            credential_project_id = getattr(credential, "project_id", None) if service_account_json or service_account_path or local_service_account.is_file() else None
            if credential_project_id and credential_project_id != options["projectId"]:
                raise RuntimeError("Firebase Admin service-account project does not match GOOGLE_CLOUD_PROJECT.")
            _firebase_app = firebase_admin.initialize_app(credential, options=options) if credential else firebase_admin.initialize_app(options=options)
    return _firebase_app


def get_firestore():
    return firestore.client(app=get_firebase_app())


def get_storage_bucket():
    return storage.bucket(app=get_firebase_app())


def get_r2_bucket_name():
    bucket_name = os.environ.get("R2_BUCKET_NAME", "").strip()
    if not bucket_name:
        raise RuntimeError("R2_BUCKET_NAME is not configured.")
    return bucket_name


def get_r2_client():
    account_id = os.environ.get("R2_ACCOUNT_ID", "").strip()
    access_key_id = os.environ.get("R2_ACCESS_KEY_ID", "").strip()
    secret_access_key = os.environ.get("R2_SECRET_ACCESS_KEY", "").strip()
    endpoint = os.environ.get("R2_ENDPOINT", "").strip().rstrip("/")
    expected_endpoint = f"https://{account_id}.r2.cloudflarestorage.com" if account_id else ""
    if not account_id or not access_key_id or not secret_access_key or not endpoint:
        raise RuntimeError("R2 environment variables are not configured.")
    if endpoint != expected_endpoint:
        raise RuntimeError("R2_ENDPOINT does not match R2_ACCOUNT_ID.")
    return boto3.client(
        "s3",
        endpoint_url=endpoint,
        aws_access_key_id=access_key_id,
        aws_secret_access_key=secret_access_key,
        region_name="auto",
        config=Config(signature_version="s3v4"),
    )


def r2_head_object_or_none(client, bucket_name, object_key):
    try:
        return client.head_object(Bucket=bucket_name, Key=object_key)
    except Exception as error:
        response = getattr(error, "response", {})
        error_data = response.get("Error", {}) if isinstance(response, dict) else {}
        metadata = response.get("ResponseMetadata", {}) if isinstance(response, dict) else {}
        error_code = str(error_data.get("Code", ""))
        status_code = metadata.get("HTTPStatusCode")
        if error_code in {"404", "NoSuchKey", "NotFound"} or status_code == 404:
            return None
        raise


def get_cloudinary_client():
    cloud_name = os.environ.get("CLOUDINARY_CLOUD_NAME", "").strip()
    api_key = os.environ.get("CLOUDINARY_API_KEY", "").strip()
    api_secret = os.environ.get("CLOUDINARY_API_SECRET", "").strip()
    if not cloud_name or not api_key or not api_secret:
        raise RuntimeError("Legacy Cloudinary environment variables are not configured.")
    cloudinary.config(
        cloud_name=cloud_name,
        api_key=api_key,
        api_secret=api_secret,
        secure=True,
    )
    return cloudinary


def download_cloudinary_proof(public_id, version, proof_format):
    client = get_cloudinary_client()
    url = client.utils.cloudinary_url(
        public_id,
        resource_type="image",
        type="authenticated",
        version=version,
        format=proof_format,
        sign_url=True,
        secure=True,
    )[0]
    with urlopen(Request(url), timeout=20) as response:
        proof_bytes = response.read(MAX_PROOF_BYTES + 1)
    if not proof_bytes or len(proof_bytes) > MAX_PROOF_BYTES:
        raise RuntimeError("Cloudinary returned an invalid payment proof.")
    return proof_bytes


def user_document(uid):
    return get_firestore().collection("users").document(uid)


def firebase_auth_required(view):
    @wraps(view)
    def wrapped(*args, **kwargs):
        authorization = request.headers.get("Authorization", "")
        scheme, _, token = authorization.partition(" ")
        token = token.strip()
        if scheme.lower() != "bearer" or not token:
            return jsonify(error="Sign in is required."), 401
        try:
            firebase_app = get_firebase_app()
        except Exception as error:
            app.logger.error(
                "Firebase Admin authentication initialization failed (%s)",
                type(error).__name__,
            )
            return jsonify(error="Firebase Admin authentication is unavailable. Check the service-account credentials and project configuration."), 503
        try:
            claims = firebase_auth.verify_id_token(
                token,
                app=firebase_app,
                check_revoked=True,
            )
        except (
            ValueError,
            firebase_auth.InvalidIdTokenError,
            firebase_auth.UserDisabledError,
            firebase_auth.UserNotFoundError,
            firebase_exceptions.InvalidArgumentError,
        ) as error:
            app.logger.info(
                "Rejected Firebase ID token (%s)",
                type(error).__name__,
            )
            return jsonify(error="Invalid or expired Firebase ID token."), 401
        except (
            firebase_auth.CertificateFetchError,
            firebase_exceptions.UnavailableError,
            firebase_exceptions.DeadlineExceededError,
        ) as error:
            app.logger.warning(
                "Firebase ID token verification is unavailable (%s)",
                type(error).__name__,
            )
            return jsonify(error="Firebase authentication is temporarily unavailable."), 503
        except firebase_exceptions.FirebaseError as error:
            app.logger.error(
                "Firebase ID token verification failed (%s)",
                type(error).__name__,
            )
            return jsonify(error="Firebase authentication could not be completed."), 500
        except Exception as error:
            app.logger.error(
                "Unexpected Firebase ID token verification failure (%s)",
                type(error).__name__,
            )
            return jsonify(error="Firebase authentication could not be completed."), 500
        g.firebase_uid = claims["uid"]
        g.firebase_claims = claims
        return view(*args, **kwargs)

    return wrapped


def require_admin():
    claims = getattr(g, "firebase_claims", {})
    if not isinstance(claims, dict) or claims.get("admin") is not True:
        return jsonify(error="Administrator authorization is required."), 403
    return None


def firestore_json(value):
    if isinstance(value, datetime):
        if value.tzinfo is None:
            value = value.replace(tzinfo=timezone.utc)
        return value.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")
    if isinstance(value, dict):
        return {key: firestore_json(item) for key, item in value.items()}
    if isinstance(value, list):
        return [firestore_json(item) for item in value]
    return value


def is_registration_profile_complete(profile):
    if not isinstance(profile, dict):
        return False
    first_name = str(profile.get("firstName", "")).strip()
    last_name = str(profile.get("lastName", "")).strip()
    date_of_birth = str(profile.get("dateOfBirth", "")).strip()
    country = str(profile.get("country", "")).strip()
    phone = str(profile.get("phone", "")).strip()
    return bool(
        re.fullmatch(r"[A-Za-z][A-Za-z' -]{1,59}", first_name)
        and re.fullmatch(r"[A-Za-z][A-Za-z' -]{1,59}", last_name)
        and re.fullmatch(r"\d{4}-\d{2}-\d{2}", date_of_birth)
        and re.fullmatch(r"[A-Z]{2}", country)
        and re.fullmatch(r"\+[1-9]\d{7,14}", phone)
    )


REFERRAL_CODE_PATTERN = re.compile(r"[A-F0-9]{32}")
REFERRAL_REWARD_CENTS = 1000


def referral_token_signing_key():
    secret = os.environ.get("DAILYFUNDED_SECRET_KEY", "")
    if len(secret) < 32:
        raise RuntimeError("DAILYFUNDED_SECRET_KEY must contain at least 32 characters to sign referral tokens.")
    return hashlib.sha256(b"daily-funded-referral-token-v1\0" + secret.encode("utf-8")).digest()


def encode_referral_token(code):
    payload = json.dumps(
        {"code": code, "issuedAtMs": int(datetime.now(timezone.utc).timestamp() * 1000)},
        separators=(",", ":"),
    ).encode("utf-8")
    encoded_payload = base64.urlsafe_b64encode(payload).rstrip(b"=").decode("ascii")
    signature = hmac.new(
        referral_token_signing_key(),
        encoded_payload.encode("ascii"),
        hashlib.sha256,
    ).digest()
    encoded_signature = base64.urlsafe_b64encode(signature).rstrip(b"=").decode("ascii")
    return f"{encoded_payload}.{encoded_signature}"


def decode_referral_token_segment(segment):
    decoded = base64.urlsafe_b64decode(segment + "=" * (-len(segment) % 4))
    canonical_segment = base64.urlsafe_b64encode(decoded).rstrip(b"=").decode("ascii")
    if canonical_segment != segment:
        raise ValueError("Non-canonical referral token encoding.")
    return decoded


def decode_referral_token(token):
    if not isinstance(token, str) or len(token) > 2048:
        return None
    try:
        encoded_payload, encoded_signature = token.split(".")
        if (
            not re.fullmatch(r"[A-Za-z0-9_-]+", encoded_payload)
            or not re.fullmatch(r"[A-Za-z0-9_-]+", encoded_signature)
        ):
            return None
        expected_signature = hmac.new(
            referral_token_signing_key(),
            encoded_payload.encode("ascii"),
            hashlib.sha256,
        ).digest()
        supplied_signature = decode_referral_token_segment(encoded_signature)
        if not hmac.compare_digest(expected_signature, supplied_signature):
            return None
        payload = json.loads(decode_referral_token_segment(encoded_payload))
    except (ValueError, UnicodeDecodeError, UnicodeEncodeError, binascii.Error, json.JSONDecodeError):
        return None
    code = payload.get("code") if isinstance(payload, dict) else None
    issued_at_ms = payload.get("issuedAtMs") if isinstance(payload, dict) else None
    if (
        not isinstance(code, str)
        or not REFERRAL_CODE_PATTERN.fullmatch(code)
        or not isinstance(issued_at_ms, int)
        or issued_at_ms <= 0
    ):
        return None
    return code, issued_at_ms


def ensure_referral_code(uid, database):
    profile_ref = database.collection("users").document(uid)
    code_collection = database.collection("referralCodes")

    for _attempt in range(5):
        candidate = secrets.token_hex(16).upper()
        candidate_ref = code_collection.document(candidate)

        @firestore.transactional
        def create_or_reuse_code(transaction):
            profile_snapshot = profile_ref.get(transaction=transaction)
            profile = profile_snapshot.to_dict() or {}
            existing_code = profile.get("referralCode")
            if existing_code:
                if not isinstance(existing_code, str) or not REFERRAL_CODE_PATTERN.fullmatch(existing_code):
                    raise RuntimeError("The stored referral code is invalid.")
                mapping_ref = code_collection.document(existing_code)
                mapping_snapshot = mapping_ref.get(transaction=transaction)
                mapping = mapping_snapshot.to_dict() or {}
                if mapping_snapshot.exists and mapping.get("ownerUid") != uid:
                    raise RuntimeError("The stored referral code belongs to another user.")
                if not mapping_snapshot.exists:
                    transaction.create(mapping_ref, {
                        "ownerUid": uid,
                        "createdAt": firestore.SERVER_TIMESTAMP,
                    })
                return existing_code

            candidate_snapshot = candidate_ref.get(transaction=transaction)
            if candidate_snapshot.exists:
                return None
            transaction.create(candidate_ref, {
                "ownerUid": uid,
                "createdAt": firestore.SERVER_TIMESTAMP,
            })
            transaction.set(profile_ref, {"referralCode": candidate}, merge=True)
            return candidate

        code = create_or_reuse_code(database.transaction())
        if code:
            return code
    raise RuntimeError("Could not allocate a unique referral code.")


def record_referral_attribution(uid, token, database):
    if not isinstance(uid, str) or not uid.strip():
        return {"applied": False, "reason": "The account identity could not be verified. No referral was recorded."}
    decoded_token = decode_referral_token(token)
    if decoded_token is None:
        return {"applied": False, "reason": "The referral link is invalid. No referral was recorded."}
    code, issued_at_ms = decoded_token

    firebase_user = firebase_auth.get_user(uid, app=get_firebase_app())
    metadata = getattr(firebase_user, "user_metadata", None)
    created_at_ms = getattr(metadata, "creation_timestamp", None)
    if not isinstance(created_at_ms, int) or isinstance(created_at_ms, bool):
        return {"applied": False, "reason": "The account creation date could not be verified. No referral was recorded."}
    if created_at_ms <= issued_at_ms:
        return {"applied": False, "reason": "Referral links must be opened before account creation. No referral was recorded."}

    code_ref = database.collection("referralCodes").document(code)
    attribution_ref = database.collection("referralAttributions").document(uid)

    @firestore.transactional
    def create_attribution(transaction):
        code_snapshot = code_ref.get(transaction=transaction)
        code_data = code_snapshot.to_dict() or {}
        attribution_snapshot = attribution_ref.get(transaction=transaction)
        existing_attribution = attribution_snapshot.to_dict() or {}
        referrer_uid = code_data.get("ownerUid")
        if (
            not code_snapshot.exists
            or not isinstance(referrer_uid, str)
            or not referrer_uid.strip()
        ):
            return {"applied": False, "reason": "The referral code is no longer valid. No referral was recorded."}
        if referrer_uid == uid:
            return {"applied": False, "reason": "You cannot use your own referral link."}
        if attribution_snapshot.exists:
            if existing_attribution.get("referrerUid") == referrer_uid:
                return {"applied": True, "existing": True}
            return {"applied": False, "reason": "A referral is already attached to this account."}
        transaction.create(attribution_ref, {
            "referredUid": uid,
            "referrerUid": referrer_uid,
            "referralCode": code,
            "createdAt": firestore.SERVER_TIMESTAMP,
        })
        return {"applied": True, "existing": False}

    return create_attribution(database.transaction())


def firebase_user_creation_datetime(uid):
    try:
        firebase_user = firebase_auth.get_user(uid, app=get_firebase_app())
    except firebase_auth.UserNotFoundError:
        return None
    metadata = getattr(firebase_user, "user_metadata", None)
    created_at_ms = getattr(metadata, "creation_timestamp", None)
    if not isinstance(created_at_ms, int) or isinstance(created_at_ms, bool):
        return None
    return datetime.fromtimestamp(created_at_ms / 1000, tz=timezone.utc)


def award_referral_reward(transaction, database, referred_uid, purchase_id):
    attribution_ref = database.collection("referralAttributions").document(referred_uid)
    reward_ref = database.collection("referralRewards").document(referred_uid)
    attribution_snapshot = attribution_ref.get(transaction=transaction)
    reward_snapshot = reward_ref.get(transaction=transaction)
    if not attribution_snapshot.exists or reward_snapshot.exists:
        return False

    attribution = attribution_snapshot.to_dict() or {}
    referrer_uid = attribution.get("referrerUid")
    if not isinstance(referrer_uid, str) or not referrer_uid or referrer_uid == referred_uid:
        return False
    transaction.create(reward_ref, {
        "referrerUid": referrer_uid,
        "referredUid": referred_uid,
        "qualifyingPurchaseId": purchase_id,
        "amountCents": REFERRAL_REWARD_CENTS,
        "currency": "USD",
        "status": "available",
        "creditEvent": "first_approved_purchase",
        "createdAt": firestore.SERVER_TIMESTAMP,
    })
    return True


def read_json_object():
    payload = request.get_json(silent=True)
    return payload if isinstance(payload, dict) else {}


def normalize_billing_details(value):
    if not isinstance(value, str):
        raise ValueError("Billing details are required.")
    try:
        submitted = json.loads(value)
    except json.JSONDecodeError as error:
        raise ValueError("Billing details must be valid JSON.") from error
    if not isinstance(submitted, dict):
        raise ValueError("Billing details must be an object.")

    field_limits = {
        "full_name": 160,
        "email": 254,
        "phone": 32,
        "country": 2,
        "state": 100,
        "city": 100,
        "postal_code": 32,
        "address_line_1": 200,
        "address_line_2": 200,
        "company_name": 160,
        "tax_id": 64,
    }
    billing = {}
    for field, max_length in field_limits.items():
        field_value = submitted.get(field, "")
        if not isinstance(field_value, str):
            raise ValueError("Enter valid billing details.")
        billing[field] = field_value.strip()
        if len(billing[field]) > max_length:
            raise ValueError(f"{field.replace('_', ' ').capitalize()} is too long.")

    required_fields = (
        "full_name", "email", "phone", "country", "state", "city",
        "postal_code", "address_line_1",
    )
    if any(not billing[field] for field in required_fields):
        raise ValueError("Complete all required billing details.")
    if not re.fullmatch(r"[^\s@]+@[^\s@]+\.[^\s@]+", billing["email"]):
        raise ValueError("Enter a valid billing email address.")
    phone = billing["phone"]
    phone_digits = re.sub(r"\D", "", phone)
    if (
        not re.fullmatch(r"\+?[\d\s().-]+", phone)
        or not 7 <= len(phone_digits) <= 15
    ):
        raise ValueError("Enter a valid billing phone number.")
    billing["country"] = billing["country"].upper()
    if not re.fullmatch(r"[A-Z]{2}", billing["country"]):
        raise ValueError("Select a valid billing country.")
    billing["email"] = billing["email"].lower()
    return billing


def find_purchase_document(purchase_id):
    purchase_id = str(purchase_id or "").strip()
    if not purchase_id:
        return None
    for document in get_firestore().collection_group("purchases").stream():
        if document.id == purchase_id:
            return document
    return None


def purchase_status_is_pending(status):
    return status in {"pending", "pending_payment_verification"}


def calculate_purchase_amount(plan_key, size, coupon_code):
    plan = CATALOG[plan_key]
    list_price = plan["prices"][size] * 100
    normalized_coupon = str(coupon_code or "").strip().upper()
    coupon = COUPONS.get(normalized_coupon)
    if normalized_coupon and coupon is None:
        raise ValueError("Invalid coupon code.")
    discount = (
        (list_price * coupon["discount_percent"] + 50) // 100
        if coupon
        else 0
    )
    return list_price, discount, list_price - discount, (normalized_coupon if discount else None)


def coupon_redemption_ref(database, uid, coupon_code):
    return (
        database.collection("users")
        .document(uid)
        .collection("couponRedemptions")
        .document(coupon_code)
    )


def purchase_has_verified_full_coupon(purchase):
    if not isinstance(purchase, dict):
        return False
    coupon_code = purchase.get("couponCode")
    if not isinstance(coupon_code, str):
        return False
    coupon = COUPONS.get(coupon_code)
    list_price = purchase.get("listPriceCents")
    discount = purchase.get("discountCents")
    total = purchase.get("totalCents")
    return (
        isinstance(coupon, dict)
        and coupon["discount_percent"] == 100
        and purchase.get("paymentProvider") == "coupon"
        and purchase.get("paymentMethod") == "coupon"
        and purchase.get("paymentStatus") == "not_required"
        and purchase.get("couponRedemptionVerified") is True
        and purchase.get("manualReviewRequired") is not True
        and isinstance(list_price, int)
        and not isinstance(list_price, bool)
        and list_price > 0
        and isinstance(discount, int)
        and not isinstance(discount, bool)
        and discount == list_price
        and isinstance(total, int)
        and not isinstance(total, bool)
        and total == 0
    )


def purchase_response(purchase_id, purchase, status_code=201, replay=False):
    status = purchase.get("status", "pending")
    return jsonify(
        purchaseId=purchase_id,
        accountId=purchase.get("accountId"),
        status=status,
        priceCents=purchase.get("listPriceCents"),
        discountCents=purchase.get("discountCents", 0),
        totalCents=purchase.get("totalCents"),
        message="Payment submitted. Awaiting admin approval." if status == "pending" else f"Purchase status: {status}.",
        idempotentReplay=replay,
    ), status_code


def purchase_payment_allows_approval(purchase):
    if purchase.get("status") == "rejected":
        return False
    if purchase.get("paymentProvider") == "coupon":
        return purchase_has_verified_full_coupon(purchase)
    if purchase.get("paymentProvider") != "nowpayments":
        return True
    if purchase.get("paymentStatus") != "finished":
        return False
    if (
        purchase.get("settlementStatus") == "exact"
        and purchase.get("settlementVerified") is True
    ):
        return purchase.get("manualReviewRequired") is not True
    return (
        purchase.get("settlementStatus") == "overpaid"
        and purchase.get("manualReviewRequired") is True
    )


def purchase_payment_allows_auto_provisioning(purchase):
    if isinstance(purchase, dict) and purchase.get("paymentProvider") == "coupon":
        return (
            purchase.get("status") != "rejected"
            and purchase_has_verified_full_coupon(purchase)
        )
    return (
        isinstance(purchase, dict)
        and purchase.get("status") != "rejected"
        and purchase.get("paymentProvider") == "nowpayments"
        and purchase.get("paymentStatus") == "finished"
        and purchase.get("settlementStatus") == "exact"
        and purchase.get("settlementVerified") is True
        and purchase.get("manualReviewRequired") is not True
    )


def nowpayments_configuration():
    config = {
        "api_key": os.environ.get("NOWPAYMENTS_API_KEY", "").strip(),
        "ipn_secret": os.environ.get("NOWPAYMENTS_IPN_SECRET", "").strip(),
        "callback_url": os.environ.get("NOWPAYMENTS_IPN_CALLBACK_URL", "").strip(),
        "return_url": os.environ.get("NOWPAYMENTS_RETURN_URL", "").strip(),
    }
    if not all(config.values()):
        raise RuntimeError("NOWPayments server environment is not fully configured.")
    for key in ("callback_url", "return_url"):
        parsed_url = urlsplit(config[key])
        if parsed_url.scheme != "https" or not parsed_url.netloc:
            raise RuntimeError(f"NOWPayments {key} must be a public HTTPS URL.")
    return config


class NOWPaymentsRequestError(RuntimeError):
    def __init__(self, message, safe_to_retry=False):
        super().__init__(message)
        self.safe_to_retry = safe_to_retry


def nowpayments_api_request(method, path, api_key, payload=None):
    body = None
    headers = {"x-api-key": api_key, "Accept": "application/json"}
    if payload is not None:
        body = json.dumps(payload, separators=(",", ":")).encode("utf-8")
        headers["Content-Type"] = "application/json"
    api_request = Request(
        f"{NOWPAYMENTS_API_BASE}{path}",
        data=body,
        headers=headers,
        method=method,
    )
    try:
        with urlopen(api_request, timeout=NOWPAYMENTS_TIMEOUT_SECONDS) as response:
            response_body = response.read(1024 * 1024 + 1)
        if len(response_body) > 1024 * 1024:
            raise RuntimeError("NOWPayments returned an oversized response.")
        result = json.loads(response_body.decode("utf-8"))
    except HTTPError as error:
        raise NOWPaymentsRequestError(
            "NOWPayments request failed.",
            safe_to_retry=400 <= error.code < 500,
        ) from error
    except (URLError, TimeoutError, OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise NOWPaymentsRequestError("NOWPayments request failed.") from error
    if not isinstance(result, dict):
        raise RuntimeError("NOWPayments returned an invalid response.")
    return result


def nowpayments_signature_is_valid(payload, received_signature, ipn_secret):
    if not isinstance(payload, dict) or not received_signature:
        return False
    signed_body = json.dumps(
        payload,
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
    )
    expected_signature = hmac.new(
        ipn_secret.encode("utf-8"),
        signed_body.encode("utf-8"),
        hashlib.sha512,
    ).hexdigest()
    return hmac.compare_digest(expected_signature, received_signature.strip().lower())


def nowpayments_amount_matches(value, total_cents):
    try:
        amount = Decimal(str(value))
    except (InvalidOperation, TypeError, ValueError):
        return False
    return amount.is_finite() and amount == Decimal(total_cents) / Decimal(100)


def nowpayments_settlement_details(provider_payment, payment_currency):
    provider_currency = str(provider_payment.get("pay_currency", "")).strip().lower()
    if not provider_currency or provider_currency != payment_currency:
        return {"status": "currency_mismatch"}

    raw_expected = provider_payment.get("pay_amount")
    raw_received = provider_payment.get("actually_paid")
    if raw_expected is None or raw_received is None:
        return {"status": "missing"}

    try:
        expected = Decimal(str(raw_expected))
        received = Decimal(str(raw_received))
    except (InvalidOperation, TypeError, ValueError):
        return {"status": "invalid"}
    if (
        not expected.is_finite()
        or not received.is_finite()
        or expected <= 0
        or received < 0
    ):
        return {"status": "invalid"}

    if received < expected:
        status = "underpaid"
    elif received > expected:
        status = "overpaid"
    else:
        status = "exact"
    return {
        "status": status,
        "currency": provider_currency,
        "payAmount": format(expected, "f"),
        "actuallyPaid": format(received, "f"),
    }


def firebase_service_error(service_name, error):
    error_type = type(error).__name__
    return jsonify(error=f"{service_name} unavailable ({error_type}). Configure Firebase Admin credentials and verify project access."), 503


def log_referral_failure(operation, stage, error):
    stack = "".join(traceback.format_tb(error.__traceback__)).rstrip()
    signing_secret = os.environ.get("DAILYFUNDED_SECRET_KEY", "")
    if not signing_secret:
        secret_status = "missing"
    elif len(signing_secret) < 32:
        secret_status = "too_short"
    else:
        secret_status = "configured"
    app.logger.error(
        "Referral operation failed (operation=%s stage=%s exception_type=%s signing_secret_status=%s)\n%s",
        operation,
        stage,
        type(error).__name__,
        secret_status,
        stack or "No traceback available.",
    )


def referral_service_error():
    return jsonify(error="Referral service is temporarily unavailable. Please try again later."), 503


class CloudflareProvisioningError(Exception):
    def __init__(self, code, message, status_code=502, worker_status=None):
        super().__init__(message)
        self.code = code
        self.status_code = status_code
        self.worker_status = worker_status


def purchase_provisioning_values(purchase_id, purchase_data):
    if not isinstance(purchase_data, dict) or purchase_data.get("purchaseId") != purchase_id:
        raise CloudflareProvisioningError(
            "purchase_id_mismatch",
            "Purchase ID does not match its Firestore document.",
            409,
        )

    owner_uid = purchase_data.get("ownerUid")
    plan_key = purchase_data.get("planKey")
    account_id = purchase_data.get("accountId")
    account_size = purchase_data.get("accountSize")

    if not isinstance(owner_uid, str) or not owner_uid.strip():
        raise CloudflareProvisioningError("purchase_owner_missing", "Purchase owner is invalid.", 400)
    if not isinstance(plan_key, str) or plan_key not in CATALOG:
        raise CloudflareProvisioningError("purchase_plan_missing", "Purchase plan is invalid.", 400)
    if not isinstance(account_id, str) or not account_id.strip():
        raise CloudflareProvisioningError("purchase_account_missing", "Purchase account ID is invalid.", 400)
    if (
        isinstance(account_size, bool)
        or not isinstance(account_size, (int, float))
        or not math.isfinite(float(account_size))
        or float(account_size) <= 0
        or account_size not in CATALOG[plan_key]["prices"]
    ):
        raise CloudflareProvisioningError("purchase_size_invalid", "Purchase account size is invalid.", 400)

    return {
        "ownerUid": owner_uid,
        "purchaseId": purchase_id,
        "accountId": account_id,
        "planKey": plan_key,
        "accountSize": account_size,
    }


def firestore_account_matches_purchase(account_data, purchase_values):
    return isinstance(account_data, dict) and all((
        account_data.get("ownerUid") == purchase_values["ownerUid"],
        account_data.get("purchaseId") == purchase_values["purchaseId"],
        account_data.get("accountId") == purchase_values["accountId"],
        account_data.get("planKey") == purchase_values["planKey"],
        account_data.get("accountSize") == purchase_values["accountSize"],
    ))


def is_valid_trading_engine_account_id(account_id):
    return isinstance(account_id, str) and re.fullmatch(
        r"ACC_[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}",
        account_id.strip(),
    ) is not None


def cloudflare_worker_configuration():
    worker_url = os.environ.get("CLOUDFLARE_TRADING_WORKER_URL", "").strip().rstrip("/")
    token = os.environ.get("CLOUDFLARE_PROVISIONING_TOKEN", "").strip()
    if not worker_url or not token:
        raise CloudflareProvisioningError(
            "worker_configuration_missing",
            "Cloudflare provisioning is not configured.",
            503,
        )

    try:
        parsed_url = urlsplit(worker_url)
        port = parsed_url.port
    except ValueError:
        parsed_url = None
        port = None
    if (
        parsed_url is None
        or parsed_url.scheme.lower() != "https"
        or not parsed_url.hostname
        or parsed_url.username is not None
        or parsed_url.password is not None
        or parsed_url.query
        or parsed_url.fragment
        or (port is not None and not 1 <= port <= 65535)
    ):
        raise CloudflareProvisioningError(
            "worker_configuration_invalid",
            "Cloudflare provisioning URL configuration is invalid.",
            503,
        )

    return worker_url, token


def cloudflare_provisioning_log_body(response_body, token):
    body_text = response_body.decode("utf-8", errors="replace")
    if token:
        body_text = body_text.replace(token, "[REDACTED]")
    if re.search(r"(?i)\b(?:[\w-]*authorization[\w-]*|[\w-]*cookie[\w-]*|[\w-]*token[\w-]*|[\w-]*secret[\w-]*|bearer)\b", body_text):
        return "[omitted: token/header-related content]"
    return body_text[:500]


def provision_cloudflare_account(worker_url, token, provisioning_payload):
    endpoint = f"{worker_url.rstrip('/')}/accounts/from-model"
    outbound_request = Request(
        endpoint,
        data=json.dumps(provisioning_payload).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36",
            "Authorization": f"Bearer {token}",
        },
        method="POST",
    )

    app.logger.info(
        "Cloudflare provisioning request diagnostics token_present=%s token_length=%d worker_url=%s endpoint=%s",
        "CLOUDFLARE_PROVISIONING_TOKEN" in os.environ,
        len(token),
        worker_url,
        endpoint,
    )

    try:
        with urlopen(outbound_request, timeout=CLOUDFLARE_PROVISIONING_TIMEOUT_SECONDS) as response:
            worker_status = getattr(response, "status", None) or response.getcode()
            response_body = response.read(MAX_CLOUDFLARE_RESPONSE_BYTES + 1)
            app.logger.info(
                "Cloudflare provisioning response diagnostics status=%s content_type=%s body=%s",
                worker_status,
                response.headers.get("Content-Type"),
                cloudflare_provisioning_log_body(response_body, token),
            )
    except HTTPError as error:
        try:
            response_body = error.read(501)
            content_type = error.headers.get("Content-Type") if error.headers else None
            app.logger.info(
                "Cloudflare provisioning response diagnostics status=%s content_type=%s body=%s",
                error.code,
                content_type,
                cloudflare_provisioning_log_body(response_body, token),
            )
        except Exception:
            app.logger.info(
                "Cloudflare provisioning response diagnostics status=%s content_type=%s body=%s",
                error.code,
                None,
                "[unavailable]",
            )
        raise CloudflareProvisioningError(
            "worker_http_error",
            "Cloudflare provisioning returned an HTTP error.",
            502,
            error.code,
        ) from None
    except (TimeoutError, socket.timeout):
        raise CloudflareProvisioningError(
            "worker_timeout",
            "Cloudflare provisioning timed out; retry approval to reconcile.",
            504,
        ) from None
    except URLError as error:
        if isinstance(error.reason, (TimeoutError, socket.timeout)):
            raise CloudflareProvisioningError(
                "worker_timeout",
                "Cloudflare provisioning timed out; retry approval to reconcile.",
                504,
            ) from None
        raise CloudflareProvisioningError(
            "worker_network_error",
            "Cloudflare provisioning could not be reached; retry approval to reconcile.",
            502,
        ) from None
    except Exception:
        raise CloudflareProvisioningError(
            "worker_network_error",
            "Cloudflare provisioning could not be reached; retry approval to reconcile.",
            502,
        ) from None

    if worker_status not in (200, 201):
        raise CloudflareProvisioningError(
            "worker_http_error",
            "Cloudflare provisioning returned an unsuccessful HTTP status.",
            502,
            worker_status,
        )
    if len(response_body) > MAX_CLOUDFLARE_RESPONSE_BYTES:
        raise CloudflareProvisioningError(
            "worker_response_invalid",
            "Cloudflare provisioning returned an invalid response.",
            502,
            worker_status,
        )

    try:
        worker_payload = json.loads(response_body)
    except (TypeError, ValueError):
        raise CloudflareProvisioningError(
            "worker_response_invalid",
            "Cloudflare provisioning returned invalid JSON.",
            502,
            worker_status,
        ) from None

    if not isinstance(worker_payload, dict) or worker_payload.get("success") is not True:
        raise CloudflareProvisioningError(
            "worker_rejected",
            "Cloudflare provisioning did not succeed.",
            502,
            worker_status,
        )

    account = worker_payload.get("account")
    account_id = account.get("id") if isinstance(account, dict) else None
    if not is_valid_trading_engine_account_id(account_id):
        raise CloudflareProvisioningError(
            "worker_account_id_missing",
            "Cloudflare provisioning response did not include a valid account ID.",
            502,
            worker_status,
        )

    return {**account, "id": account_id.strip()}


def provisioning_lease_is_active(started_at):
    if not isinstance(started_at, datetime):
        return False
    if started_at.tzinfo is None:
        started_at = started_at.replace(tzinfo=timezone.utc)
    return started_at > datetime.now(timezone.utc) - timedelta(
        seconds=CLOUDFLARE_PROVISIONING_LEASE_SECONDS
    )


def trading_engine_account_matches_purchase(account, purchase_values):
    if not isinstance(account, dict):
        return False
    expected_model = TRADING_ENGINE_MODEL_CODES.get(purchase_values["planKey"])
    try:
        actual_size = Decimal(str(account.get("challenge_size")))
        expected_size = Decimal(str(purchase_values["accountSize"]))
    except (InvalidOperation, TypeError, ValueError):
        return False
    return (
        is_valid_trading_engine_account_id(account.get("id"))
        and account.get("user_id") == purchase_values["ownerUid"]
        and account.get("purchase_id") == purchase_values["purchaseId"]
        and account.get("model_code") == expected_model
        and actual_size.is_finite()
        and actual_size == expected_size
        and isinstance(account.get("status"), str)
        and bool(account["status"].strip())
    )


def finite_engine_number(value):
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return value if math.isfinite(value) else None


def provision_verified_purchase(purchase, database=None):
    if purchase is None:
        return {"state": "not_found"}
    database = database or get_firestore()
    purchase_id = str(purchase.reference.id)
    purchase_ref = purchase.reference
    attempt_id = str(uuid.uuid4())

    @firestore.transactional
    def claim_provisioning(transaction):
        snapshot = purchase_ref.get(transaction=transaction)
        current = snapshot.to_dict() or {}
        if not purchase_payment_allows_auto_provisioning(current):
            return {"state": "not_eligible"}

        values = purchase_provisioning_values(purchase_id, current)
        account_ref = user_document(values["ownerUid"]).collection(
            "accounts"
        ).document(values["accountId"])
        account_snapshot = account_ref.get(transaction=transaction)
        account = account_snapshot.to_dict() or {}
        if account_snapshot.exists and not firestore_account_matches_purchase(account, values):
            raise CloudflareProvisioningError(
                "firestore_account_mismatch",
                "Firestore account does not match its purchase.",
                409,
            )
        if account.get("status") == "rejected":
            return {"state": "account_rejected"}
        engine_account_id = account.get("tradingEngineAccountId")
        if (
            is_valid_trading_engine_account_id(engine_account_id)
            and account.get("status") == "active"
            and account.get("tradingEnabled") is True
        ):
            return {"state": "provisioned", "accountId": engine_account_id.strip()}
        if (
            current.get("provisioningStatus") == "in_progress"
            and provisioning_lease_is_active(current.get("provisioningStartedAt"))
        ):
            return {"state": "in_progress"}

        if current.get("status") != "approved":
            if current.get("paymentProvider") != "coupon":
                award_referral_reward(
                    transaction,
                    database,
                    values["ownerUid"],
                    values["purchaseId"],
                )

        account_fields = {
            "ownerUid": values["ownerUid"],
            "userUid": values["ownerUid"],
            "purchaseId": values["purchaseId"],
            "accountId": values["accountId"],
            "planKey": values["planKey"],
            "accountSize": values["accountSize"],
            "phase": "instant" if values["planKey"] in {"instant", "spark_instant"} else "phase_1",
            "status": "pending_provisioning",
            "provisioningStatus": "pending",
            "tradingEnabled": False,
            "balance": None,
            "equity": None,
            "profit": None,
            "dailyDrawdown": None,
            "overallDrawdown": None,
            "tradingDays": None,
            "updatedAt": firestore.SERVER_TIMESTAMP,
        }
        if account_snapshot.exists:
            transaction.update(account_ref, account_fields)
        else:
            account_fields["createdAt"] = current.get("createdAt") or firestore.SERVER_TIMESTAMP
            transaction.set(account_ref, account_fields)
        transaction.update(purchase_ref, {
            "status": "approved",
            "approvalSource": "automatic_coupon"
            if current.get("paymentProvider") == "coupon"
            else "automatic_nowpayments",
            "approvedAt": current.get("approvedAt") or firestore.SERVER_TIMESTAMP,
            "provisioningStatus": "in_progress",
            "provisioningAttemptId": attempt_id,
            "provisioningStartedAt": firestore.SERVER_TIMESTAMP,
            "provisioningErrorCode": None,
            "updatedAt": firestore.SERVER_TIMESTAMP,
        })
        return {
            "state": "claimed",
            "attemptId": attempt_id,
            "purchaseValues": values,
            "accountRef": account_ref,
            "existingEngineAccountId": (
                engine_account_id.strip()
                if is_valid_trading_engine_account_id(engine_account_id)
                else None
            ),
        }

    try:
        claim = claim_provisioning(database.transaction())
    except CloudflareProvisioningError as error:
        app.logger.error(
            "Could not claim trading account provisioning for purchase %s (%s)",
            purchase_id,
            error.code,
        )
        return {"state": "pending", "code": error.code}
    except Exception as error:
        app.logger.exception(
            "Could not claim trading account provisioning for purchase %s (%s)",
            purchase_id,
            type(error).__name__,
        )
        return {"state": "pending", "code": "firestore_unavailable"}
    if claim["state"] != "claimed":
        return claim

    values = claim["purchaseValues"]
    try:
        worker_url, provisioning_token = cloudflare_worker_configuration()
        worker_account = provision_cloudflare_account(
            worker_url,
            provisioning_token,
            {
                "user_id": values["ownerUid"],
                "purchase_id": values["purchaseId"],
                "plan_key": values["planKey"],
                "account_size": values["accountSize"],
            },
        )
        if not trading_engine_account_matches_purchase(worker_account, values):
            raise CloudflareProvisioningError(
                "worker_account_mismatch",
                "Trading engine returned an account for a different purchase.",
            )
    except CloudflareProvisioningError as error:
        failure_code = error.code
    except Exception as error:
        app.logger.exception(
            "Trading account provisioning failed for purchase %s (%s)",
            purchase_id,
            type(error).__name__,
        )
        failure_code = "worker_unavailable"
    else:
        failure_code = None

    if failure_code is not None:
        @firestore.transactional
        def mark_provisioning_pending(transaction):
            current = purchase_ref.get(transaction=transaction).to_dict() or {}
            if (
                current.get("provisioningAttemptId") != attempt_id
                or current.get("status") == "rejected"
            ):
                return False
            account_snapshot = claim["accountRef"].get(transaction=transaction)
            account = account_snapshot.to_dict() or {}
            if account_snapshot.exists and not firestore_account_matches_purchase(account, values):
                return False
            transaction.update(purchase_ref, {
                "provisioningStatus": "pending",
                "provisioningErrorCode": failure_code,
                "updatedAt": firestore.SERVER_TIMESTAMP,
            })
            if account_snapshot.exists and not (
                is_valid_trading_engine_account_id(account.get("tradingEngineAccountId"))
                and account.get("status") == "active"
                and account.get("tradingEnabled") is True
            ):
                transaction.update(claim["accountRef"], {
                    "status": "pending_provisioning",
                    "provisioningStatus": "pending",
                    "provisioningErrorCode": failure_code,
                    "tradingEnabled": False,
                    "updatedAt": firestore.SERVER_TIMESTAMP,
                })
            return True

        try:
            mark_provisioning_pending(database.transaction())
        except Exception as error:
            app.logger.exception(
                "Could not record pending trading account provisioning for purchase %s (%s)",
                purchase_id,
                type(error).__name__,
            )
        return {"state": "pending", "code": failure_code}

    engine_account_id = worker_account["id"].strip()
    engine_status = worker_account["status"].strip().lower()
    phase_number = worker_account.get("phase_number")
    if not isinstance(phase_number, int) or isinstance(phase_number, bool) or phase_number < 1:
        phase_number = 1

    @firestore.transactional
    def save_provisioned_account(transaction):
        current = purchase_ref.get(transaction=transaction).to_dict() or {}
        if (
            current.get("provisioningAttemptId") != attempt_id
            or not purchase_payment_allows_auto_provisioning(current)
        ):
            return "purchase_changed"
        current_values = purchase_provisioning_values(purchase_id, current)
        if current_values != values:
            return "purchase_changed"
        account_snapshot = claim["accountRef"].get(transaction=transaction)
        account = account_snapshot.to_dict() or {}
        if (
            not account_snapshot.exists
            or not firestore_account_matches_purchase(account, values)
        ):
            return "account_mismatch"
        saved_id = account.get("tradingEngineAccountId")
        if is_valid_trading_engine_account_id(saved_id) and saved_id.strip() != engine_account_id:
            return "engine_account_mismatch"

        account_updates = {
            "tradingEngineAccountId": engine_account_id,
            "status": engine_status,
            "tradingStatus": engine_status,
            "provisioningStatus": "provisioned",
            "provisioningErrorCode": None,
            "tradingEnabled": engine_status == "active",
            "phase": "instant" if values["planKey"] in {"instant", "spark_instant"} else f"phase_{phase_number}",
            "phaseNumber": phase_number,
            "phaseName": worker_account.get("phase_name") if isinstance(worker_account.get("phase_name"), str) else None,
            "updatedAt": firestore.SERVER_TIMESTAMP,
        }
        for field in ("starting_balance", "balance", "equity"):
            normalized = finite_engine_number(worker_account.get(field))
            if normalized is not None:
                account_updates[
                    "balance" if field == "starting_balance" else field
                ] = normalized
        transaction.update(claim["accountRef"], account_updates)
        transaction.update(purchase_ref, {
            "provisioningStatus": "provisioned",
            "provisioningErrorCode": None,
            "tradingEngineAccountId": engine_account_id,
            "provisioningCompletedAt": firestore.SERVER_TIMESTAMP,
            "updatedAt": firestore.SERVER_TIMESTAMP,
        })
        return "saved"

    try:
        save_result = save_provisioned_account(database.transaction())
    except Exception as error:
        app.logger.exception(
            "Could not save trading account provisioning for purchase %s (%s)",
            purchase_id,
            type(error).__name__,
        )
        save_result = "save_failed"
    if save_result != "saved":
        return {"state": "pending", "code": save_result}
    return {
        "state": "provisioned",
        "accountId": engine_account_id,
        "tradingStatus": engine_status,
    }


class CloudflareTradingApiError(Exception):
    def __init__(self, code, message, status_code=502, worker_status=None):
        super().__init__(message)
        self.code = code
        self.status_code = status_code
        self.worker_status = worker_status


WORKER_TRADING_ERRORS = {
    "trading_disabled": ("Trading is disabled for this account.", 409),
    "market_unavailable": ("Current market data is unavailable. No order was placed.", 503),
    "protection_unavailable": (
        "The server-side protection feed is unavailable. No position was opened.",
        503,
    ),
    "protection_state_sync_failed": (
        "The Worker may already have opened the position, but protection state synchronization failed. "
        "Do not retry until the position status is checked.",
        503,
    ),
    "stale_quote": ("The market quote is stale or the market is closed. No order was placed.", 409),
    "invalid_volume": ("The order volume is invalid for this symbol or account.", 400),
    "invalid_tp": ("Take profit must be valid and on the correct side of entry.", 400),
    "invalid_sl": ("Stop loss must be valid and on the correct side of entry.", 400),
    "insufficient_margin": ("There is not enough available margin for this order.", 409),
    "rule_violation": ("The order violates this account's trading rules.", 400),
    "position_not_found": ("Position not found or not available to this user.", 404),
    "unauthorized_action": ("This action is not authorized.", 403),
    "invalid_order_type": ("Only market orders are currently supported.", 400),
}

SENSITIVE_WORKER_ERROR_TEXT = re.compile(
    r"\b(?:authorization|bearer|token|secret|password|credential|api[_ -]?key|cookie)\b",
    re.IGNORECASE,
)
OPAQUE_WORKER_ERROR_TEXT = re.compile(r"\b[A-Za-z0-9_-]{24,}\b")
WORKER_ERROR_CODE = re.compile(r"^[a-z][a-z0-9_]{0,63}$")
WORKER_POSITION_ID = re.compile(r"^POS_[A-Za-z0-9_-]{1,120}$")


def sanitize_worker_error_code(value):
    if not isinstance(value, str) or not WORKER_ERROR_CODE.fullmatch(value):
        return None
    if SENSITIVE_WORKER_ERROR_TEXT.search(value.replace("_", " ")):
        return None
    return value


def sanitize_worker_error_message(value):
    if not isinstance(value, str):
        return None
    message = " ".join(value.split()).strip()
    if (
        not message
        or len(message) > 240
        or SENSITIVE_WORKER_ERROR_TEXT.search(message)
        or OPAQUE_WORKER_ERROR_TEXT.search(message)
        or not re.fullmatch(r"[A-Za-z][A-Za-z .,;:()'!?/-]{0,239}", message)
    ):
        return None
    return message


def cloudflare_worker_http_error(status, response_body):
    try:
        payload = json.loads(response_body)
    except (TypeError, ValueError):
        payload = {}
    if not isinstance(payload, dict):
        payload = {}

    upstream_code = payload.get("code")
    upstream_status = status if isinstance(status, int) and 400 <= status <= 599 else 502
    safe_position_id = payload.get("position_id")
    if (
        not isinstance(safe_position_id, str)
        or not WORKER_POSITION_ID.fullmatch(safe_position_id)
    ):
        safe_position_id = None

    if isinstance(upstream_code, str) and upstream_code in WORKER_TRADING_ERRORS:
        message, public_status = WORKER_TRADING_ERRORS[upstream_code]
        if upstream_code == "protection_unavailable":
            message = sanitize_worker_error_message(payload.get("error")) or message
        error = CloudflareTradingApiError(
            upstream_code,
            message,
            public_status,
            upstream_status,
        )
        error.include_upstream_status = upstream_code in {
            "protection_unavailable",
            "protection_state_sync_failed",
        }
        error.position_id = (
            safe_position_id
            if upstream_code == "protection_state_sync_failed"
            else None
        )
        return error

    safe_code = sanitize_worker_error_code(upstream_code)
    safe_message = sanitize_worker_error_message(payload.get("error"))
    error = CloudflareTradingApiError(
        safe_code or "worker_http_error",
        safe_message or "Cloudflare trading API could not process the request.",
        upstream_status,
        upstream_status,
    )
    error.include_upstream_status = True
    return error


def resolve_trading_engine_account_for_user(firebase_uid, firestore_account_id):
    if not isinstance(firebase_uid, str) or not firebase_uid.strip():
        raise CloudflareTradingApiError(
            "authenticated_uid_missing",
            "Authenticated user identity is unavailable.",
            401,
        )
    if not isinstance(firestore_account_id, str) or not firestore_account_id.strip():
        raise CloudflareTradingApiError(
            "account_id_required",
            "account_id is required.",
            400,
        )

    try:
        account_ref = user_document(firebase_uid).collection("accounts").document(
            firestore_account_id.strip()
        )
        account_snapshot = account_ref.get()
        account = account_snapshot.to_dict() or {} if account_snapshot.exists else {}
    except Exception:
        raise CloudflareTradingApiError(
            "account_lookup_failed",
            "Account service is unavailable.",
            503,
        ) from None

    if not account_snapshot.exists:
        raise CloudflareTradingApiError(
            "trading_account_not_found",
            "Trading account not found.",
            404,
        )
    if not isinstance(account, dict) or account.get("ownerUid") != firebase_uid:
        raise CloudflareTradingApiError(
            "trading_account_not_found",
            "Trading account not found.",
            404,
        )
    if account.get("status") != "active" or account.get("tradingEnabled") is not True:
        raise CloudflareTradingApiError(
            "trading_disabled",
            "Trading is not enabled for an active account.",
            409,
        )

    trading_engine_account_id = account.get("tradingEngineAccountId")
    if not is_valid_trading_engine_account_id(trading_engine_account_id):
        raise CloudflareTradingApiError(
            "trading_account_unavailable",
            "Trading account is not available.",
            409,
        )
    return trading_engine_account_id.strip()


def cloudflare_trading_worker_configuration():
    worker_url = os.environ.get("CLOUDFLARE_TRADING_WORKER_URL", "").strip().rstrip("/")
    token = os.environ.get("CLOUDFLARE_TRADING_API_TOKEN", "").strip()
    if not worker_url or not token:
        raise CloudflareTradingApiError(
            "worker_configuration_missing",
            "Cloudflare trading API is not configured.",
            503,
        )

    try:
        parsed_url = urlsplit(worker_url)
        port = parsed_url.port
    except ValueError:
        parsed_url = None
        port = None
    if (
        parsed_url is None
        or parsed_url.scheme.lower() != "https"
        or not parsed_url.hostname
        or parsed_url.username is not None
        or parsed_url.password is not None
        or parsed_url.query
        or parsed_url.fragment
        or (port is not None and not 1 <= port <= 65535)
    ):
        raise CloudflareTradingApiError(
            "worker_configuration_invalid",
            "Cloudflare trading API URL configuration is invalid.",
            503,
        )

    return worker_url, token


def call_cloudflare_trading_worker(worker_path, payload=None, method="POST", query=None):
    if not isinstance(worker_path, str) or not worker_path.startswith("/"):
        raise CloudflareTradingApiError(
            "worker_path_invalid",
            "Cloudflare trading API path is invalid.",
            500,
        )
    method = str(method).upper()
    if method not in {"GET", "POST"}:
        raise CloudflareTradingApiError(
            "worker_method_invalid",
            "Cloudflare trading API method is invalid.",
            500,
        )

    try:
        user_uid = g.firebase_uid
    except (AttributeError, RuntimeError):
        user_uid = None
    if not isinstance(user_uid, str) or not user_uid.strip():
        raise CloudflareTradingApiError(
            "authenticated_uid_missing",
            "Authenticated user identity is unavailable.",
            401,
        )

    worker_url, token = cloudflare_trading_worker_configuration()
    worker_payload = dict(payload) if isinstance(payload, dict) else {}
    for identity_field in ("user_id", "uid", "ownerUid", "owner_uid"):
        worker_payload.pop(identity_field, None)

    endpoint = f"{worker_url}/{worker_path.lstrip('/')}"
    query_values = {
        key: value
        for key, value in (query or {}).items()
        if key == "account_id" and value is not None
    }
    if query_values:
        endpoint = f"{endpoint}?{urlencode(query_values)}"

    outbound_request = Request(
        endpoint,
        data=json.dumps(worker_payload).encode("utf-8") if method == "POST" else None,
        headers={
            "Authorization": f"Bearer {token}",
            "X-Authenticated-User-Uid": user_uid.strip(),
            "Content-Type": "application/json",
            "User-Agent": "DailyFundedTradingService/1.0",
        },
        method=method,
    )

    try:
        with urlopen(outbound_request, timeout=CLOUDFLARE_TRADING_TIMEOUT_SECONDS) as response:
            worker_status = getattr(response, "status", None) or response.getcode()
            response_body = response.read(MAX_CLOUDFLARE_RESPONSE_BYTES + 1)
    except HTTPError as error:
        try:
            upstream_body = error.read(MAX_CLOUDFLARE_RESPONSE_BYTES + 1)
        except OSError:
            upstream_body = b""
        if len(upstream_body) > MAX_CLOUDFLARE_RESPONSE_BYTES:
            upstream_body = b""
        raise cloudflare_worker_http_error(error.code, upstream_body) from None
    except (TimeoutError, socket.timeout):
        raise CloudflareTradingApiError(
            "worker_timeout",
            "Cloudflare trading API timed out.",
            504,
        ) from None
    except URLError as error:
        if isinstance(error.reason, (TimeoutError, socket.timeout)):
            raise CloudflareTradingApiError(
                "worker_timeout",
                "Cloudflare trading API timed out.",
                504,
            ) from None
        raise CloudflareTradingApiError(
            "worker_network_error",
            "Cloudflare trading API could not be reached.",
            502,
        ) from None
    except Exception:
        raise CloudflareTradingApiError(
            "worker_network_error",
            "Cloudflare trading API could not be reached.",
            502,
        ) from None

    if worker_status < 200 or worker_status >= 300:
        raise cloudflare_worker_http_error(worker_status, response_body)
    if len(response_body) > MAX_CLOUDFLARE_RESPONSE_BYTES:
        raise CloudflareTradingApiError(
            "worker_response_invalid",
            "Cloudflare trading API returned an invalid response.",
            502,
            worker_status,
        )

    try:
        worker_payload = json.loads(response_body)
    except (TypeError, ValueError):
        raise CloudflareTradingApiError(
            "worker_response_invalid",
            "Cloudflare trading API returned invalid JSON.",
            502,
            worker_status,
        ) from None

    if not isinstance(worker_payload, dict) or worker_payload.get("success") is not True:
        raise CloudflareTradingApiError(
            "worker_rejected",
            "Cloudflare trading API did not succeed.",
            502,
            worker_status,
        )

    return worker_payload, worker_status


def cloudflare_trading_proxy_response(worker_path, method="GET", payload=None, query=None):
    try:
        firebase_uid = getattr(g, "firebase_uid", None)
        if isinstance(payload, dict) and "account_id" in payload:
            payload = {
                **payload,
                "account_id": resolve_trading_engine_account_for_user(
                    firebase_uid,
                    payload["account_id"],
                ),
            }
        if isinstance(query, dict) and "account_id" in query:
            query = {
                **query,
                "account_id": resolve_trading_engine_account_for_user(
                    firebase_uid,
                    query["account_id"],
                ),
            }
        worker_payload, worker_status = call_cloudflare_trading_worker(
            worker_path,
            payload=payload,
            method=method,
            query=query,
        )
    except CloudflareTradingApiError as error:
        response = {
            "success": False,
            "error": str(error),
            "code": error.code,
        }
        if getattr(error, "include_upstream_status", False):
            response["upstream_status"] = error.worker_status
        if error.code == "protection_state_sync_failed":
            response["position_may_be_open"] = True
            position_id = getattr(error, "position_id", None)
            if position_id:
                response["position_id"] = position_id
        return jsonify(response), error.status_code

    return jsonify(worker_payload), worker_status


def filtered_trading_request_payload(allowed_fields):
    body = request.get_json(silent=True)
    if not isinstance(body, dict):
        return None
    return {field: body[field] for field in allowed_fields if field in body}


@app.errorhandler(413)
def request_too_large(_error):
    return jsonify(error="Payment proof must be no larger than 5 MB."), 413


@app.get("/healthz")
def health_check():
    return jsonify(status="ok")


@app.post("/api/referrals/resolve")
def resolve_referral():
    payload = read_json_object()
    code = str(payload.get("code", "")).strip().upper()
    if not REFERRAL_CODE_PATTERN.fullmatch(code):
        return jsonify(error="That referral link is not valid."), 404
    stage = "firestore_initialization"
    try:
        database = get_firestore()
        stage = "referral_code_lookup"
        code_snapshot = database.collection("referralCodes").document(code).get()
        code_data = code_snapshot.to_dict() or {}
        if not code_snapshot.exists or not isinstance(code_data.get("ownerUid"), str):
            return jsonify(error="That referral link is not valid."), 404
        stage = "token_signing"
        referral_token = encode_referral_token(code)
        return jsonify(referralToken=referral_token)
    except Exception as error:
        log_referral_failure("resolve", stage, error)
        return referral_service_error()


@app.post("/api/auth/register")
@firebase_auth_required
def register():
    payload = read_json_object()
    email = str(g.firebase_claims.get("email", "")).strip().lower()
    first_name = str(payload.get("firstName", "")).strip()
    last_name = str(payload.get("lastName", "")).strip()
    date_of_birth = str(payload.get("dateOfBirth", "")).strip()
    country = str(payload.get("country", "")).strip().upper()
    phone = str(payload.get("phone", "")).strip()
    if not re.fullmatch(r"[^\s@]+@[^\s@]+\.[^\s@]+", email) or len(email) > 254:
        return jsonify(error="Enter a valid email address."), 400
    if not re.fullmatch(r"[A-Za-z][A-Za-z' -]{1,59}", first_name) or not re.fullmatch(r"[A-Za-z][A-Za-z' -]{1,59}", last_name):
        return jsonify(error="Enter a valid first and last name."), 400
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", date_of_birth):
        return jsonify(error="Enter a valid date of birth."), 400
    if not re.fullmatch(r"[A-Z]{2}", country):
        return jsonify(error="Select a valid country."), 400
    if not re.fullmatch(r"\+[1-9]\d{7,14}", phone):
        return jsonify(error="Enter a valid mobile number with country code."), 400
    profile_ref = user_document(g.firebase_uid)
    existing_profile = profile_ref.get()
    profile = {
        "email": email,
        "firstName": first_name,
        "lastName": last_name,
        "dateOfBirth": date_of_birth,
        "country": country,
        "phone": phone,
        "updatedAt": firestore.SERVER_TIMESTAMP,
    }
    if not existing_profile.exists:
        profile["createdAt"] = firestore.SERVER_TIMESTAMP
    profile_ref.set(profile, merge=True)
    result = {"authenticated": True, "uid": g.firebase_uid, "email": email}
    referral_token = payload.get("referralToken")
    if referral_token:
        stage = "firestore_initialization"
        try:
            database = get_firestore()
            stage = "attribution_processing"
            result["referral"] = record_referral_attribution(
                g.firebase_uid,
                referral_token,
                database,
            )
        except Exception as error:
            log_referral_failure("registration", stage, error)
            return referral_service_error()
    return jsonify(result), 201


@app.post("/api/auth/login")
def login():
    return jsonify(error="Sign in directly with Firebase Authentication."), 410


@app.post("/api/auth/password-reset")
def request_password_reset():
    return jsonify(error="Request password resets through Firebase Authentication."), 410


@app.post("/api/auth/password-reset/confirm")
def confirm_password_reset():
    return jsonify(error="Confirm password resets through Firebase Authentication."), 410


@app.post("/api/auth/logout")
def logout():
    return jsonify(error="Sign out directly with Firebase Authentication."), 410


@app.get("/api/auth/me")
@firebase_auth_required
def auth_status():
    uid = g.firebase_uid
    try:
        profile_ref = user_document(uid)
        profile_snapshot = profile_ref.get()
        profile = profile_snapshot.to_dict() or {}
        purchase_documents = list(profile_ref.collection("purchases").limit(5).stream())
        account_documents = list(profile_ref.collection("accounts").limit(1).stream())
        has_existing_records = bool(purchase_documents or account_documents)

        if not profile_snapshot.exists:
            claims = g.firebase_claims
            verified_email = claims.get("email") if claims.get("email_verified") is True else None
            recovered_profile = {
                "createdAt": firestore.SERVER_TIMESTAMP,
                "updatedAt": firestore.SERVER_TIMESTAMP,
            }
            if isinstance(verified_email, str) and re.fullmatch(r"[^\s@]+@[^\s@]+\.[^\s@]+", verified_email.strip()):
                recovered_profile["email"] = verified_email.strip().lower()
            display_name = None
            for purchase_document in purchase_documents:
                purchase = purchase_document.to_dict() or {}
                if purchase.get("ownerUid") != uid:
                    continue
                if not recovered_profile.get("email"):
                    stored_email = purchase.get("userEmail")
                    if isinstance(stored_email, str) and re.fullmatch(r"[^\s@]+@[^\s@]+\.[^\s@]+", stored_email.strip()):
                        recovered_profile["email"] = stored_email.strip().lower()
                stored_name = purchase.get("username")
                if isinstance(stored_name, str) and stored_name.strip():
                    display_name = stored_name.strip()
                    break
            if not display_name:
                display_name = claims.get("name")
            if isinstance(display_name, str) and display_name.strip():
                recovered_profile["displayName"] = display_name.strip()
            try:
                profile_ref.create(recovered_profile)
                profile = {key: value for key, value in recovered_profile.items() if key not in {"createdAt", "updatedAt"}}
            except AlreadyExists:
                profile = profile_ref.get().to_dict() or {}

        email = g.firebase_claims.get("email") or profile.get("email")
        registration_complete = (
            is_registration_profile_complete(profile)
            or has_existing_records
        )
        return jsonify(
            authenticated=True,
            uid=uid,
            email=email,
            profile=firestore_json(profile),
            registrationComplete=registration_complete,
        )
    except Exception as error:
        app.logger.exception("Could not load authenticated user profile")
        return firebase_service_error("Firestore", error)


@app.get("/api/referrals")
@firebase_auth_required
def referral_dashboard():
    uid = g.firebase_uid
    stage = "firestore_initialization"
    try:
        database = get_firestore()
        stage = "referral_code_persistence"
        code = ensure_referral_code(uid, database)
        stage = "attribution_query"
        attribution_documents = list(
            database.collection("referralAttributions")
            .where("referrerUid", "==", uid)
            .stream()
        )
        stage = "reward_query"
        reward_documents = list(
            database.collection("referralRewards")
            .where("referrerUid", "==", uid)
            .stream()
        )
        stage = "referral_activity_profile_lookup"
        referred_users = {}
        for document in attribution_documents:
            attribution = document.to_dict() or {}
            referred_uid = attribution.get("referredUid")
            if (
                attribution.get("referrerUid") != uid
                or referred_uid != document.id
                or referred_uid in referred_users
            ):
                continue
            referred_users[referred_uid] = {
                "attribution": attribution,
                "profile": {},
                "purchases": [],
            }

        activity_users = dict(
            sorted(
                referred_users.items(),
                key=lambda item: str(
                    firestore_json(item[1]["attribution"].get("createdAt")) or ""
                ),
                reverse=True,
            )[:100]
        )
        for referred_uid, activity in activity_users.items():
            user_ref = database.collection("users").document(referred_uid)
            profile_snapshot = user_ref.get()
            activity["profile"] = profile_snapshot.to_dict() or {}
            activity["createdAt"] = firebase_user_creation_datetime(referred_uid)
            activity["purchases"] = [
                (purchase_document.id, purchase_document.to_dict() or {})
                for purchase_document in user_ref.collection("purchases").stream()
            ]
    except Exception as error:
        log_referral_failure("dashboard", stage, error)
        return referral_service_error()

    rewards_by_referred_uid = {}
    for document in reward_documents:
        reward = document.to_dict() or {}
        if (
            document.id in referred_users
            and reward.get("referrerUid") == uid
            and reward.get("referredUid") == document.id
        ):
            rewards_by_referred_uid[document.id] = reward

    history = []
    for referred_uid, activity in activity_users.items():
        reward = rewards_by_referred_uid.get(referred_uid)
        reward_status = reward.get("status") if reward else None
        if reward_status == "credited":
            reward_status = "available"
        reward_amount_cents = (
            reward.get("amountCents")
            if reward
            and isinstance(reward.get("amountCents"), int)
            and not isinstance(reward.get("amountCents"), bool)
            and reward.get("amountCents") >= 0
            else None
        )
        purchase_documents = [
            (purchase_id, purchase)
            for purchase_id, purchase in activity["purchases"]
            if purchase.get("ownerUid") in {None, referred_uid}
        ]
        qualifying_purchase_id = reward.get("qualifyingPurchaseId") if reward else None
        purchase = next(
            (
                purchase_data
                for purchase_id, purchase_data in purchase_documents
                if purchase_id == qualifying_purchase_id
            ),
            None,
        )
        if purchase is None and purchase_documents:
            purchase_documents.sort(
                key=lambda item: (
                    str(firestore_json(item[1].get("createdAt")) or ""),
                    item[0],
                ),
                reverse=True,
            )
            purchase = purchase_documents[0][1]

        purchase_status = "no_purchase"
        if purchase is not None:
            stored_purchase_status = purchase.get("status")
            if stored_purchase_status == "approved":
                purchase_status = "approved"
            elif (
                isinstance(stored_purchase_status, str)
                and purchase_status_is_pending(stored_purchase_status)
            ):
                purchase_status = "pending"
            elif stored_purchase_status in {"rejected", "payment_rejected"}:
                purchase_status = "rejected"
            else:
                purchase_status = "unknown"
        elif (
            reward
            and qualifying_purchase_id
            and reward.get("creditEvent") == "first_approved_purchase"
        ):
            purchase_status = "approved"

        profile = activity["profile"]
        display_name = str(profile.get("displayName") or "").strip()
        if not display_name:
            display_name = " ".join(
                part
                for part in (
                    str(profile.get("firstName") or "").strip(),
                    str(profile.get("lastName") or "").strip(),
                )
                if part
            )
        if "@" in display_name:
            display_name = ""
        history.append({
            "displayName": display_name or None,
            "createdAt": firestore_json(
                activity["attribution"].get("createdAt")
            ),
            "accountCreatedAt": firestore_json(activity.get("createdAt")),
            "purchaseStatus": purchase_status,
            "status": reward_status if reward else "awaiting_first_approved_purchase",
            "amountCents": reward_amount_cents,
        })
    history.sort(key=lambda entry: str(firestore_json(entry.get("createdAt")) or ""), reverse=True)
    earned_statuses = {"available", "credited", "reserved", "paid"}
    qualified_count = len(rewards_by_referred_uid)
    total_earnings_cents = sum(
        reward["amountCents"]
        for reward in rewards_by_referred_uid.values()
        if reward.get("status") in earned_statuses
        and isinstance(reward.get("amountCents"), int)
        and not isinstance(reward.get("amountCents"), bool)
        and reward["amountCents"] >= 0
    )
    available_amount_cents = sum(
        reward.get("amountCents", 0)
        for reward in rewards_by_referred_uid.values()
        if isinstance(reward.get("amountCents"), int)
        and not isinstance(reward.get("amountCents"), bool)
        and reward.get("amountCents") >= 0
        and reward.get("status") in {"available", "credited"}
    )
    paid_count = sum(
        reward.get("status") == "paid"
        for reward in rewards_by_referred_uid.values()
    )
    paid_amount_cents = sum(
        reward["amountCents"]
        for reward in rewards_by_referred_uid.values()
        if reward.get("status") == "paid"
        and isinstance(reward.get("amountCents"), int)
        and not isinstance(reward.get("amountCents"), bool)
        and reward["amountCents"] >= 0
    )
    return jsonify(
        referralCode=code,
        invitedCount=len(referred_users),
        qualifiedCount=qualified_count,
        pendingReferralCount=len(referred_users) - qualified_count,
        totalEarningsAmountCents=total_earnings_cents,
        pendingRewardsTracked=False,
        pendingRewardCount=None,
        pendingRewardAmountCents=None,
        availableCount=sum(
            reward.get("status") in {"available", "credited"}
            for reward in rewards_by_referred_uid.values()
        ),
        paidCount=paid_count,
        availableAmountCents=available_amount_cents,
        paidAmountCents=paid_amount_cents,
        history=history,
    )


@app.get("/api/accounts")
@app.get("/api/my/accounts")
@firebase_auth_required
def list_accounts():
    account_documents = user_document(g.firebase_uid).collection("accounts").order_by(
        "createdAt", direction=firestore.Query.DESCENDING
    ).stream()
    accounts = []
    for document in account_documents:
        row = document.to_dict() or {}
        plan_key = row.get("planKey", "")
        plan = CATALOG.get(plan_key, {"label": "Unknown", "rules": [], "profit_split": ""})
        accounts.append({
            "id": document.id,
            "accountId": row.get("accountId", document.id),
            "purchaseId": row.get("purchaseId"),
            "tradingEngineAccountId": row.get("tradingEngineAccountId"),
            "label": plan["label"],
            "plan": plan_key,
            "size": row.get("accountSize"),
            "phase": row.get("phase"),
            "phaseNumber": row.get("phaseNumber"),
            "phaseName": row.get("phaseName"),
            "status": row.get("status"),
            "provisioningStatus": row.get("provisioningStatus"),
            "tradingStatus": row.get("tradingStatus", row.get("status")),
            "balance": row.get("balance"),
            "equity": row.get("equity"),
            "profit": row.get("profit"),
            "dailyDrawdown": row.get("dailyDrawdown"),
            "overallDrawdown": row.get("overallDrawdown"),
            "tradingDays": row.get("tradingDays"),
            "tradingEnabled": row.get("tradingEnabled") is True,
            "withdrawableProfit": row.get("withdrawableProfit"),
            "createdAt": row.get("createdAt"),
            "rules": plan["rules"],
            "profitSplit": plan["profit_split"],
        })
    return jsonify(firestore_json(accounts))


@app.post("/api/my/purchases/<purchase_id>/provision")
@firebase_auth_required
def retry_my_purchase_provisioning(purchase_id):
    purchase = find_purchase_document(purchase_id)
    if purchase is None:
        return jsonify(error="Purchase not found."), 404
    purchase_data = purchase.to_dict() or {}
    if purchase_data.get("ownerUid") != g.firebase_uid:
        return jsonify(error="Purchase not found."), 404
    if not purchase_payment_allows_auto_provisioning(purchase_data):
        return jsonify(error="This purchase is not eligible for automatic provisioning."), 409

    result = provision_verified_purchase(purchase)
    if result["state"] == "pending":
        return jsonify(
            purchaseId=purchase_id,
            provisioningStatus="pending",
            message="Payment is verified; account provisioning is pending. Retry without paying again.",
        ), 202
    if result["state"] == "in_progress":
        return jsonify(
            purchaseId=purchase_id,
            provisioningStatus="in_progress",
            message="Account provisioning is already in progress.",
        ), 202
    if result["state"] != "provisioned":
        return jsonify(error="Purchase is not eligible for account provisioning."), 409
    return jsonify(
        purchaseId=purchase_id,
        provisioningStatus="provisioned",
        tradingStatus=result.get("tradingStatus", "active"),
        tradingEngineAccountId=result.get("accountId"),
    ), 200


@app.get("/api/trading/accounts")
@firebase_auth_required
def trading_account_proxy():
    account_id = request.args.get("account_id", "").strip()
    if not account_id:
        return jsonify(error="account_id is required."), 400
    return cloudflare_trading_proxy_response(
        "/accounts",
        method="GET",
        query={"account_id": account_id},
    )


@app.post("/api/trading/positions")
@firebase_auth_required
def trading_open_position_proxy():
    payload = filtered_trading_request_payload(
        ("account_id", "symbol", "side", "volume", "order_type", "take_profit", "stop_loss")
    )
    if payload is None:
        return jsonify(error="Request body must be a JSON object."), 400
    return cloudflare_trading_proxy_response(
        "/positions",
        method="POST",
        payload=payload,
    )


@app.post("/api/trading/positions/estimate")
@firebase_auth_required
def trading_estimate_position_margin_proxy():
    payload = filtered_trading_request_payload(
        ("account_id", "symbol", "side", "volume")
    )
    if payload is None:
        return jsonify(error="Request body must be a JSON object."), 400
    return cloudflare_trading_proxy_response(
        "/positions/estimate",
        method="POST",
        payload=payload,
    )


@app.post("/api/trading/positions/price")
@firebase_auth_required
def trading_mark_position_proxy():
    payload = filtered_trading_request_payload(("position_id", "current_price"))
    if payload is None:
        return jsonify(error="Request body must be a JSON object."), 400
    return cloudflare_trading_proxy_response(
        "/positions/price",
        method="POST",
        payload=payload,
    )


@app.post("/api/trading/positions/close")
@firebase_auth_required
def trading_close_position_proxy():
    payload = filtered_trading_request_payload(("position_id",))
    if payload is None:
        return jsonify(error="Request body must be a JSON object."), 400
    return cloudflare_trading_proxy_response(
        "/positions/close",
        method="POST",
        payload=payload,
    )


@app.post("/api/trading/positions/modify")
@firebase_auth_required
def trading_modify_position_proxy():
    payload = filtered_trading_request_payload(
        ("position_id", "stop_loss", "take_profit")
    )
    if payload is None:
        return jsonify(error="Request body must be a JSON object."), 400
    return cloudflare_trading_proxy_response(
        "/positions/modify",
        method="POST",
        payload=payload,
    )


@app.post("/api/trading/events/token")
@firebase_auth_required
def trading_position_events_token_proxy():
    payload = filtered_trading_request_payload(("account_id",))
    if payload is None:
        return jsonify(error="Request body must be a JSON object."), 400
    return cloudflare_trading_proxy_response(
        "/events/token",
        method="POST",
        payload=payload,
    )


@app.get("/api/trading/trades")
@firebase_auth_required
def trading_trades_proxy():
    account_id = request.args.get("account_id", "").strip()
    if not account_id:
        return jsonify(error="account_id is required."), 400
    return cloudflare_trading_proxy_response(
        "/trades",
        method="GET",
        query={"account_id": account_id},
    )


@app.get("/api/trading/account-rules")
@firebase_auth_required
def trading_account_rules_proxy():
    account_id = request.args.get("account_id", "").strip()
    if not account_id:
        return jsonify(error="account_id is required."), 400
    return cloudflare_trading_proxy_response(
        "/account-rules",
        method="GET",
        query={"account_id": account_id},
    )


@app.post("/api/purchases")
@firebase_auth_required
def create_purchase():
    plan_key = request.form.get("plan", "")
    try:
        size = int(request.form.get("size", ""))
    except (TypeError, ValueError):
        return jsonify(error="Select a valid challenge size."), 400
    plan = CATALOG.get(plan_key)
    if not plan or size not in plan["prices"]:
        return jsonify(error="That challenge is not available."), 400
    product_model = request.form.get("productModel", "classic").strip().lower()
    product_id = request.form.get("productId", plan_key).strip()
    if (
        product_model != plan.get("product_model", "classic")
        or product_id != plan.get("product_id", plan_key)
    ):
        return jsonify(error="That challenge product is not available."), 400

    trading_platform = request.form.get("tradingPlatform", "").strip().lower()
    if trading_platform not in TRADING_PLATFORMS:
        return jsonify(error="Select a supported trading platform."), 400

    currency = request.form.get("currency", "").lower()
    network = request.form.get("network", "").lower()
    if currency not in NETWORKS or network not in NETWORKS[currency]:
        return jsonify(error="Select a supported payment currency and network."), 400

    submitted_coupon = request.form.get("coupon", "").strip()
    try:
        list_price, discount, total, coupon_code = calculate_purchase_amount(
            plan_key, size, submitted_coupon
        )
    except ValueError as error:
        return jsonify(error=str(error)), 400
    if coupon_code and COUPONS[coupon_code]["single_use_per_user"]:
        return jsonify(error="This coupon requires the secure hosted checkout."), 400

    try:
        billing_details = normalize_billing_details(request.form.get("billing_details"))
    except ValueError as error:
        return jsonify(error=str(error)), 400

    submission_id = request.form.get("submissionId", "").strip()
    try:
        submission_id = str(uuid.UUID(submission_id))
    except (AttributeError, TypeError, ValueError):
        return jsonify(error="A valid checkout submissionId is required. Refresh checkout and try again."), 400

    uid = g.firebase_uid
    purchase_id = str(uuid.uuid5(uuid.NAMESPACE_URL, f"daily-funded:{uid}:{submission_id}"))
    account_id = purchase_id

    proof = request.files.get("proof")
    if not proof or not proof.filename:
        return jsonify(error="Attach a payment screenshot."), 400
    proof_bytes = proof.read(MAX_PROOF_BYTES + 1)
    if not proof_bytes or len(proof_bytes) > MAX_PROOF_BYTES:
        return jsonify(error="Payment proof must be no larger than 5 MB."), 400
    proof_format = None
    for signature, image_format in IMAGE_SIGNATURES:
        if proof_bytes.startswith(signature):
            proof_format = image_format
            break
    if proof_format == "webp" and proof_bytes[8:12] != b"WEBP":
        proof_format = None
    if proof_format is None:
        return jsonify(error="Upload a valid PNG, JPEG, GIF, or WebP image."), 400

    proof_digest = hashlib.sha256(proof_bytes).hexdigest()
    extension = {"jpeg": "jpg"}.get(proof_format, proof_format)
    proof_path = f"users/{uid}/paymentProofs/{purchase_id}.{extension}"
    content_type = {"jpeg": "image/jpeg"}.get(proof_format, f"image/{proof_format}")

    try:
        database = get_firestore()
        user_ref = database.collection("users").document(uid)
        purchase_ref = user_ref.collection("purchases").document(purchase_id)
        existing_snapshot = purchase_ref.get()
    except Exception as error:
        app.logger.exception("Could not access Firestore for purchase %s", purchase_id)
        return firebase_service_error("Firestore", error)

    if existing_snapshot.exists:
        existing_purchase = existing_snapshot.to_dict() or {}
        existing_proof = existing_purchase.get("paymentProof")
        if (
            existing_purchase.get("ownerUid") != uid
            or existing_purchase.get("planKey") != plan_key
            or existing_purchase.get("accountSize") != size
            or existing_purchase.get("couponCode") != coupon_code
            or existing_purchase.get("paymentCurrency") != currency
            or existing_purchase.get("paymentNetwork") != network
            or existing_purchase.get("tradingPlatform") != trading_platform
            or existing_purchase.get("billingDetails") != billing_details
            or not isinstance(existing_proof, dict)
            or existing_proof.get("sha256") != proof_digest
        ):
            return jsonify(error="This submissionId is already associated with a different purchase."), 409
        if existing_purchase.get("status") in {"rejected", "payment_rejected"}:
            return jsonify(error="This payment was rejected. Start a new checkout to submit another payment."), 409
        return purchase_response(purchase_id, existing_purchase, 200, replay=True)

    try:
        profile = user_ref.get().to_dict() or {}
        email = str(g.firebase_claims.get("email") or profile.get("email") or "").strip().lower()
        username = " ".join(filter(None, (
            str(profile.get("firstName", "")).strip(),
            str(profile.get("lastName", "")).strip(),
        ))) or str(g.firebase_claims.get("name") or "").strip() or None
    except Exception as error:
        app.logger.exception("Could not load user profile for purchase %s", purchase_id)
        return firebase_service_error("Firestore", error)

    r2_client = None
    bucket_name = None
    proof_uploaded_here = False
    try:
        r2_client = get_r2_client()
        bucket_name = get_r2_bucket_name()
        try:
            r2_client.put_object(
                Bucket=bucket_name,
                Key=proof_path,
                Body=proof_bytes,
                ContentType=content_type,
                Metadata={"sha256": proof_digest},
                IfNoneMatch="*",
            )
            proof_uploaded_here = True
        except Exception as upload_error:
            existing_object = r2_head_object_or_none(r2_client, bucket_name, proof_path)
            if existing_object is None:
                raise upload_error
            if (existing_object.get("Metadata") or {}).get("sha256") != proof_digest:
                return jsonify(error="This submissionId is already associated with a different payment screenshot."), 409
    except Exception as error:
        app.logger.error("Could not upload payment proof to R2 (%s) for purchase %s", type(error).__name__, purchase_id)
        return jsonify(error=f"Payment screenshot storage failed ({type(error).__name__}). Check R2 configuration and credentials."), 503

    purchase_data = {
        "purchaseId": purchase_id,
        "submissionId": submission_id,
        "ownerUid": uid,
        "userEmail": email or None,
        "username": username,
        "accountId": account_id,
        "planKey": plan_key,
        "accountSize": size,
        "listPriceCents": list_price,
        "discountCents": discount,
        "totalCents": total,
        "couponCode": coupon_code,
        "paymentCurrency": currency,
        "paymentNetwork": network,
        "tradingPlatform": trading_platform,
        "billingDetails": billing_details,
        "paymentProof": {
            "provider": "r2",
            "publicId": proof_path,
            "storagePath": proof_path,
            "format": proof_format,
            "sizeBytes": len(proof_bytes),
            "contentType": content_type,
            "sha256": proof_digest,
        },
        "status": "pending",
        "createdAt": firestore.SERVER_TIMESTAMP,
    }
    account_data = {
        "ownerUid": uid,
        "purchaseId": purchase_id,
        "accountId": account_id,
        "planKey": plan_key,
        "accountSize": size,
        "status": "pending",
        "tradingEnabled": False,
        "balance": None,
        "equity": None,
        "profit": None,
        "dailyDrawdown": None,
        "overallDrawdown": None,
        "tradingDays": None,
        "createdAt": firestore.SERVER_TIMESTAMP,
    }
    try:
        batch = database.batch()
        batch.create(purchase_ref, purchase_data)
        batch.create(user_ref.collection("accounts").document(account_id), account_data)
        batch.commit()
    except Exception as error:
        app.logger.exception("Could not create purchase %s in Firestore", purchase_id)
        try:
            saved_snapshot = purchase_ref.get()
        except Exception as read_error:
            app.logger.exception("Could not confirm Firestore result for purchase %s", purchase_id)
            return firebase_service_error("Firestore", read_error)
        if saved_snapshot.exists:
            saved_purchase = saved_snapshot.to_dict() or {}
            saved_proof = saved_purchase.get("paymentProof")
            if (
                saved_purchase.get("ownerUid") == uid
                and saved_purchase.get("planKey") == plan_key
                and saved_purchase.get("accountSize") == size
                and saved_purchase.get("couponCode") == coupon_code
                and saved_purchase.get("paymentCurrency") == currency
                and saved_purchase.get("paymentNetwork") == network
                and saved_purchase.get("billingDetails") == billing_details
                and isinstance(saved_proof, dict)
                and saved_proof.get("sha256") == proof_digest
            ):
                return purchase_response(purchase_id, saved_purchase, 200, replay=True)
            return jsonify(error="This submissionId is already associated with a different purchase."), 409
        if isinstance(error, AlreadyExists):
            return jsonify(error="This submissionId already exists. Refresh checkout before submitting a new purchase."), 409
        if proof_uploaded_here:
            try:
                r2_client.delete_object(Bucket=bucket_name, Key=proof_path)
            except Exception:
                app.logger.error("Could not clean up unreferenced R2 proof for purchase %s", purchase_id)
        return firebase_service_error("Firestore", error)

    return purchase_response(purchase_id, purchase_data)


@app.post("/api/crypto/coupon/validate")
@firebase_auth_required
def validate_crypto_coupon():
    payload = request.get_json(silent=True)
    if not isinstance(payload, dict):
        return jsonify(error="Coupon details are required."), 400

    plan_key = str(payload.get("plan", ""))
    try:
        size = int(payload.get("size", ""))
    except (TypeError, ValueError):
        return jsonify(error="Select a valid challenge size."), 400
    plan = CATALOG.get(plan_key)
    if not plan or size not in plan["prices"]:
        return jsonify(error="That challenge is not available."), 400
    product_model = str(payload.get("productModel", "classic")).strip().lower()
    product_id = str(payload.get("productId", plan_key)).strip()
    if (
        product_model != plan.get("product_model", "classic")
        or product_id != plan.get("product_id", plan_key)
    ):
        return jsonify(error="That challenge product is not available."), 400

    coupon_code = str(payload.get("coupon", "")).strip().upper()
    if not coupon_code:
        return jsonify(error="Enter a coupon code."), 400
    try:
        list_price, discount, total, normalized_coupon = calculate_purchase_amount(
            plan_key, size, coupon_code
        )
    except ValueError as error:
        return jsonify(error=str(error)), 400

    coupon = COUPONS[normalized_coupon]
    if coupon["single_use_per_user"]:
        try:
            database = get_firestore()
            redemption = coupon_redemption_ref(database, g.firebase_uid, normalized_coupon).get()
        except Exception as error:
            app.logger.exception("Could not check coupon redemption for user %s", g.firebase_uid)
            return firebase_service_error("Firestore", error)
        if redemption.exists:
            existing_purchase = None
            try:
                submission_id = str(uuid.UUID(str(payload.get("submissionId", "")).strip()))
                purchase_id = str(uuid.uuid5(
                    uuid.NAMESPACE_URL, f"daily-funded:{g.firebase_uid}:{submission_id}"
                ))
                purchase_snapshot = (
                    database.collection("users")
                    .document(g.firebase_uid)
                    .collection("purchases")
                    .document(purchase_id)
                    .get()
                )
                existing_purchase = purchase_snapshot.to_dict() if purchase_snapshot.exists else None
            except (AttributeError, TypeError, ValueError):
                pass
            except Exception as error:
                app.logger.exception("Could not check coupon checkout replay for user %s", g.firebase_uid)
                return firebase_service_error("Firestore", error)
            if not (
                isinstance(existing_purchase, dict)
                and existing_purchase.get("ownerUid") == g.firebase_uid
                and existing_purchase.get("planKey") == plan_key
                and existing_purchase.get("accountSize") == size
                and existing_purchase.get("couponCode") == normalized_coupon
                and existing_purchase.get("paymentProvider") == "coupon"
                and existing_purchase.get("status") != "rejected"
                and purchase_has_verified_full_coupon(existing_purchase)
            ):
                return jsonify(error="This coupon has already been used on your account."), 409

    return jsonify(
        couponCode=normalized_coupon,
        discountPercent=coupon["discount_percent"],
        listPriceCents=list_price,
        discountCents=discount,
        totalCents=total,
    ), 200


@app.post("/api/crypto/checkout")
@firebase_auth_required
def create_crypto_checkout():
    payload = request.get_json(silent=True)
    if not isinstance(payload, dict):
        return jsonify(error="Checkout details are required."), 400

    plan_key = str(payload.get("plan", ""))
    try:
        size = int(payload.get("size", ""))
    except (TypeError, ValueError):
        return jsonify(error="Select a valid challenge size."), 400
    plan = CATALOG.get(plan_key)
    if not plan or size not in plan["prices"]:
        return jsonify(error="That challenge is not available."), 400
    product_model = str(payload.get("productModel", "classic")).strip().lower()
    product_id = str(payload.get("productId", plan_key)).strip()
    if (
        product_model != plan.get("product_model", "classic")
        or product_id != plan.get("product_id", plan_key)
    ):
        return jsonify(error="That challenge product is not available."), 400

    trading_platform = str(payload.get("tradingPlatform", "")).strip().lower()
    if trading_platform not in TRADING_PLATFORMS:
        return jsonify(error="Select a supported trading platform."), 400

    try:
        list_price, discount, total, coupon_code = calculate_purchase_amount(
            plan_key, size, payload.get("coupon")
        )
        billing_details = normalize_billing_details(
            json.dumps(payload.get("billing_details"))
        )
    except ValueError as error:
        return jsonify(error=str(error)), 400

    try:
        submission_id = str(uuid.UUID(str(payload.get("submissionId", "")).strip()))
    except (AttributeError, TypeError, ValueError):
        return jsonify(error="A valid checkout submissionId is required. Refresh checkout and try again."), 400

    uid = g.firebase_uid
    purchase_id = str(uuid.uuid5(uuid.NAMESPACE_URL, f"daily-funded:{uid}:{submission_id}"))
    payment_provider = "coupon" if coupon_code and total == 0 else "nowpayments"
    retry_existing = False
    try:
        database = get_firestore()
        user_ref = database.collection("users").document(uid)
        purchase_ref = user_ref.collection("purchases").document(purchase_id)
        existing_snapshot = purchase_ref.get()
        if existing_snapshot.exists:
            existing = existing_snapshot.to_dict() or {}
            if (
                existing.get("ownerUid") != uid
                or existing.get("planKey") != plan_key
                or existing.get("accountSize") != size
                or existing.get("couponCode") != coupon_code
                or existing.get("tradingPlatform") != trading_platform
                or existing.get("billingDetails") != billing_details
                or existing.get("paymentProvider") != payment_provider
            ):
                return jsonify(error="This submissionId is already associated with a different purchase."), 409
            if payment_provider == "coupon":
                if not purchase_has_verified_full_coupon(existing):
                    return jsonify(error="This coupon checkout could not be verified. Please contact support."), 409
                provisioning = provision_verified_purchase(existing_snapshot, database)
                if provisioning["state"] in {"not_eligible", "account_rejected"}:
                    return jsonify(error="This coupon purchase could not be provisioned. Please contact support."), 409
                return jsonify(
                    purchaseId=purchase_id,
                    accountId=purchase_id,
                    status="approved" if provisioning["state"] == "provisioned" else "pending",
                    paymentStatus="not_required",
                    totalCents=0,
                    requiresPayment=False,
                    provisioningStatus=provisioning["state"],
                    idempotentReplay=True,
                ), 200 if provisioning["state"] == "provisioned" else 202
            invoice_url = existing.get("invoiceUrl")
            if invoice_url:
                return jsonify(
                    purchaseId=purchase_id,
                    invoiceUrl=invoice_url,
                    status=existing.get("status", "pending"),
                    paymentStatus=existing.get("paymentStatus", "waiting"),
                    totalCents=existing.get("totalCents"),
                    idempotentReplay=True,
                ), 200
            if existing.get("invoiceCreationStatus") == "reconciliation_required":
                return jsonify(
                    error="Crypto checkout could not be confirmed. Please contact support before retrying."
                ), 503
            if existing.get("invoiceCreationStatus") != "failed":
                return jsonify(error="This checkout is already being prepared. Please wait or contact support."), 503
            retry_existing = True
    except Exception as error:
        app.logger.exception("Could not check existing crypto checkout %s", purchase_id)
        return firebase_service_error("Firestore", error)

    config = None
    if payment_provider == "nowpayments":
        try:
            config = nowpayments_configuration()
        except Exception:
            app.logger.exception("Could not validate NOWPayments configuration")
            return jsonify(error="Crypto checkout is temporarily unavailable."), 503

    try:
        profile = user_ref.get().to_dict() or {}
        email = str(g.firebase_claims.get("email") or profile.get("email") or "").strip().lower()
        username = " ".join(filter(None, (
            str(profile.get("firstName", "")).strip(),
            str(profile.get("lastName", "")).strip(),
        ))) or str(g.firebase_claims.get("name") or "").strip() or None
    except Exception as error:
        app.logger.exception("Could not load user profile for crypto checkout %s", purchase_id)
        return firebase_service_error("Firestore", error)

    if retry_existing:
        @firestore.transactional
        def claim_invoice_retry(transaction):
            snapshot = purchase_ref.get(transaction=transaction)
            existing = snapshot.to_dict() or {}
            if (
                existing.get("ownerUid") != uid
                or existing.get("planKey") != plan_key
                or existing.get("accountSize") != size
                or existing.get("couponCode") != coupon_code
                or existing.get("tradingPlatform") != trading_platform
                or existing.get("billingDetails") != billing_details
                or existing.get("paymentProvider") != "nowpayments"
            ):
                return "purchase_mismatch", existing
            if existing.get("invoiceUrl"):
                return "invoice_exists", existing
            if (
                existing.get("invoiceCreationStatus") != "failed"
                or not purchase_status_is_pending(existing.get("status"))
                or existing.get("paymentStatus") != "waiting"
            ):
                return "already_in_progress", existing
            transaction.update(purchase_ref, {
                "invoiceCreationStatus": "creating",
                "invoiceCreationErrorType": None,
                "updatedAt": firestore.SERVER_TIMESTAMP,
            })
            return "claimed", existing

        try:
            retry_result, existing = claim_invoice_retry(database.transaction())
        except Exception as error:
            app.logger.exception("Could not claim NOWPayments invoice retry %s", purchase_id)
            return firebase_service_error("Firestore", error)
        if retry_result == "purchase_mismatch":
            return jsonify(error="This submissionId is already associated with a different purchase."), 409
        if retry_result == "invoice_exists":
            return jsonify(
                purchaseId=purchase_id,
                invoiceUrl=existing["invoiceUrl"],
                status=existing.get("status", "pending"),
                paymentStatus=existing.get("paymentStatus", "waiting"),
                totalCents=existing.get("totalCents"),
                idempotentReplay=True,
            ), 200
        if retry_result != "claimed":
            return jsonify(error="This checkout is already being prepared. Please wait or contact support."), 503

    purchase_data = {
        "purchaseId": purchase_id,
        "submissionId": submission_id,
        "ownerUid": uid,
        "userEmail": email or None,
        "username": username,
        "accountId": purchase_id,
        "planKey": plan_key,
        "accountSize": size,
        "listPriceCents": list_price,
        "discountCents": discount,
        "totalCents": total,
        "couponCode": coupon_code,
        "paymentMethod": "coupon" if payment_provider == "coupon" else "crypto",
        "paymentProvider": payment_provider,
        "tradingPlatform": trading_platform,
        "billingDetails": billing_details,
        "status": "pending",
        "paymentStatus": "not_required" if payment_provider == "coupon" else "waiting",
        "invoiceCreationStatus": "not_required" if payment_provider == "coupon" else "creating",
        "createdAt": firestore.SERVER_TIMESTAMP,
    }
    if payment_provider == "coupon":
        purchase_data["couponRedemptionVerified"] = True
    if not retry_existing:
        if payment_provider == "coupon":
            redemption_ref = coupon_redemption_ref(database, uid, coupon_code)

            @firestore.transactional
            def reserve_coupon_purchase(transaction):
                current_purchase = purchase_ref.get(transaction=transaction)
                if current_purchase.exists:
                    return "existing", current_purchase.to_dict() or {}
                redemption_snapshot = redemption_ref.get(transaction=transaction)
                redemption_data = redemption_snapshot.to_dict() or {}
                if (
                    redemption_snapshot.exists
                    and redemption_data.get("purchaseId") != purchase_id
                ):
                    return "coupon_used", {}
                transaction.create(purchase_ref, purchase_data)
                if not redemption_snapshot.exists:
                    transaction.create(redemption_ref, {
                        "couponCode": coupon_code,
                        "ownerUid": uid,
                        "purchaseId": purchase_id,
                        "redeemedAt": firestore.SERVER_TIMESTAMP,
                    })
                return "created", purchase_data

            try:
                reservation, saved_purchase = reserve_coupon_purchase(database.transaction())
            except Exception as error:
                app.logger.exception("Could not reserve coupon checkout %s", purchase_id)
                return firebase_service_error("Firestore", error)
            if reservation == "coupon_used":
                return jsonify(error="This coupon has already been used on your account."), 409
            if reservation == "existing" and (
                saved_purchase.get("ownerUid") != uid
                or saved_purchase.get("planKey") != plan_key
                or saved_purchase.get("accountSize") != size
                or saved_purchase.get("couponCode") != coupon_code
                or saved_purchase.get("tradingPlatform") != trading_platform
                or saved_purchase.get("billingDetails") != billing_details
                or not purchase_has_verified_full_coupon(saved_purchase)
            ):
                return jsonify(error="This submissionId is already associated with a different purchase."), 409
            replay = reservation == "existing"
            purchase_snapshot = purchase_ref.get()
            try:
                provisioning = provision_verified_purchase(purchase_snapshot, database)
            except Exception as error:
                app.logger.exception("Could not provision coupon purchase %s", purchase_id)
                return firebase_service_error("Account provisioning", error)
            if provisioning["state"] in {"not_eligible", "account_rejected"}:
                return jsonify(error="This coupon purchase could not be provisioned. Please contact support."), 409
            state = provisioning["state"]
            status_code = 202
            if state == "provisioned":
                status_code = 200 if replay else 201
            return jsonify(
                purchaseId=purchase_id,
                accountId=purchase_id,
                status="approved" if state == "provisioned" else "pending",
                paymentStatus="not_required",
                totalCents=0,
                requiresPayment=False,
                provisioningStatus=state,
                idempotentReplay=replay,
            ), status_code
        try:
            purchase_ref.create(purchase_data)
        except AlreadyExists:
            try:
                existing = purchase_ref.get().to_dict() or {}
            except Exception as error:
                app.logger.exception("Could not confirm crypto checkout %s", purchase_id)
                return firebase_service_error("Firestore", error)
            if (
                existing.get("ownerUid") == uid
                and existing.get("planKey") == plan_key
                and existing.get("accountSize") == size
                and existing.get("couponCode") == coupon_code
                and existing.get("tradingPlatform") == trading_platform
                and existing.get("billingDetails") == billing_details
                and existing.get("paymentProvider") == "nowpayments"
                and existing.get("invoiceUrl")
            ):
                return jsonify(
                    purchaseId=purchase_id,
                    invoiceUrl=existing["invoiceUrl"],
                    status=existing.get("status", "pending"),
                    paymentStatus=existing.get("paymentStatus", "waiting"),
                    totalCents=existing.get("totalCents"),
                    idempotentReplay=True,
                ), 200
            return jsonify(error="This checkout is already being prepared. Please wait or contact support."), 503
        except Exception as error:
            app.logger.exception("Could not reserve crypto checkout %s", purchase_id)
            return firebase_service_error("Firestore", error)

    invoice_payload = {
        "price_amount": total / 100,
        "price_currency": "usd",
        "order_id": purchase_id,
        "order_description": f"{plan['label']} ${size:,} account",
        "ipn_callback_url": config["callback_url"],
        "success_url": config["return_url"],
        "cancel_url": config["return_url"],
        "is_fixed_rate": True,
    }
    try:
        invoice = nowpayments_api_request(
            "POST", "/invoice", config["api_key"], invoice_payload
        )
    except Exception as error:
        app.logger.exception("Could not create NOWPayments invoice for purchase %s", purchase_id)
        retryable_failure = (
            isinstance(error, NOWPaymentsRequestError) and error.safe_to_retry
        )
        try:
            purchase_ref.update({
                "invoiceCreationStatus": "failed" if retryable_failure else "reconciliation_required",
                "invoiceCreationErrorType": type(error).__name__,
                "updatedAt": firestore.SERVER_TIMESTAMP,
            })
        except Exception:
            app.logger.exception("Could not record NOWPayments invoice failure for %s", purchase_id)
        if retryable_failure:
            return jsonify(error="Crypto checkout could not be created. Please retry."), 503
        return jsonify(error="Crypto checkout could not be confirmed. Please contact support before retrying."), 503

    try:
        invoice_id = str(invoice.get("id") or invoice.get("invoice_id") or "").strip()
        invoice_url = str(invoice.get("invoice_url") or "").strip()
        parsed_invoice_url = urlsplit(invoice_url)
        if (
            not invoice_id
            or parsed_invoice_url.scheme != "https"
            or parsed_invoice_url.hostname != "nowpayments.io"
        ):
            raise RuntimeError("NOWPayments returned an invalid invoice.")
    except Exception as error:
        app.logger.exception("NOWPayments returned an invalid invoice for purchase %s", purchase_id)
        try:
            purchase_ref.update({
                "invoiceCreationStatus": "reconciliation_required",
                "invoiceCreationErrorType": type(error).__name__,
                "updatedAt": firestore.SERVER_TIMESTAMP,
            })
        except Exception:
            app.logger.exception("Could not record invalid NOWPayments invoice for %s", purchase_id)
        return jsonify(error="Crypto checkout could not be confirmed. Please contact support before retrying."), 503

    try:
        purchase_ref.update({
            "invoiceId": invoice_id,
            "invoiceUrl": invoice_url,
            "invoiceCreationStatus": "created",
            "updatedAt": firestore.SERVER_TIMESTAMP,
        })
    except Exception as error:
        app.logger.exception("Could not save NOWPayments invoice for purchase %s", purchase_id)
        try:
            purchase_ref.update({
                "invoiceId": invoice_id,
                "invoiceUrl": invoice_url,
                "invoiceCreationStatus": "created",
                "updatedAt": firestore.SERVER_TIMESTAMP,
            })
        except Exception:
            app.logger.exception("Could not reconcile NOWPayments invoice for purchase %s", purchase_id)
        return firebase_service_error("Firestore", error)

    return jsonify(
        purchaseId=purchase_id,
        invoiceUrl=invoice_url,
        status="pending",
        paymentStatus="waiting",
        totalCents=total,
        idempotentReplay=False,
    ), 201


@app.post("/api/payments/nowpayments/ipn")
def nowpayments_ipn():
    payload = request.get_json(silent=True)
    if not isinstance(payload, dict):
        return jsonify(error="Invalid IPN payload."), 400
    try:
        config = nowpayments_configuration()
    except RuntimeError as error:
        app.logger.error("NOWPayments IPN configuration error: %s", error)
        return jsonify(error="NOWPayments IPN is not configured."), 503
    signature = request.headers.get("x-nowpayments-sig", "")
    if not nowpayments_signature_is_valid(payload, signature, config["ipn_secret"]):
        return jsonify(error="Invalid NOWPayments signature."), 401

    payment_id = str(payload.get("payment_id", "")).strip()
    order_id = str(payload.get("order_id", "")).strip()
    payment_status = str(payload.get("payment_status", "")).strip().lower()
    if (
        not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", payment_id)
        or not re.fullmatch(r"[0-9a-fA-F-]{36}", order_id)
        or payment_status not in NOWPAYMENTS_PAYMENT_STATUSES
    ):
        return jsonify(error="Invalid NOWPayments payment identifiers or status."), 400

    purchase = find_purchase_document(order_id)
    if purchase is None:
        return jsonify(error="Purchase not found."), 404
    purchase_data = purchase.to_dict() or {}
    if (
        purchase_data.get("paymentProvider") != "nowpayments"
        or purchase_data.get("purchaseId") != order_id
        or not isinstance(purchase_data.get("totalCents"), int)
        or isinstance(purchase_data.get("totalCents"), bool)
    ):
        return jsonify(error="Purchase does not match this payment."), 409
    if str(payload.get("order_id")) != order_id:
        return jsonify(error="Invalid NOWPayments order identifier."), 400
    invoice_id = payload.get("invoice_id")
    if (
        invoice_id is None
        or not purchase_data.get("invoiceId")
        or str(invoice_id) != str(purchase_data.get("invoiceId", ""))
    ):
        return jsonify(error="Invalid NOWPayments invoice identifier."), 400

    payment_currency = str(payload.get("pay_currency", "")).strip().lower()
    if (
        str(payload.get("price_currency", "")).lower() != "usd"
        or not re.fullmatch(r"[a-z0-9]{2,32}", payment_currency)
        or (
            purchase_data.get("paymentCurrency")
            and str(purchase_data.get("paymentCurrency", "")).lower() != payment_currency
        )
        or not nowpayments_amount_matches(payload.get("price_amount"), purchase_data["totalCents"])
    ):
        return jsonify(error="NOWPayments amount or currency does not match the purchase."), 400

    try:
        provider_payment = nowpayments_api_request(
            "GET", f"/payment/{payment_id}", config["api_key"]
        )
    except Exception as error:
        app.logger.exception("Could not verify NOWPayments payment %s", payment_id)
        return jsonify(error="NOWPayments payment verification is temporarily unavailable."), 503
    if (
        str(provider_payment.get("payment_id", "")) != payment_id
        or str(provider_payment.get("order_id", "")) != order_id
        or (
            provider_payment.get("invoice_id") is not None
            and str(provider_payment.get("invoice_id")) != str(purchase_data.get("invoiceId", ""))
        )
        or str(provider_payment.get("price_currency", "")).lower() != "usd"
        or str(provider_payment.get("pay_currency", "")).strip().lower() != payment_currency
        or str(provider_payment.get("payment_status", "")).lower() != payment_status
        or not nowpayments_amount_matches(
            provider_payment.get("price_amount"), purchase_data["totalCents"]
        )
    ):
        return jsonify(error="NOWPayments payment details do not match the signed callback."), 400

    database = get_firestore()
    purchase_ref = purchase.reference
    settlement = nowpayments_settlement_details(provider_payment, payment_currency)
    settlement_status = settlement["status"]
    if payment_status != "finished" and settlement_status == "exact":
        settlement_status = "awaiting_finished"
    settlement_verified = payment_status == "finished" and settlement_status == "exact"

    @firestore.transactional
    def apply_payment_update(transaction):
        snapshot = purchase_ref.get(transaction=transaction)
        current = snapshot.to_dict() or {}
        if (
            current.get("paymentProvider") != "nowpayments"
            or current.get("purchaseId") != order_id
            or current.get("totalCents") != purchase_data["totalCents"]
            or (
                current.get("paymentCurrency")
                and str(current.get("paymentCurrency", "")).lower() != payment_currency
            )
        ):
            return "purchase_changed"
        stored_payment_id = current.get("providerPaymentId")
        if stored_payment_id and str(stored_payment_id) != payment_id:
            return "payment_id_conflict"

        current_status = str(current.get("paymentStatus", "")).lower()
        if current_status in {"refunded", "reversed"} and payment_status not in {"refunded", "reversed"}:
            return "terminal_refund"
        if current_status == "finished" and payment_status not in {"finished", "refunded", "reversed"}:
            return "already_finished"

        settlement_updates = {
            "settlementStatus": settlement_status,
            "settlementVerified": settlement_verified,
            "settlementCurrency": settlement.get("currency"),
            "settlementPayAmount": settlement.get("payAmount"),
            "settlementActuallyPaid": settlement.get("actuallyPaid"),
        }
        if current.get("status") == "rejected":
            if (
                current_status == payment_status
                and str(stored_payment_id or "") == payment_id
                and current.get("manualReviewRequired") is True
                and current.get("settlementStatus") == settlement_status
                and current.get("settlementPayAmount") == settlement.get("payAmount")
                and current.get("settlementActuallyPaid") == settlement.get("actuallyPaid")
            ):
                return "duplicate"
            updates = {
                "providerPaymentId": payment_id,
                "paymentCurrency": payment_currency,
                "paymentStatus": payment_status,
                "providerStatus": payment_status,
                **settlement_updates,
                "paymentUpdatedAt": firestore.SERVER_TIMESTAMP,
                "updatedAt": firestore.SERVER_TIMESTAMP,
                "manualReviewRequired": True,
                "manualReviewSource": "rejected_purchase",
                "manualReviewReason": current.get("manualReviewReason")
                or current.get("rejectionReason")
                or "NOWPayments reported a payment update after purchase rejection.",
            }
            if payment_status in {"refunded", "reversed"}:
                updates["manualReviewReason"] = f"NOWPayments reported {payment_status} after purchase rejection."
            transaction.update(purchase_ref, updates)
            return "rejected_payment_recorded"

        if (
            payment_status == "finished"
            and current_status == "finished"
            and str(stored_payment_id or "") == payment_id
            and current.get("settlementStatus") == "exact"
            and current.get("settlementVerified") is True
            and current.get("manualReviewRequired") is not True
            and current.get("provisioningStatus") == "provisioned"
        ):
            values = purchase_provisioning_values(order_id, current)
            account_ref = user_document(values["ownerUid"]).collection(
                "accounts"
            ).document(values["accountId"])
            account_snapshot = account_ref.get(transaction=transaction)
            account = account_snapshot.to_dict() or {}
            if account_snapshot.exists and not firestore_account_matches_purchase(account, values):
                raise CloudflareProvisioningError(
                    "firestore_account_mismatch",
                    "Firestore account does not match its purchase.",
                    409,
                )
            if (
                account_snapshot.exists
                and account.get("status") == "active"
                and account.get("tradingEnabled") is True
                and is_valid_trading_engine_account_id(account.get("tradingEngineAccountId"))
            ):
                return "duplicate"

        updates = {
            "providerPaymentId": payment_id,
            "paymentCurrency": payment_currency,
            "paymentStatus": payment_status,
            "providerStatus": payment_status,
            **settlement_updates,
            "paymentUpdatedAt": firestore.SERVER_TIMESTAMP,
            "updatedAt": firestore.SERVER_TIMESTAMP,
        }
        requires_settlement_review = payment_status == "finished" and settlement_status != "exact"
        if settlement_status in {"underpaid", "overpaid", "invalid", "currency_mismatch"}:
            requires_settlement_review = True
        if requires_settlement_review:
            updates.update({
                "manualReviewRequired": True,
                "manualReviewSource": "settlement",
                "manualReviewReason": f"NOWPayments settlement requires review ({settlement_status}).",
            })
        elif settlement_verified and current.get("manualReviewSource") == "settlement":
            updates.update({
                "manualReviewRequired": False,
                "manualReviewSource": None,
                "manualReviewReason": None,
            })
        if payment_status in {"refunded", "reversed"}:
            updates.update({
                "manualReviewRequired": True,
                "manualReviewSource": "provider_status",
                "manualReviewReason": f"NOWPayments reported {payment_status}.",
            })

        auto_provision = (
            settlement_verified
            and current.get("manualReviewRequired") is not True
            and current.get("manualReviewSource") not in {"rejected_purchase", "provider_status"}
        )
        if auto_provision:
            values = purchase_provisioning_values(order_id, current)
            account_ref = user_document(values["ownerUid"]).collection(
                "accounts"
            ).document(values["accountId"])
            account_snapshot = account_ref.get(transaction=transaction)
            account = account_snapshot.to_dict() or {}
            if account_snapshot.exists and not firestore_account_matches_purchase(account, values):
                raise CloudflareProvisioningError(
                    "firestore_account_mismatch",
                    "Firestore account does not match its purchase.",
                    409,
                )
            if account.get("status") == "rejected":
                return "account_rejected"
            if current.get("status") != "approved":
                award_referral_reward(
                    transaction,
                    database,
                    values["ownerUid"],
                    values["purchaseId"],
                )
                updates.update({
                    "status": "approved",
                    "approvalSource": "automatic_nowpayments",
                    "approvedAt": current.get("approvedAt") or firestore.SERVER_TIMESTAMP,
                })
            updates["provisioningStatus"] = current.get("provisioningStatus") or "pending"
            if not account_snapshot.exists:
                transaction.set(account_ref, {
                    "ownerUid": values["ownerUid"],
                    "userUid": values["ownerUid"],
                    "purchaseId": values["purchaseId"],
                    "accountId": values["accountId"],
                    "planKey": values["planKey"],
                    "accountSize": values["accountSize"],
                    "phase": "instant" if values["planKey"] in {"instant", "spark_instant"} else "phase_1",
                    "status": "pending_provisioning",
                    "provisioningStatus": "pending",
                    "tradingEnabled": False,
                    "balance": None,
                    "equity": None,
                    "profit": None,
                    "dailyDrawdown": None,
                    "overallDrawdown": None,
                    "tradingDays": None,
                    "createdAt": firestore.SERVER_TIMESTAMP,
                    "updatedAt": firestore.SERVER_TIMESTAMP,
                })
            elif not (
                is_valid_trading_engine_account_id(account.get("tradingEngineAccountId"))
                and account.get("status") == "active"
                and account.get("tradingEnabled") is True
            ):
                transaction.update(account_ref, {
                    "status": "pending_provisioning",
                    "provisioningStatus": "pending",
                    "tradingEnabled": False,
                    "updatedAt": firestore.SERVER_TIMESTAMP,
                })
        transaction.update(purchase_ref, updates)
        if (
            current_status == payment_status
            and str(stored_payment_id or "") == payment_id
            and current.get("settlementStatus") == settlement_status
            and current.get("settlementPayAmount") == settlement.get("payAmount")
            and current.get("settlementActuallyPaid") == settlement.get("actuallyPaid")
        ):
            return "duplicate"
        return "updated"

    try:
        update_result = apply_payment_update(database.transaction())
    except Exception as error:
        app.logger.exception("Could not save NOWPayments update for purchase %s", order_id)
        return firebase_service_error("Firestore", error)
    if update_result == "payment_id_conflict":
        return jsonify(error="A different provider payment is already associated with this purchase."), 409
    if update_result in {"purchase_changed", "account_rejected"}:
        return jsonify(error="Purchase changed during payment verification."), 409
    if update_result in {"terminal_refund", "already_finished"}:
        return jsonify(
            received=True,
            duplicate=True,
            paymentStatus=purchase_data.get("paymentStatus"),
        ), 200

    if (
        settlement_verified
        and update_result != "rejected_payment_recorded"
        and not (
            update_result == "duplicate"
            and purchase_data.get("provisioningStatus") == "provisioned"
        )
    ):
        provisioning = provision_verified_purchase(purchase, database)
        if provisioning["state"] == "pending":
            return jsonify(
                received=True,
                duplicate=update_result == "duplicate",
                paymentStatus="finished",
                settlementStatus="exact",
                provisioningStatus="pending",
                message="Payment is verified; account provisioning is pending and can be retried.",
            ), 503
    else:
        provisioning = {
            "state": purchase_data.get("provisioningStatus", "not_started")
            if update_result != "rejected_payment_recorded"
            else "review_required"
        }

    return jsonify(
        received=True,
        duplicate=update_result not in {"updated", "rejected_payment_recorded"},
        paymentStatus=(
            purchase_data.get("paymentStatus")
            if update_result == "duplicate"
            else payment_status
        ),
        settlementStatus=settlement_status,
        settlementVerified=settlement_verified,
        provisioningStatus=provisioning["state"],
        manualReviewRequired=update_result == "rejected_payment_recorded" or (
            payment_status == "finished" and settlement_status != "exact"
        ) or provisioning["state"] == "not_eligible",
    ), 200


@app.get("/api/admin/purchases/pending")
@firebase_auth_required
def admin_pending_purchases():
    admin_error = require_admin()
    if admin_error is not None:
        return admin_error

    def purchase_review_row(document, account=None):
        data = document.to_dict() or {}
        proof = data.get("paymentProof")
        if not isinstance(proof, dict):
            proof = {}
        row = {
            "purchaseId": document.id,
            "uid": data.get("ownerUid"),
            "userEmail": data.get("userEmail"),
            "username": data.get("username"),
            "plan": data.get("planKey"),
            "planLabel": CATALOG.get(data.get("planKey"), {}).get("label", data.get("planKey")),
            "size": data.get("accountSize"),
            "originalPriceCents": data.get("listPriceCents"),
            "couponCode": data.get("couponCode"),
            "discountCents": data.get("discountCents", 0),
            "amountCents": data.get("totalCents", data.get("listPriceCents")),
            "status": data.get("status"),
            "paymentProvider": data.get("paymentProvider"),
            "paymentStatus": data.get("paymentStatus"),
            "providerPaymentId": data.get("providerPaymentId"),
            "invoiceId": data.get("invoiceId"),
            "settlementStatus": data.get("settlementStatus"),
            "settlementVerified": data.get("settlementVerified", False),
            "settlementCurrency": data.get("settlementCurrency"),
            "settlementPayAmount": data.get("settlementPayAmount"),
            "settlementActuallyPaid": data.get("settlementActuallyPaid"),
            "manualReviewRequired": data.get("manualReviewRequired", False),
            "manualReviewReason": data.get("manualReviewReason"),
            "provisioningStatus": data.get("provisioningStatus"),
            "paymentCurrency": data.get("paymentCurrency"),
            "paymentNetwork": data.get("paymentNetwork"),
            "tradingPlatform": data.get("tradingPlatform"),
            "createdAt": data.get("createdAt"),
            "paymentProof": {
                "provider": proof.get("provider"),
                "publicId": proof.get("publicId"),
                "storagePath": proof.get("storagePath") or proof.get("publicId"),
                "format": proof.get("format"),
                "sizeBytes": proof.get("sizeBytes"),
                "contentType": proof.get("contentType"),
            },
        }
        if account is not None:
            row["accountId"] = account.get("accountId")
            row["accountStatus"] = account.get("status")
            row["tradingEngineAccountId"] = account.get("tradingEngineAccountId")
        return row

    database = get_firestore()
    pending_documents = list(database.collection_group("purchases").where(
        "status", "in", ["pending", "pending_payment_verification"]
    ).stream())
    approved_documents = list(database.collection_group("purchases").where(
        "status", "==", "approved"
    ).stream())
    rejected_documents = list(database.collection_group("purchases").where(
        "status", "==", "rejected"
    ).stream())

    active_rows = []
    for document in approved_documents:
        data = document.to_dict() or {}
        owner_uid = data.get("ownerUid")
        account_id = data.get("accountId")
        if not isinstance(owner_uid, str) or not owner_uid.strip():
            continue
        if not isinstance(account_id, str) or not account_id.strip():
            continue
        account_snapshot = database.collection("users").document(owner_uid).collection(
            "accounts"
        ).document(account_id).get()
        if not account_snapshot.exists:
            continue
        account = account_snapshot.to_dict() or {}
        if (
            account.get("status") == "active"
            and account.get("ownerUid") == owner_uid
            and account.get("purchaseId") == document.id
            and account.get("accountId") == account_id
        ):
            active_rows.append(purchase_review_row(document, account))

    return jsonify(
        purchases=firestore_json([purchase_review_row(document) for document in pending_documents]),
        active=firestore_json(active_rows),
        rejected=firestore_json([purchase_review_row(document) for document in rejected_documents]),
    )


@app.get("/api/admin/purchases/<purchase_id>/proof")
@firebase_auth_required
def admin_purchase_proof(purchase_id):
    admin_error = require_admin()
    if admin_error is not None:
        return admin_error

    purchase = find_purchase_document(purchase_id)
    if purchase is None:
        return jsonify(error="Purchase not found."), 404
    data = purchase.to_dict() or {}
    proof = data.get("paymentProof")
    if not isinstance(proof, dict):
        return jsonify(error="Payment proof is unavailable."), 404
    try:
        owner_uid = data.get("ownerUid")
        expected_base = f"users/{owner_uid}/paymentProofs/{purchase_id}"
        if proof.get("provider") == "r2":
            extension = {"jpeg": "jpg"}.get(proof.get("format"), proof.get("format"))
            expected_key = f"{expected_base}.{extension}"
            if proof.get("publicId") != expected_key or proof.get("storagePath") != expected_key:
                return jsonify(error="Payment proof is unavailable."), 404
            r2_object = get_r2_client().get_object(
                Bucket=get_r2_bucket_name(),
                Key=expected_key,
            )
            body = r2_object["Body"]
            try:
                proof_bytes = body.read(MAX_PROOF_BYTES + 1)
            finally:
                body.close()
            if not proof_bytes or len(proof_bytes) > MAX_PROOF_BYTES:
                return jsonify(error="Payment proof is unavailable."), 404
        elif proof.get("publicId"):
            if proof.get("provider") not in (None, "cloudinary") or proof["publicId"] != expected_base:
                return jsonify(error="Payment proof is unavailable."), 404
            proof_bytes = download_cloudinary_proof(
                proof["publicId"],
                proof.get("version"),
                proof.get("format"),
            )
        else:
            storage_path = proof.get("storagePath")
            expected_prefix = f"{expected_base}."
            if not isinstance(storage_path, str) or not storage_path.startswith(expected_prefix):
                return jsonify(error="Payment proof is unavailable."), 404
            proof_bytes = get_storage_bucket().blob(storage_path).download_as_bytes()
    except Exception:
        app.logger.exception("Could not load payment proof for purchase %s", purchase_id)
        return jsonify(error="Payment proof is unavailable."), 404

    response = send_file(
        BytesIO(proof_bytes),
        mimetype=proof.get("contentType", "application/octet-stream"),
        download_name=f"payment-proof-{purchase_id}",
        max_age=0,
    )
    response.headers["Cache-Control"] = "private, no-store"
    return response


@app.post("/api/admin/purchases/<purchase_id>/approve")
@firebase_auth_required
def admin_approve_purchase(purchase_id):
    admin_error = require_admin()
    if admin_error is not None:
        return admin_error

    purchase = find_purchase_document(purchase_id)
    if purchase is None:
        return jsonify(error="Purchase not found."), 404

    database = get_firestore()

    @firestore.transactional
    def prepare_approval(transaction):
        snapshot = purchase.reference.get(transaction=transaction)
        data = snapshot.to_dict() or {}
        status = data.get("status")
        if (
            (status != "approved" and not purchase_status_is_pending(status))
            or not purchase_payment_allows_approval(data)
        ):
            return None

        values = purchase_provisioning_values(purchase_id, data)
        account_ref = user_document(values["ownerUid"]).collection("accounts").document(
            values["accountId"]
        )
        account_snapshot = account_ref.get(transaction=transaction)
        account = account_snapshot.to_dict() or {}
        if account_snapshot.exists and not firestore_account_matches_purchase(account, values):
            raise CloudflareProvisioningError(
                "firestore_account_mismatch",
                "Firestore account does not match its purchase.",
                409,
            )

        engine_account_id = account.get("tradingEngineAccountId")
        if not is_valid_trading_engine_account_id(engine_account_id):
            engine_account_id = None
        else:
            engine_account_id = engine_account_id.strip()
        engine_status = account.get("tradingStatus")
        if not isinstance(engine_status, str):
            engine_status = None
        else:
            engine_status = engine_status.strip().lower()

        reviewed_at = data.get("reviewedAt") or firestore.SERVER_TIMESTAMP
        reviewed_by = data.get("reviewedBy") or g.firebase_uid
        account_fields = {
            "ownerUid": values["ownerUid"],
            "purchaseId": values["purchaseId"],
            "accountId": values["accountId"],
            "planKey": values["planKey"],
            "accountSize": values["accountSize"],
            "userUid": values["ownerUid"],
            "phase": "instant" if values["planKey"] in {"instant", "spark_instant"} else "phase_1",
        }

        if status != "approved":
            award_referral_reward(
                transaction,
                database,
                values["ownerUid"],
                values["purchaseId"],
            )
            transaction.update(purchase.reference, {
                "status": "approved",
                "reviewedBy": reviewed_by,
                "reviewedAt": reviewed_at,
                "audit": {"approvedBy": reviewed_by, "approvedAt": reviewed_at},
            })

        if account_snapshot.exists:
            if engine_account_id is None:
                transaction.update(account_ref, {**account_fields, "tradingEnabled": False})
        else:
            transaction.set(account_ref, {
                **account_fields,
                "status": "pending",
                "tradingEnabled": False,
                "balance": None,
                "equity": None,
                "profit": None,
                "dailyDrawdown": None,
                "overallDrawdown": None,
                "tradingDays": None,
                "createdAt": reviewed_at,
            })

        return {
            "purchaseValues": values,
            "engineAccountId": engine_account_id,
            "engineStatus": engine_status,
            "alreadyApproved": status == "approved",
        }

    try:
        prepared = prepare_approval(database.transaction())
    except CloudflareProvisioningError as error:
        return jsonify(error=str(error), code=error.code), error.status_code
    except Exception as error:
        app.logger.exception("Could not prepare approval for purchase %s", purchase_id)
        return firebase_service_error("Firestore", error)

    if prepared is None:
        return jsonify(error="Purchase is not currently awaiting payment verification."), 409

    purchase_values = prepared["purchaseValues"]
    engine_account_id = prepared["engineAccountId"]
    engine_status = prepared["engineStatus"]
    if engine_account_id is None or engine_status is None:
        try:
            worker_url, provisioning_token = cloudflare_worker_configuration()
            worker_payload = {
                "user_id": purchase_values["ownerUid"],
                "purchase_id": purchase_values["purchaseId"],
                "plan_key": purchase_values["planKey"],
                "account_size": purchase_values["accountSize"],
            }
            provisioned_account = provision_cloudflare_account(
                worker_url, provisioning_token, worker_payload
            )
            if not trading_engine_account_matches_purchase(provisioned_account, purchase_values):
                raise CloudflareProvisioningError(
                    "worker_account_mismatch",
                    "Trading engine returned an account for a different purchase.",
                )
            engine_account_id = provisioned_account["id"].strip()
            engine_status = provisioned_account["status"].strip().lower()
        except CloudflareProvisioningError as error:
            return jsonify(
                error=str(error),
                code=error.code,
                workerStatus=error.worker_status,
            ), error.status_code

        @firestore.transactional
        def save_engine_account_id(transaction):
            current_purchase = purchase.reference.get(transaction=transaction).to_dict() or {}
            if (
                current_purchase.get("status") != "approved"
                or not purchase_payment_allows_approval(current_purchase)
            ):
                return "purchase_not_approved"
            current_values = purchase_provisioning_values(purchase_id, current_purchase)
            if current_values != purchase_values:
                return "purchase_changed"

            account_ref = user_document(purchase_values["ownerUid"]).collection(
                "accounts"
            ).document(purchase_values["accountId"])
            account_snapshot = account_ref.get(transaction=transaction)
            account = account_snapshot.to_dict() or {}
            if not account_snapshot.exists or not firestore_account_matches_purchase(account, purchase_values):
                return "account_mismatch"

            saved_id = account.get("tradingEngineAccountId")
            if not is_valid_trading_engine_account_id(saved_id):
                saved_id = None
            else:
                saved_id = saved_id.strip()
            if saved_id and saved_id != engine_account_id:
                return "engine_account_mismatch"
            transaction.update(account_ref, {
                "tradingEngineAccountId": engine_account_id,
                "tradingStatus": engine_status,
                "provisioningStatus": "provisioned",
                "status": engine_status,
                "tradingEnabled": False,
            })
            return "saved"

        try:
            saved_status = save_engine_account_id(database.transaction())
        except CloudflareProvisioningError as error:
            return jsonify(error=str(error), code=error.code), error.status_code
        except Exception as error:
            app.logger.exception("Could not save trading account ID for purchase %s", purchase_id)
            return firebase_service_error("Firestore", error)
        if saved_status != "saved":
            return jsonify(error="Purchase or account changed during provisioning."), 409

    if engine_status != "active":
        return jsonify(
            error="The trading engine account exists but is not active yet.",
            provisioningStatus="provisioned",
            tradingStatus=engine_status,
        ), 409

    @firestore.transactional
    def enable_trading(transaction):
        current_purchase = purchase.reference.get(transaction=transaction).to_dict() or {}
        if (
            current_purchase.get("status") != "approved"
            or not purchase_payment_allows_approval(current_purchase)
        ):
            return False
        current_values = purchase_provisioning_values(purchase_id, current_purchase)
        if current_values != purchase_values:
            return False

        account_ref = user_document(purchase_values["ownerUid"]).collection(
            "accounts"
        ).document(purchase_values["accountId"])
        account_snapshot = account_ref.get(transaction=transaction)
        account = account_snapshot.to_dict() or {}
        if (
            not account_snapshot.exists
            or not firestore_account_matches_purchase(account, purchase_values)
            or account.get("tradingEngineAccountId") != engine_account_id
            or account.get("tradingStatus") != "active"
        ):
            return False

        reviewed_at = current_purchase.get("reviewedAt") or firestore.SERVER_TIMESTAMP
        reviewed_by = current_purchase.get("reviewedBy") or g.firebase_uid
        transaction.update(account_ref, {
            "userUid": purchase_values["ownerUid"],
            "phase": "instant" if purchase_values["planKey"] in {"instant", "spark_instant"} else "phase_1",
            "balance": account.get("balance"),
            "equity": account.get("equity"),
            "status": "active",
            "tradingEnabled": True,
            "reviewedBy": reviewed_by,
            "reviewedAt": reviewed_at,
            "audit": {"approvedBy": reviewed_by, "approvedAt": reviewed_at},
        })
        return True

    try:
        enabled = enable_trading(database.transaction())
    except Exception as error:
        app.logger.exception("Could not enable trading for purchase %s", purchase_id)
        return firebase_service_error("Firestore", error)
    if not enabled:
        return jsonify(error="Trading account could not be safely activated."), 409

    return jsonify(
        purchaseId=purchase_id,
        status="approved",
        reviewedBy=g.firebase_uid,
        alreadyApproved=prepared["alreadyApproved"],
        tradingEngineAccountId=engine_account_id,
    ), 200


@app.post("/api/admin/purchases/<purchase_id>/reject")
@firebase_auth_required
def admin_reject_purchase(purchase_id):
    admin_error = require_admin()
    if admin_error is not None:
        return admin_error

    purchase = find_purchase_document(purchase_id)
    if purchase is None:
        return jsonify(error="Purchase not found."), 404

    payload = read_json_object()
    reason = payload.get("reason")
    if reason is not None and (not isinstance(reason, str) or not reason.strip()):
        return jsonify(error="Reason must be a non-empty string when provided."), 400
    reason = reason.strip() if isinstance(reason, str) else None

    database = get_firestore()
    transaction = database.transaction()

    @firestore.transactional
    def reject_in_transaction(transaction):
        snapshot = purchase.reference.get(transaction=transaction)
        data = snapshot.to_dict() or {}
        if data.get("status") == "rejected":
            return True
        if purchase_payment_allows_auto_provisioning(data):
            return "payment_verified"
        if not purchase_status_is_pending(data.get("status")):
            return None
        owner_uid = data.get("ownerUid")
        account_id = data.get("accountId")
        if not isinstance(owner_uid, str) or not owner_uid.strip():
            return False

        account_ref = None
        account_snapshot = None
        if isinstance(account_id, str) and account_id.strip():
            account_ref = user_document(owner_uid).collection("accounts").document(account_id)
            account_snapshot = account_ref.get(transaction=transaction)

        reviewed_at = firestore.SERVER_TIMESTAMP
        audit = {"rejectedBy": g.firebase_uid, "rejectedAt": reviewed_at}
        if reason is not None:
            audit["reason"] = reason
        transaction.update(purchase.reference, {
            "status": "rejected",
            "reviewedBy": g.firebase_uid,
            "reviewedAt": reviewed_at,
            "rejectionReason": reason,
            "reviewReason": reason,
            "audit": audit,
        })
        if account_snapshot is not None and account_snapshot.exists:
            transaction.update(account_ref, {
                "status": "rejected",
                "provisioningStatus": "rejected",
                "tradingEnabled": False,
                "reviewedBy": g.firebase_uid,
                "reviewedAt": reviewed_at,
                "audit": audit,
            })
        return True

    rejected = reject_in_transaction(transaction)
    if rejected == "payment_verified":
        return jsonify(error="Verified payment cannot be rejected; account provisioning will continue."), 409
    if rejected is None:
        return jsonify(error="Purchase is not currently awaiting payment verification."), 409
    if not rejected:
        return jsonify(error="Purchase is missing an owner UID."), 400
    return jsonify(purchaseId=purchase_id, status="rejected", reviewedBy=g.firebase_uid), 200


@app.get("/api/payouts")
def payout_feed():
    documents = get_firestore().collection("publicPayouts").order_by(
        "paidAt", direction=firestore.Query.DESCENDING
    ).limit(8).stream()
    public_fields = (
        "publicName", "countryFlag", "countryCode", "amount", "currency",
        "accountSize", "accountType", "accountCreatedAt", "totalPaid", "paidAt",
    )
    payouts = []
    for document in documents:
        data = document.to_dict() or {}
        payouts.append({"id": document.id, **{key: data[key] for key in public_fields if key in data}})
    return jsonify(payouts=firestore_json(payouts))


@app.get("/api/payouts/requests")
@firebase_auth_required
def payout_request_history():
    try:
        documents = user_document(g.firebase_uid).collection("payoutRequests").order_by(
            "createdAt", direction=firestore.Query.DESCENDING
        ).limit(100).stream()
        fields = (
            "accountId", "method", "amountCents", "feeCents", "netAmountCents",
            "currency", "network", "status", "createdAt", "updatedAt",
            "estimatedEligibleAt",
        )
        requests = []
        for document in documents:
            data = document.to_dict() or {}
            row = {"id": document.id}
            row.update({key: data[key] for key in fields if key in data})
            if "updatedAt" not in row:
                row["updatedAt"] = row.get("createdAt")
            requests.append(row)
        return jsonify(requests=firestore_json(requests))
    except Exception as error:
        app.logger.exception("Could not load payout request history for user %s", g.firebase_uid)
        return firebase_service_error("Firestore", error)


@app.get("/api/payouts/eligibility")
@firebase_auth_required
def payout_eligibility():
    account_id = request.args.get("accountId", "").strip()
    if not account_id:
        return jsonify(error="accountId is required."), 400

    response, status_code = cloudflare_trading_proxy_response(
        "/payout-eligibility",
        method="GET",
        query={"account_id": account_id},
    )
    response.headers["Cache-Control"] = "private, no-store"
    return response, status_code


@app.post("/api/payouts/requests")
@firebase_auth_required
def payout_request():
    payload = read_json_object()
    account_id = str(payload.get("accountId", "")).strip()
    if not account_id:
        return jsonify(error="Select a valid account."), 400

    account_snapshot = user_document(g.firebase_uid).collection("accounts").document(account_id).get()
    if not account_snapshot.exists:
        return jsonify(error="Account not found."), 404
    account = account_snapshot.to_dict() or {}
    if account.get("status") != "active":
        return jsonify(error="This account is not eligible for a payout request."), 400
    return jsonify(
        code="payout_eligibility_unavailable",
        error=(
            "Payout requests are temporarily unavailable until eligible profit "
            "and account payout rules can be verified."
        ),
    ), 503


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", "8080")), debug=False)