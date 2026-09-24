"""AgentCore Gateway tool: get_customer.

Deployed as an AWS Lambda and exposed through AgentCore Gateway as an MCP tool.
The Gateway passes tool parameters directly in ``event``.
"""

import json

_CUSTOMERS = {
    "CUST-1": {"name": "Sarah Chen", "email": "sarah@example.com", "tier": "premium", "lifetime_orders": 42},
    "CUST-2": {"name": "Alex Kim", "email": "alex@example.com", "tier": "standard", "lifetime_orders": 7},
}

_BY_EMAIL = {c["email"]: cid for cid, c in _CUSTOMERS.items()}


def _response(status_code, payload):
    return {"statusCode": status_code, "body": json.dumps(payload)}


def handler(event, context):
    raw = str(event.get("customer_id") or "").strip()
    customer_id = _BY_EMAIL.get(raw.lower(), "") if "@" in raw else raw.upper()

    customer = _CUSTOMERS.get(customer_id)
    if not customer:
        return _response(404, {"error": f"No customer found for '{raw}'"})

    return _response(200, {"customer_id": customer_id, **customer})
