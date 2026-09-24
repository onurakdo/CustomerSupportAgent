"""AgentCore Gateway tool: process_refund.

Idempotent refund processing backed by DynamoDB, exposed through AgentCore
Gateway as an MCP tool. Transient payment-provider failures are retried with
exponential backoff. The $1,000 refund limit is enforced upstream by the
AgentCore Gateway Cedar policy (deterministic and prompt-independent), so it is
intentionally not re-checked here.
"""

import hashlib
import json
import os
import time
import uuid

import boto3
from botocore.config import Config
from botocore.exceptions import ClientError

_TABLE_NAME = os.environ.get("IDEMPOTENCY_TABLE", "CustomerSupportAgent-RefundIdempotency")
_FLAKY_ORDER_ID = "ORD-FLAKY"  # forces transient charge failures to exercise backoff

_MAX_CHARGE_ATTEMPTS = 5
_BACKOFF_BASE_SECONDS = 0.5

_ddb = boto3.resource(
    "dynamodb",
    region_name=os.environ.get("AWS_REGION", "us-east-1"),
    config=Config(retries={"mode": "adaptive", "total_max_attempts": 5}),
)


class TransientChargeError(Exception):
    """A retryable payment-provider failure."""


def _response(status_code, payload):
    return {"statusCode": status_code, "body": json.dumps(payload)}


def _derive_key(order_id, amount, reason):
    return hashlib.sha256(f"{order_id}:{amount}:{reason}".encode()).hexdigest()[:32]


def _charge(order_id, amount, attempt):
    if order_id.upper() == _FLAKY_ORDER_ID and attempt < 3:
        raise TransientChargeError("payment provider temporarily unavailable")
    return f"rfnd_{uuid.uuid4().hex[:16]}"


def _charge_with_backoff(order_id, amount, sleep=None):
    do_sleep = sleep if sleep is not None else time.sleep
    last_error = None
    for attempt in range(1, _MAX_CHARGE_ATTEMPTS + 1):
        try:
            return _charge(order_id, amount, attempt)
        except TransientChargeError as exc:
            last_error = exc
            if attempt == _MAX_CHARGE_ATTEMPTS:
                break
            do_sleep(_BACKOFF_BASE_SECONDS * (2 ** (attempt - 1)))
    raise TransientChargeError(f"charge failed after {_MAX_CHARGE_ATTEMPTS} attempts: {last_error}")


def _validate(event):
    order_id = str(event.get("order_id") or "").strip()
    reason = str(event.get("reason") or "").strip()
    amount = event.get("amount")
    if not order_id:
        return None, "order_id is required"
    if not reason:
        return None, "reason is required"
    if isinstance(amount, bool) or not isinstance(amount, int):
        return None, "amount must be an integer number of dollars"
    if amount <= 0:
        return None, "amount must be greater than zero"
    return {"order_id": order_id, "amount": amount, "reason": reason}, None


def handler(event, context):
    parsed, error = _validate(event)
    if error:
        return _response(400, {"error": error})

    order_id, amount, reason = parsed["order_id"], parsed["amount"], parsed["reason"]
    idem_key = str(event.get("idempotency_key") or "").strip() or _derive_key(order_id, amount, reason)

    table = _ddb.Table(_TABLE_NAME)

    # Claim the idempotency key; a failed condition means this is a retry.
    try:
        table.put_item(
            Item={"idempotency_key": idem_key, "status": "PENDING", "order_id": order_id, "amount": amount},
            ConditionExpression="attribute_not_exists(idempotency_key)",
        )
    except ClientError as exc:
        if exc.response["Error"]["Code"] != "ConditionalCheckFailedException":
            raise
        existing = table.get_item(Key={"idempotency_key": idem_key}).get("Item", {})
        return _response(200, {
            "refund_id": existing.get("refund_id"),
            "order_id": existing.get("order_id", order_id),
            "amount": int(existing.get("amount", amount)),
            "status": existing.get("status", "COMPLETED"),
            "idempotent_replay": True,
        })

    refund_id = _charge_with_backoff(order_id, amount)

    table.update_item(
        Key={"idempotency_key": idem_key},
        UpdateExpression="SET #s = :c, refund_id = :r",
        ExpressionAttributeNames={"#s": "status"},
        ExpressionAttributeValues={":c": "COMPLETED", ":r": refund_id},
    )

    return _response(200, {
        "refund_id": refund_id,
        "order_id": order_id,
        "amount": amount,
        "status": "COMPLETED",
        "idempotent_replay": False,
    })
