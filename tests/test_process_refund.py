import json

import pytest


def _body(resp):
    return json.loads(resp["body"])


def test_successful_refund(refund_handler):
    resp = refund_handler.handler(
        {"order_id": "ORD-1001", "amount": 100, "reason": "defective item"}, None
    )
    body = _body(resp)
    assert resp["statusCode"] == 200
    assert body["status"] == "COMPLETED"
    assert body["idempotent_replay"] is False
    assert body["refund_id"]


def test_retry_with_same_key_does_not_duplicate(refund_handler):
    """A retried refund returns the original result instead of charging twice."""
    event = {"order_id": "ORD-1001", "amount": 250, "reason": "return", "idempotency_key": "op-abc-123"}

    first = _body(refund_handler.handler(event, None))
    second = _body(refund_handler.handler(event, None))

    assert first["idempotent_replay"] is False
    assert second["idempotent_replay"] is True
    assert second["refund_id"] == first["refund_id"]


def test_derived_key_is_idempotent_without_explicit_key(refund_handler):
    event = {"order_id": "ORD-1002", "amount": 75, "reason": "changed mind"}
    first = _body(refund_handler.handler(event, None))
    second = _body(refund_handler.handler(event, None))
    assert second["refund_id"] == first["refund_id"]
    assert second["idempotent_replay"] is True


@pytest.mark.parametrize(
    "bad_amount",
    ["100", 100.5, True, 0, -5, None],
)
def test_invalid_amount_returns_400(refund_handler, bad_amount):
    """Failure scenario: invalid parameters are rejected before any charge."""
    resp = refund_handler.handler(
        {"order_id": "ORD-1001", "amount": bad_amount, "reason": "x"}, None
    )
    assert resp["statusCode"] == 400


def test_missing_reason_returns_400(refund_handler):
    resp = refund_handler.handler({"order_id": "ORD-1001", "amount": 100}, None)
    assert resp["statusCode"] == 400


def test_transient_failure_is_retried_with_backoff(refund_handler, monkeypatch):
    """Failure scenario: ORD-FLAKY fails twice then succeeds; backoff sleeps."""
    sleeps = []
    monkeypatch.setattr(refund_handler.time, "sleep", lambda s: sleeps.append(s))

    resp = refund_handler.handler(
        {"order_id": "ORD-FLAKY", "amount": 100, "reason": "defective"}, None
    )
    body = _body(resp)
    assert resp["statusCode"] == 200
    assert body["status"] == "COMPLETED"
    # Two transient failures -> two backoff sleeps with growing delays.
    assert len(sleeps) == 2
    assert sleeps[1] > sleeps[0]
