"""Grant or remove an admin claim in a local Firebase Auth Emulator only."""

import argparse
import os
import sys
from urllib.parse import urlsplit

import firebase_admin
from firebase_admin import auth


def parse_args():
    parser = argparse.ArgumentParser(
        description="Manage admin custom claims in a local Firebase Auth Emulator only."
    )
    actions = parser.add_subparsers(dest="action", required=True)
    for action in ("grant", "remove"):
        command = actions.add_parser(action)
        command.add_argument("--uid", required=True, help="Firebase Auth UID to update")
    return parser, parser.parse_args()


def emulator_project_id(parser):
    emulator_host = os.environ.get("FIREBASE_AUTH_EMULATOR_HOST", "")
    hostname = urlsplit(f"//{emulator_host}").hostname if emulator_host else None
    if hostname not in {"localhost", "127.0.0.1", "::1"}:
        parser.error("FIREBASE_AUTH_EMULATOR_HOST must point to localhost; production is refused.")

    project_id = os.environ.get("GOOGLE_CLOUD_PROJECT", "")
    if not project_id.startswith("demo-"):
        parser.error("Set GOOGLE_CLOUD_PROJECT to a demo-* emulator project ID.")
    return project_id


def main():
    parser, args = parse_args()
    project_id = emulator_project_id(parser)
    action_label = "GRANT ADMIN" if args.action == "grant" else "REMOVE ADMIN"
    print("LOCAL AUTH EMULATOR ONLY. This tool refuses non-local hosts and non-demo projects.")
    if args.action == "grant":
        print("WARNING: this grants administrative privileges to the specified Firebase UID.")
    confirmation = input(f"Type '{action_label} {args.uid}' to continue: ")
    if confirmation != f"{action_label} {args.uid}":
        print("Cancelled; no claim was changed.")
        return 1

    try:
        firebase_admin.initialize_app(options={"projectId": project_id})
        user = auth.get_user(args.uid)
        claims = dict(user.custom_claims or {})
        if args.action == "grant":
            if claims.get("admin") is True:
                print("The admin claim is already present; no change made.")
                return 0
            claims["admin"] = True
        else:
            if "admin" not in claims:
                print("The admin claim is already absent; no change made.")
                return 0
            del claims["admin"]

        auth.set_custom_user_claims(args.uid, claims or None)
    except Exception as error:
        print(f"Claim update failed ({type(error).__name__}); no credentials were printed.", file=sys.stderr)
        return 1

    print(f"Admin claim {('granted' if args.action == 'grant' else 'removed')} in the local emulator.")
    print("Refresh the user's Firebase ID token by signing out/in or forcing a token refresh.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())