import json


def test_known_order_returns_200(check_order_handler):
    resp = check_order_handler.handler({"order_id": "ORD-123"}, None)
    body = json.loads(resp["body"])
    assert resp["statusCode"] == 200
    assert body["status"] == "delayed"
    assert body["delay_reason"]


def test_numeric_order_id_is_normalized(check_order_handler):
    resp = check_order_handler.handler({"order_id": "1001"}, None)
    body = json.loads(resp["body"])
    assert resp["statusCode"] == 200
    assert body["order_id"] == "ORD-1001"


def test_unknown_order_returns_404(check_order_handler):
    resp = check_order_handler.handler({"order_id": "ORD-DOESNOTEXIST"}, None)
    assert resp["statusCode"] == 404


def test_timeout_trigger_sleeps_past_lambda_timeout(check_order_handler, monkeypatch):
    """Failure scenario: ORD-TIMEOUT sleeps longer than the Lambda timeout."""
    recorded = {}
    monkeypatch.setattr(check_order_handler.time, "sleep", lambda s: recorded.setdefault("seconds", s))
    check_order_handler.handler({"order_id": "ORD-TIMEOUT"}, None)
    assert recorded["seconds"] >= 300


def test_error_trigger_raises(check_order_handler):
    """Failure scenario: ORD-500 raises an unhandled error (surfaces in traces)."""
    import pytest

    with pytest.raises(RuntimeError):
        check_order_handler.handler({"order_id": "ORD-500"}, None)
