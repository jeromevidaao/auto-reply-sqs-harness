#!/usr/bin/env python3
"""Create CloudWatch + EventBridge monitoring for HE pre-approval expire unblock.

Out of band (GitHub deploy OIDC cannot create alarms / queues).

- Metric filter HE_EXPIRE_HARD_FAIL on guest-messaging-agent-harness logs
- Alarm he-preapproval-expire-unblock-failed → SNS email jerome.ans@gmail.com
- EventBridge target: 4 retries / 1h then SQS he-preapproval-expire-dl
- DLQ alarm emails the same address
"""
from __future__ import annotations

import json
import subprocess
import sys

REGION = "us-east-1"
ACCOUNT = "834917996497"
FUNCTION = "guest-messaging-agent-harness"
LOG_GROUP = f"/aws/lambda/{FUNCTION}"
SNS_ALERTS = f"arn:aws:sns:{REGION}:{ACCOUNT}:guest-messaging-agent-harness-alerts"
SNS_DLQ = f"arn:aws:sns:{REGION}:{ACCOUNT}:homeexchange-dlq-alerts"
QUEUE_NAME = "he-preapproval-expire-dl"
RULE = "he-preapproval-expire"
FILTER_NAME = "he-expire-hard-fail"
METRIC_NS = "CleaningButton/HomeExchange"
METRIC_NAME = "ExpireUnblockFailures"
ALARM_EXPIRE = "he-preapproval-expire-unblock-failed"
ALARM_DLQ = "he-preapproval-expire-dlq-has-messages"
EMAIL = "jerome.ans@gmail.com"
HE_FILTER = '"HE_EXPIRE_HARD_FAIL"'


def run(args, input_text=None):
    print("+", " ".join(args))
    result = subprocess.run(
        args,
        input=input_text,
        text=True,
        capture_output=True,
        check=False,
    )
    if result.returncode != 0:
        sys.stderr.write(result.stderr)
        raise SystemExit(result.returncode)
    return result.stdout


def main():
    # SNS email is already on guest-messaging-agent-harness-alerts; confirm.
    subs = json.loads(
        run(
            [
                "aws",
                "sns",
                "list-subscriptions-by-topic",
                "--topic-arn",
                SNS_ALERTS,
                "--region",
                REGION,
                "--output",
                "json",
            ]
        )
    )
    emails = [
        s.get("Endpoint")
        for s in subs.get("Subscriptions", [])
        if s.get("Protocol") == "email"
    ]
    if EMAIL not in emails:
        print(f"subscribe {EMAIL} to {SNS_ALERTS}")
        run(
            [
                "aws",
                "sns",
                "subscribe",
                "--topic-arn",
                SNS_ALERTS,
                "--protocol",
                "email",
                "--notification-endpoint",
                EMAIL,
                "--region",
                REGION,
            ]
        )
    else:
        print(f"SNS already emails {EMAIL}")

    run(
        [
            "aws",
            "logs",
            "put-metric-filter",
            "--region",
            REGION,
            "--log-group-name",
            LOG_GROUP,
            "--filter-name",
            FILTER_NAME,
            "--filter-pattern",
            HE_FILTER,
            "--metric-transformations",
            json.dumps(
                [
                    {
                        "metricName": METRIC_NAME,
                        "metricNamespace": METRIC_NS,
                        "metricValue": "1",
                        "defaultValue": 0,
                    }
                ]
            ),
        ]
    )

    run(
        [
            "aws",
            "cloudwatch",
            "put-metric-alarm",
            "--region",
            REGION,
            "--alarm-name",
            ALARM_EXPIRE,
            "--alarm-description",
            "HE pre-approval expired but freeing Hospitable nights failed after retries. Lambda failed hard.",
            "--namespace",
            METRIC_NS,
            "--metric-name",
            METRIC_NAME,
            "--statistic",
            "Sum",
            "--period",
            "60",
            "--evaluation-periods",
            "1",
            "--threshold",
            "1",
            "--comparison-operator",
            "GreaterThanOrEqualToThreshold",
            "--treat-missing-data",
            "notBreaching",
            "--alarm-actions",
            SNS_ALERTS,
            "--ok-actions",
            SNS_ALERTS,
        ]
    )

    queue_url = run(
        [
            "aws",
            "sqs",
            "create-queue",
            "--queue-name",
            QUEUE_NAME,
            "--region",
            REGION,
            "--attributes",
            json.dumps({"MessageRetentionPeriod": "1209600"}),
            "--query",
            "QueueUrl",
            "--output",
            "text",
        ]
    ).strip()
    queue_arn = run(
        [
            "aws",
            "sqs",
            "get-queue-attributes",
            "--queue-url",
            queue_url,
            "--attribute-names",
            "QueueArn",
            "--region",
            REGION,
            "--query",
            "Attributes.QueueArn",
            "--output",
            "text",
        ]
    ).strip()

    policy = {
        "Version": "2012-10-17",
        "Statement": [
            {
                "Sid": "AllowEventBridgeExpireDlq",
                "Effect": "Allow",
                "Principal": {"Service": "events.amazonaws.com"},
                "Action": "sqs:SendMessage",
                "Resource": queue_arn,
                "Condition": {
                    "ArnEquals": {
                        "aws:SourceArn": f"arn:aws:events:{REGION}:{ACCOUNT}:rule/{RULE}"
                    }
                },
            }
        ],
    }
    run(
        [
            "aws",
            "sqs",
            "set-queue-attributes",
            "--queue-url",
            queue_url,
            "--region",
            REGION,
            "--attributes",
            json.dumps({"Policy": json.dumps(policy)}),
        ]
    )

    run(
        [
            "aws",
            "events",
            "put-targets",
            "--rule",
            RULE,
            "--region",
            REGION,
            "--targets",
            json.dumps(
                [
                    {
                        "Id": "harness",
                        "Arn": f"arn:aws:lambda:{REGION}:{ACCOUNT}:function:{FUNCTION}",
                        "Input": json.dumps(
                            {"queryStringParameters": {"act": "homeexchange_expire_blocks"}}
                        ),
                        "RetryPolicy": {
                            "MaximumRetryAttempts": 4,
                            "MaximumEventAgeInSeconds": 3600,
                        },
                        "DeadLetterConfig": {"Arn": queue_arn},
                    }
                ]
            ),
        ]
    )

    run(
        [
            "aws",
            "cloudwatch",
            "put-metric-alarm",
            "--region",
            REGION,
            "--alarm-name",
            ALARM_DLQ,
            "--alarm-description",
            "EventBridge could not invoke expire-unblock after 4 retries / 1h. Hospitable nights may still be blocked.",
            "--namespace",
            "AWS/SQS",
            "--metric-name",
            "ApproximateNumberOfMessagesVisible",
            "--dimensions",
            f"Name=QueueName,Value={QUEUE_NAME}",
            "--statistic",
            "Maximum",
            "--period",
            "60",
            "--evaluation-periods",
            "1",
            "--threshold",
            "1",
            "--comparison-operator",
            "GreaterThanOrEqualToThreshold",
            "--treat-missing-data",
            "notBreaching",
            "--alarm-actions",
            SNS_DLQ,
        ]
    )

    print("ok", {"queue": queue_arn, "alarm": ALARM_EXPIRE, "dlqAlarm": ALARM_DLQ})


if __name__ == "__main__":
    main()
