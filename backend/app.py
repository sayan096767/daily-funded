import os
import re
import uuid
import hashlib
import json
import math
import socket
from io import BytesIO
from pathlib import Path
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation
from functools import wraps

import firebase_admin
import boto3
import cloudinary
import cloudinary.utils
from firebase_admin import auth as firebase_auth, credentials, firestore, storage
from flask import Flask, g, jsonify, request, send_file
from google.api_core.exceptions import AlreadyExists
from botocore.config import Config
from urllib.parse import urlencode, urlsplit
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


FRONTEND_ORIGINS = {
    origin.strip().rstrip("/")
    for origin in os.environ.get("DAILYFUNDED_FRONTEND_ORIGINS", "").split(",")
    if origin.strip()
}
MAX_PROOF_BYTES = 5 * 1024 * 1024
CLOUDFLARE_PROVISIONING_TIMEOUT_SECONDS = 15
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
        "prices": {2500: 25, 5000: 49, 10000: 98, 25000: 245, 50000: 490, 100000: 980, 200000: 1960},
        "rules": ["No profit target", "5% daily drawdown", "10% max drawdown", "0 min trading days", "Daily reward cycle"],
        "profit_split": "80% profit split",
    },
}
COUPON_CODE = "DAILYFUNDED30"
NETWORKS = {
    "usdt": {"trc20", "erc20", "bep20"},
    "btc": {"btc_native", "btc_bep20"},
    "eth": {"eth_erc20", "eth_bep20"},
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
        if scheme.lower() != "bearer" or not token:
            return jsonify(error="Sign in is required."), 401
        try:
            firebase_app = get_firebase_app()
        except Exception:
            app.logger.exception("Firebase Admin authentication is not configured correctly")
            return jsonify(error="Firebase Admin authentication is unavailable. Check the service-account credentials and project configuration."), 503
        try:
            claims = firebase_auth.verify_id_token(token, app=firebase_app)
        except Exception:
            app.logger.info("Rejected invalid Firebase ID token", exc_info=True)
            return jsonify(error="Invalid or expired Firebase ID token."), 401
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


def read_json_object():
    payload = request.get_json(silent=True)
    return payload if isinstance(payload, dict) else {}


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
    list_price = CATALOG[plan_key]["prices"][size] * 100
    normalized_coupon = str(coupon_code or "").strip().upper()
    if normalized_coupon and normalized_coupon != COUPON_CODE:
        raise ValueError("Invalid coupon code.")
    discount = (list_price * 30 + 50) // 100 if normalized_coupon == COUPON_CODE else 0
    return list_price, discount, list_price - discount, (COUPON_CODE if discount else None)


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


def firebase_service_error(service_name, error):
    error_type = type(error).__name__
    return jsonify(error=f"{service_name} unavailable ({error_type}). Configure Firebase Admin credentials and verify project access."), 503


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


class CloudflareTradingApiError(Exception):
    def __init__(self, code, message, status_code=502, worker_status=None):
        super().__init__(message)
        self.code = code
        self.status_code = status_code
        self.worker_status = worker_status


WORKER_TRADING_ERRORS = {
    "trading_disabled": ("Trading is disabled for this account.", 409),
    "market_unavailable": ("Current market data is unavailable. No order was placed.", 503),
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
            upstream_payload = json.loads(upstream_body) if len(upstream_body) <= MAX_CLOUDFLARE_RESPONSE_BYTES else {}
        except (OSError, TypeError, ValueError):
            upstream_payload = {}
        upstream_code = upstream_payload.get("code") if isinstance(upstream_payload, dict) else None
        if upstream_code in WORKER_TRADING_ERRORS:
            message, status_code = WORKER_TRADING_ERRORS[upstream_code]
            raise CloudflareTradingApiError(
                upstream_code,
                message,
                status_code,
                error.code,
            ) from None
        public_status = error.code if error.code in {400, 404, 409, 422} else 502
        raise CloudflareTradingApiError(
            "worker_http_error",
            "Cloudflare trading API could not process the request.",
            public_status,
            error.code,
        ) from None
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
        public_status = worker_status if worker_status in {400, 404, 409, 422} else 502
        raise CloudflareTradingApiError(
            "worker_http_error",
            "Cloudflare trading API could not process the request.",
            public_status,
            worker_status,
        )
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
        return jsonify(success=False, error=str(error), code=error.code), error.status_code

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
    return jsonify(authenticated=True, uid=g.firebase_uid, email=email), 201


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
    profile = user_document(g.firebase_uid).get().to_dict() or {}
    email = g.firebase_claims.get("email") or profile.get("email")
    return jsonify(authenticated=True, uid=g.firebase_uid, email=email, profile=firestore_json(profile))


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
            "label": plan["label"],
            "plan": plan_key,
            "size": row.get("accountSize"),
            "phase": row.get("phase"),
            "status": row.get("status"),
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
            "paymentCurrency": data.get("paymentCurrency"),
            "paymentNetwork": data.get("paymentNetwork"),
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
        if status != "approved" and not purchase_status_is_pending(status):
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

        reviewed_at = data.get("reviewedAt") or firestore.SERVER_TIMESTAMP
        reviewed_by = data.get("reviewedBy") or g.firebase_uid
        account_fields = {
            "ownerUid": values["ownerUid"],
            "purchaseId": values["purchaseId"],
            "accountId": values["accountId"],
            "planKey": values["planKey"],
            "accountSize": values["accountSize"],
            "userUid": values["ownerUid"],
            "phase": "instant" if values["planKey"] == "instant" else "phase_1",
        }

        if status != "approved":
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
    if engine_account_id is None:
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
            engine_account_id = provisioned_account["id"].strip()
        except CloudflareProvisioningError as error:
            return jsonify(
                error=str(error),
                code=error.code,
                workerStatus=error.worker_status,
            ), error.status_code

        @firestore.transactional
        def save_engine_account_id(transaction):
            current_purchase = purchase.reference.get(transaction=transaction).to_dict() or {}
            if current_purchase.get("status") != "approved":
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
            if not saved_id:
                transaction.update(account_ref, {
                    "tradingEngineAccountId": engine_account_id,
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

    @firestore.transactional
    def enable_trading(transaction):
        current_purchase = purchase.reference.get(transaction=transaction).to_dict() or {}
        if current_purchase.get("status") != "approved":
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
        ):
            return False

        reviewed_at = current_purchase.get("reviewedAt") or firestore.SERVER_TIMESTAMP
        reviewed_by = current_purchase.get("reviewedBy") or g.firebase_uid
        transaction.update(account_ref, {
            "userUid": purchase_values["ownerUid"],
            "phase": "instant" if purchase_values["planKey"] == "instant" else "phase_1",
            "balance": purchase_values["accountSize"],
            "equity": purchase_values["accountSize"],
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
                "tradingEnabled": False,
                "reviewedBy": g.firebase_uid,
                "reviewedAt": reviewed_at,
                "audit": audit,
            })
        return True

    rejected = reject_in_transaction(transaction)
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
    available = account.get("withdrawableProfit")
    if not isinstance(available, (int, float)):
        return jsonify(error="Payout requests are unavailable until funded-account balances are connected."), 503

    method = str(payload.get("method", "")).lower()
    method_rules = {
        "crypto": {"minimum": Decimal("50"), "fee": Decimal("0"), "fields": {"walletAddress"}},
        "rise": {"minimum": Decimal("100"), "fee": Decimal("0"), "fields": {"riseAccount"}},
        "bank": {"minimum": Decimal("100"), "fee": Decimal("12"), "fields": {"accountName", "bankName", "accountNumber", "routingCode"}},
    }
    rules = method_rules.get(method)
    destination = payload.get("destination")
    if not rules or not isinstance(destination, dict) or any(
        not isinstance(destination.get(field), str) or not destination[field].strip()
        for field in rules["fields"]
    ):
        return jsonify(error="Enter valid payout method and destination details."), 400
    try:
        amount = Decimal(str(payload.get("amountUsd", "")))
    except (InvalidOperation, ValueError):
        return jsonify(error="Enter a valid payout amount."), 400
    if not amount.is_finite() or amount.quantize(Decimal("0.01")) != amount or amount < rules["minimum"]:
        return jsonify(error=f"Minimum payout for {method} is ${rules['minimum']:.2f}."), 400
    if amount > Decimal(str(available)):
        return jsonify(error="Payout amount exceeds the available account balance."), 400

    network = payload.get("network") if method == "crypto" else None
    if method == "crypto" and (not isinstance(network, str) or not network.strip()):
        return jsonify(error="Select a crypto payout network."), 400
    amount_cents = int(amount * 100)
    fee_cents = int(rules["fee"] * 100)
    request_id = str(uuid.uuid4())
    payout_request_data = {
        "ownerUid": g.firebase_uid,
        "accountId": account_id,
        "method": method,
        "amountCents": amount_cents,
        "feeCents": fee_cents,
        "netAmountCents": amount_cents - fee_cents,
        "currency": "USD",
        "network": network,
        "destination": {key: value.strip() for key, value in destination.items() if key in rules["fields"]},
        "status": "pending_review",
        "createdAt": firestore.SERVER_TIMESTAMP,
    }
    user_document(g.firebase_uid).collection("payoutRequests").document(request_id).set(payout_request_data)
    return jsonify(requestId=request_id, status="pending_review"), 201


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", "8080")), debug=False)