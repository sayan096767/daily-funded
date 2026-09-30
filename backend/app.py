import os
import re
import uuid
import hashlib
import json
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
from urllib.parse import urlsplit
from urllib.request import Request, urlopen


FRONTEND_ORIGINS = {
    origin.strip().rstrip("/")
    for origin in os.environ.get("DAILYFUNDED_FRONTEND_ORIGINS", "").split(",")
    if origin.strip()
}
MAX_PROOF_BYTES = 5 * 1024 * 1024

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
        "rules": ["Ph 1: 8% / Ph 2: 5%", "5% daily drawdown", "10% max drawdown", "5 min trading days", "7 day reward cycle"],
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
            "status": row.get("status"),
            "balance": row.get("balance"),
            "equity": row.get("equity"),
            "profit": row.get("profit"),
            "dailyDrawdown": row.get("dailyDrawdown"),
            "overallDrawdown": row.get("overallDrawdown"),
            "tradingDays": row.get("tradingDays"),
            "withdrawableProfit": row.get("withdrawableProfit"),
            "createdAt": row.get("createdAt"),
            "rules": plan["rules"],
            "profitSplit": plan["profit_split"],
        })
    return jsonify(firestore_json(accounts))


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
    transaction = database.transaction()

    @firestore.transactional
    def approve_in_transaction(transaction):
        snapshot = purchase.reference.get(transaction=transaction)
        data = snapshot.to_dict() or {}
        if data.get("status") == "approved":
            return "approved", True
        if not purchase_status_is_pending(data.get("status")):
            return None, False

        owner_uid = data.get("ownerUid")
        account_id = data.get("accountId")
        if not isinstance(owner_uid, str) or not owner_uid.strip() or not isinstance(account_id, str) or not account_id.strip():
            return "invalid", False

        account_ref = user_document(owner_uid).collection("accounts").document(account_id)
        account_snapshot = account_ref.get(transaction=transaction)
        reviewed_at = firestore.SERVER_TIMESTAMP
        transaction.update(purchase.reference, {
            "status": "approved",
            "reviewedBy": g.firebase_uid,
            "reviewedAt": reviewed_at,
            "audit": {"approvedBy": g.firebase_uid, "approvedAt": reviewed_at},
        })
        account_update = {
            "ownerUid": owner_uid,
            "purchaseId": purchase_id,
            "accountId": account_id,
            "planKey": data.get("planKey"),
            "accountSize": data.get("accountSize"),
            "status": "active",
            "reviewedBy": g.firebase_uid,
            "reviewedAt": reviewed_at,
            "audit": {"approvedBy": g.firebase_uid, "approvedAt": reviewed_at},
        }
        if account_snapshot.exists:
            transaction.update(account_ref, account_update)
        else:
            account_update.update({
                "balance": None, "equity": None, "profit": None,
                "dailyDrawdown": None, "overallDrawdown": None,
                "tradingDays": None, "createdAt": reviewed_at,
            })
            transaction.set(account_ref, account_update)
        return "approved", False

    status, already_approved = approve_in_transaction(transaction)
    if status == "invalid":
        return jsonify(error="Purchase is missing account ownership information."), 400
    if status is None:
        return jsonify(error="Purchase is not currently awaiting payment verification."), 409
    return jsonify(
        purchaseId=purchase_id, status=status, reviewedBy=g.firebase_uid,
        alreadyApproved=already_approved,
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