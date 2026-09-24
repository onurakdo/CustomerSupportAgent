import json


def test_lookup_by_customer_id(get_customer_handler):
    resp = get_customer_handler.handler({"customer_id": "CUST-1"}, None)
    body = json.loads(resp["body"])
    assert resp["statusCode"] == 200
    assert body["name"] == "Sarah Chen"
    assert body["tier"] == "premium"


def test_lookup_by_email(get_customer_handler):
    resp = get_customer_handler.handler({"customer_id": "alex@example.com"}, None)
    body = json.loads(resp["body"])
    assert resp["statusCode"] == 200
    assert body["customer_id"] == "CUST-2"


def test_unknown_customer_returns_404(get_customer_handler):
    resp = get_customer_handler.handler({"customer_id": "CUST-999"}, None)
    assert resp["statusCode"] == 404
