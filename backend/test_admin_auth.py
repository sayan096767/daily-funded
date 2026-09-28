import unittest

from flask import g

from app import app, require_admin


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


if __name__ == "__main__":
    unittest.main()