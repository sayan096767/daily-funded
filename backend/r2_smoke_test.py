import os
import struct
import sys
import uuid
import zlib


def png_chunk(kind, data):
    return (
        struct.pack(">I", len(data))
        + kind
        + data
        + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)
    )


def tiny_png():
    header = struct.pack(">IIBBBBB", 1, 1, 8, 6, 0, 0, 0)
    pixel = zlib.compress(b"\x00\x20\x80\xe0\xff")
    return (
        b"\x89PNG\r\n\x1a\n"
        + png_chunk(b"IHDR", header)
        + png_chunk(b"IDAT", pixel)
        + png_chunk(b"IEND", b"")
    )


required_environment = (
    "R2_ACCOUNT_ID",
    "R2_ACCESS_KEY_ID",
    "R2_SECRET_ACCESS_KEY",
    "R2_BUCKET_NAME",
    "R2_ENDPOINT",
)
credentials_available = all(os.environ.get(name, "").strip() for name in required_environment)
object_key = f"test/payment-proof-smoke/{uuid.uuid4().hex}.png"
client = None
bucket_name = None
upload_attempted = False
upload_succeeded = False
verification_succeeded = False
cleanup_succeeded = False
error_type = None

try:
    if credentials_available:
        from app import get_r2_bucket_name, get_r2_client

        client = get_r2_client()
        bucket_name = get_r2_bucket_name()
        upload_attempted = True
        image_bytes = tiny_png()
        client.put_object(
            Bucket=bucket_name,
            Key=object_key,
            Body=image_bytes,
            ContentType="image/png",
            Metadata={"smoke-test": "true"},
            IfNoneMatch="*",
        )
        upload_succeeded = True
        head = client.head_object(Bucket=bucket_name, Key=object_key)
        downloaded = client.get_object(Bucket=bucket_name, Key=object_key)
        body = downloaded["Body"]
        try:
            downloaded_bytes = body.read(len(image_bytes) + 1)
        finally:
            body.close()
        verification_succeeded = (
            head.get("ContentType") == "image/png"
            and (head.get("Metadata") or {}).get("smoke-test") == "true"
            and downloaded_bytes == image_bytes
        )
except Exception as error:
    error_type = type(error).__name__
finally:
    if upload_attempted and client is not None and bucket_name is not None:
        try:
            result = client.delete_object(Bucket=bucket_name, Key=object_key)
            status_code = (result.get("ResponseMetadata") or {}).get("HTTPStatusCode")
            cleanup_succeeded = status_code in (200, 204)
        except Exception as error:
            if error_type is None:
                error_type = type(error).__name__

if not credentials_available:
    print("R2 smoke test skipped: environment variables not configured")
else:
    print(f"R2 upload: {'success' if upload_succeeded else 'failure'}")
    print(f"R2 verification: {'success' if verification_succeeded else 'failure'}")
    print(f"R2 cleanup: {'success' if cleanup_succeeded else 'failure'}")
    if error_type:
        print(f"Exception type: {error_type}")
    sys.exit(0 if upload_succeeded and verification_succeeded and cleanup_succeeded else 1)
