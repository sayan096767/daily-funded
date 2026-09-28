import os
import re
import uuid
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation
from functools import wraps

import firebase_admin
from firebase_admin import auth as firebase_auth, firestore, storage
from flask import Flask, g, jsonify, request


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
    if origin in FRONTEND_ORIGINS:
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
            _firebase_app = firebase_admin.initialize_app(options={
                "projectId": os.environ.get("GOOGLE_CLOUD_PROJECT", "daily-funded"),
                "storageBucket": os.environ.get("FIREBASE_STORAGE_BUCKET", "daily-funded.firebasestorage.app"),
            })
    return _firebase_app


def get_firestore():
    return firestore.client(app=get_firebase_app())


def get_storage_bucket():
    return storage.bucket(app=get_firebase_app())


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
            claims = firebase_auth.verify_id_token(token, app=get_firebase_app())
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

    list_price = plan["prices"][size] * 100
    coupon = request.form.get("coupon", "").strip().upper()
    discount = (list_price * 30 + 50) // 100 if coupon == COUPON_CODE else 0
    total = list_price - discount
    purchase_id = str(uuid.uuid4())
    account_id = str(uuid.uuid4())
    uid = g.firebase_uid
    extension = {"jpeg": "jpg"}.get(proof_format, proof_format)
    proof_path = f"users/{uid}/paymentProofs/{purchase_id}.{extension}"
    content_type = {"jpeg": "image/jpeg"}.get(proof_format, f"image/{proof_format}")
    proof_blob = get_storage_bucket().blob(proof_path)
    try:
        proof_blob.upload_from_string(proof_bytes, content_type=content_type, if_generation_match=0)
        user_ref = user_document(uid)
        database = get_firestore()
        batch = database.batch()
        batch.set(user_ref.collection("purchases").document(purchase_id), {
            "ownerUid": uid,
            "accountId": account_id,
            "planKey": plan_key,
            "accountSize": size,
            "listPriceCents": list_price,
            "discountCents": discount,
            "totalCents": total,
            "couponCode": COUPON_CODE if discount else None,
            "paymentCurrency": currency,
            "paymentNetwork": network,
            "paymentProof": {
                "storagePath": proof_path,
                "format": proof_format,
                "sizeBytes": len(proof_bytes),
                "contentType": content_type,
            },
            "status": "pending_payment_verification",
            "createdAt": firestore.SERVER_TIMESTAMP,
        })
        batch.set(user_ref.collection("accounts").document(account_id), {
            "ownerUid": uid,
            "purchaseId": purchase_id,
            "planKey": plan_key,
            "accountSize": size,
            "status": "pending_payment_verification",
            "balance": None,
            "equity": None,
            "profit": None,
            "dailyDrawdown": None,
            "overallDrawdown": None,
            "tradingDays": None,
            "createdAt": firestore.SERVER_TIMESTAMP,
        })
        batch.commit()
    except Exception:
        try:
            proof_blob.delete()
        except Exception:
            app.logger.exception("Could not clean up an unreferenced payment proof")
        app.logger.exception("Could not save purchase to Firestore")
        return jsonify(error="Purchase could not be saved. Please try again."), 503

    return jsonify(
        purchaseId=purchase_id,
        accountId=account_id,
        status="pending_payment_verification",
        priceCents=list_price,
        discountCents=discount,
        totalCents=total,
        message="Payment proof received. The account remains pending until payment is verified.",
    ), 201


@app.get("/api/mt5/accounts/<account_id>")
@firebase_auth_required
def mt5_account(account_id):
    account = user_document(g.firebase_uid).collection("accounts").document(account_id).get()
    if not account.exists:
        return jsonify(error="Account not found."), 404
    return jsonify(error="MT5 demo integration is not configured."), 503


@app.get("/api/admin/purchases/pending")
@firebase_auth_required
def admin_pending_purchases():
    admin_error = require_admin()
    if admin_error is not None:
        return admin_error

    purchases = []
    for document in get_firestore().collection_group("purchases").where("status", "==", "pending_payment_verification").stream():
        data = document.to_dict() or {}
        proof = data.get("paymentProof")
        if not isinstance(proof, dict):
            proof = {}
        purchases.append({
            "purchaseId": document.id,
            "uid": data.get("ownerUid"),
            "plan": data.get("planKey"),
            "size": data.get("accountSize"),
            "amountCents": data.get("totalCents", data.get("listPriceCents")),
            "paymentCurrency": data.get("paymentCurrency"),
            "paymentNetwork": data.get("paymentNetwork"),
            "createdAt": data.get("createdAt"),
            "paymentProof": {
                "storagePath": proof.get("storagePath"),
                "format": proof.get("format"),
                "sizeBytes": proof.get("sizeBytes"),
                "contentType": proof.get("contentType"),
            },
        })
    return jsonify(purchases=firestore_json(purchases))


@app.post("/api/admin/purchases/<purchase_id>/approve")
@firebase_auth_required
def admin_approve_purchase(purchase_id):
    admin_error = require_admin()
    if admin_error is not None:
        return admin_error

    purchase = find_purchase_document(purchase_id)
    if purchase is None:
        return jsonify(error="Purchase not found."), 404

    data = purchase.to_dict() or {}
    if data.get("status") != "pending_payment_verification":
        return jsonify(error="Purchase is not currently awaiting payment verification."), 409

    owner_uid = data.get("ownerUid")
    account_id = data.get("accountId")
    if not isinstance(owner_uid, str) or not owner_uid.strip():
        return jsonify(error="Purchase is missing an owner UID."), 400

    audit = {"approvedBy": g.firebase_uid, "approvedAt": firestore.SERVER_TIMESTAMP}
    purchase.reference.update({
        "status": "paid",
        "reviewedBy": g.firebase_uid,
        "reviewedAt": firestore.SERVER_TIMESTAMP,
        "audit": audit,
    })

    if isinstance(account_id, str) and account_id.strip():
        account_ref = user_document(owner_uid).collection("accounts").document(account_id)
        account = account_ref.get()
        if account.exists:
            account_ref.update({
                "status": "paid",
                "reviewedBy": g.firebase_uid,
                "reviewedAt": firestore.SERVER_TIMESTAMP,
                "audit": audit,
            })

    return jsonify(purchaseId=purchase_id, status="paid", reviewedBy=g.firebase_uid), 200


@app.post("/api/admin/purchases/<purchase_id>/reject")
@firebase_auth_required
def admin_reject_purchase(purchase_id):
    admin_error = require_admin()
    if admin_error is not None:
        return admin_error

    purchase = find_purchase_document(purchase_id)
    if purchase is None:
        return jsonify(error="Purchase not found."), 404

    data = purchase.to_dict() or {}
    if data.get("status") != "pending_payment_verification":
        return jsonify(error="Purchase is not currently awaiting payment verification."), 409

    payload = read_json_object()
    reason = payload.get("reason")
    if reason is not None and (not isinstance(reason, str) or not reason.strip()):
        return jsonify(error="Reason must be a non-empty string when provided."), 400
    reason = reason.strip() if isinstance(reason, str) else None

    owner_uid = data.get("ownerUid")
    account_id = data.get("accountId")
    if not isinstance(owner_uid, str) or not owner_uid.strip():
        return jsonify(error="Purchase is missing an owner UID."), 400

    audit = {"rejectedBy": g.firebase_uid, "rejectedAt": firestore.SERVER_TIMESTAMP}
    if reason is not None:
        audit["reason"] = reason
    purchase.reference.update({
        "status": "payment_rejected",
        "reviewedBy": g.firebase_uid,
        "reviewedAt": firestore.SERVER_TIMESTAMP,
        "audit": audit,
    })

    if isinstance(account_id, str) and account_id.strip():
        account_ref = user_document(owner_uid).collection("accounts").document(account_id)
        account = account_ref.get()
        if account.exists:
            account_ref.update({
                "status": "payment_rejected",
                "reviewedBy": g.firebase_uid,
                "reviewedAt": firestore.SERVER_TIMESTAMP,
                "audit": audit,
            })

    return jsonify(purchaseId=purchase_id, status="payment_rejected", reviewedBy=g.firebase_uid), 200


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