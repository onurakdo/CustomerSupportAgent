"""AgentCore Gateway tool: check_order.

Deployed as an AWS Lambda and exposed through AgentCore Gateway as an MCP tool.
The Gateway passes tool parameters directly in ``event`` (not ``event['body']``);
the invoked tool name is available in
``context.client_context.custom['bedrockAgentCoreToolName']``.
"""

import json
import time

# Deterministic triggers that produce traceable failure scenarios in telemetry.
_TIMEOUT_ORDER_ID = "ORD-TIMEOUT"
_ERROR_ORDER_ID = "ORD-500"

_ORDERS = {
    "ORD-123": {
        "status": "delayed",
        "item": "Smart Watch",
        "customer_id": "CUST-1",
        "estimated_delivery": "2026-10-02",
        "delay_reason": "Carrier delay caused by severe weather at the regional hub",
    },
    "ORD-1001": {
        "status": "delivered",
        "item": "Wireless Headphones",
        "customer_id": "CUST-1",
        "estimated_delivery": "2026-09-18",
        "delay_reason": None,
    },
    "ORD-1002": {
        "status": "shipped",
        "item": "USB-C Hub",
        "customer_id": "CUST-2",
        "estimated_delivery": "2026-09-27",
        "delay_reason": None,
    },
    "ORD-2002": {
        "status": "processing",
        "item": "Mechanical Keyboard",
        "customer_id": "CUST-2",
        "estimated_delivery": "2026-10-05",
        "delay_reason": None,
    },
}


def _response(status_code, payload):
    return {"statusCode": status_code, "body": json.dumps(payload)}


def _normalize(order_id):
    oid = str(order_id or "").strip().upper()
    if oid.isdigit():
        oid = f"ORD-{oid}"
    return oid


def handler(event, context):
    order_id = _normalize(event.get("order_id"))

    if order_id == _TIMEOUT_ORDER_ID:
        # Sleeps past the configured Lambda timeout to emit a tool-timeout trace.
        time.sleep(300)

    if order_id == _ERROR_ORDER_ID:
        raise RuntimeError("Unhandled downstream failure while fetching order (simulated HTTP 500)")

    order = _ORDERS.get(order_id)
    if not order:
        return _response(404, {"error": f"No order found for '{order_id}'"})

    return _response(200, {"order_id": order_id, **order})
