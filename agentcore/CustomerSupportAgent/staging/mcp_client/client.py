"""MCP client factory for the Customer Support agent.

The agent reaches its business tools (order lookup, customer lookup, refund)
through an AgentCore Gateway that speaks MCP over streamable HTTP. The gateway
uses ``AWS_IAM`` inbound auth, so every request must be SigV4-signed with the
runtime's task-role credentials. ``streamablehttp_client`` does not sign
requests on its own, so we attach an ``httpx.Auth`` implementation that signs
each outgoing request.
"""

import logging
import os

import botocore.session
import httpx
from botocore.auth import SigV4Auth
from botocore.awsrequest import AWSRequest
from mcp.client.streamable_http import streamablehttp_client
from strands.tools.mcp.mcp_client import MCPClient

logger = logging.getLogger(__name__)

# AgentCore data-plane signing service.
_SIGV4_SERVICE = "bedrock-agentcore"

# Environment variables the gateway URL may be published under. AgentCore injects
# ``AGENTCORE_GATEWAY_<NAME>_URL`` (name upper-cased, hyphens -> underscores).
_GATEWAY_URL_ENV_VARS = (
    "AGENTCORE_GATEWAY_CUSTOMER_SUPPORT_GW_URL",
    "CUSTOMER_SUPPORT_GATEWAY_URL",
)


class SigV4HTTPXAuth(httpx.Auth):
    """Signs outgoing httpx requests with AWS SigV4.

    Credentials are read from the ambient environment (the AgentCore runtime task
    role in the cloud), never hardcoded. They are frozen per request so rotating
    credentials keep working and signing is thread-safe.
    """

    requires_request_body = True

    def __init__(self, credentials, service: str, region: str):
        self._credentials = credentials
        self._service = service
        self._region = region

    def auth_flow(self, request):
        frozen = self._credentials.get_frozen_credentials()
        aws_request = AWSRequest(
            method=request.method,
            url=str(request.url),
            data=request.content,
            headers=dict(request.headers),
        )
        SigV4Auth(frozen, self._service, self._region).add_auth(aws_request)
        request.headers.update(dict(aws_request.headers))
        yield request


def _gateway_url() -> str | None:
    for name in _GATEWAY_URL_ENV_VARS:
        value = os.getenv(name)
        if value:
            return value
    return None


def get_gateway_mcp_client() -> MCPClient | None:
    """Return a SigV4-signed MCP client for the AgentCore Gateway.

    Returns ``None`` when the gateway URL is not configured (for example during
    local development before the gateway is deployed) or when no AWS credentials
    are available to sign requests, so the agent can still start without it.
    """
    url = _gateway_url()
    if not url:
        logger.info("Gateway URL not set; skipping gateway MCP client.")
        return None

    credentials = botocore.session.Session().get_credentials()
    if credentials is None:
        logger.warning("No AWS credentials available to sign gateway requests; skipping gateway MCP client.")
        return None

    region = os.getenv("AWS_REGION", "us-east-1")
    auth = SigV4HTTPXAuth(credentials, _SIGV4_SERVICE, region)
    return MCPClient(lambda: streamablehttp_client(url, auth=auth))
