"""Shared pytest fixtures for the tool-handler tests.

Each tool Lambda lives in its own directory and its entry module is named
``handler``. Because three modules share that name, they are loaded by file path
under unique module names instead of via the import system.
"""

import importlib.util
import pathlib
import sys

import pytest

ROOT = pathlib.Path(__file__).resolve().parents[1]


def load_module(rel_path, name):
    path = ROOT / rel_path
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


@pytest.fixture
def check_order_handler():
    return load_module("tools/check_order/handler.py", "check_order_handler")


@pytest.fixture
def get_customer_handler():
    return load_module("tools/get_customer/handler.py", "get_customer_handler")


@pytest.fixture
def refund_handler(monkeypatch):
    """Load the refund handler with a moto-mocked DynamoDB table in place."""
    from moto import mock_aws

    monkeypatch.setenv("AWS_ACCESS_KEY_ID", "testing")
    monkeypatch.setenv("AWS_SECRET_ACCESS_KEY", "testing")
    monkeypatch.setenv("AWS_SECURITY_TOKEN", "testing")
    monkeypatch.setenv("AWS_SESSION_TOKEN", "testing")
    monkeypatch.setenv("AWS_DEFAULT_REGION", "us-east-1")
    monkeypatch.setenv("AWS_REGION", "us-east-1")
    monkeypatch.setenv("IDEMPOTENCY_TABLE", "TestRefundIdempotency")

    with mock_aws():
        import boto3

        boto3.resource("dynamodb", region_name="us-east-1").create_table(
            TableName="TestRefundIdempotency",
            KeySchema=[{"AttributeName": "idempotency_key", "KeyType": "HASH"}],
            AttributeDefinitions=[{"AttributeName": "idempotency_key", "AttributeType": "S"}],
            BillingMode="PAY_PER_REQUEST",
        )
        yield load_module("tools/process_refund/handler.py", "process_refund_handler")
