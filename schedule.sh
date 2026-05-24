#!/bin/bash
set -e

# Default to US East (N. Virginia)
export AWS_DEFAULT_REGION="us-east-1"

# Usage: ./schedule.sh <secret-id> <command> <locationId> <MM/DD/YYYY> <time> [court]
# Example: ./schedule.sh tennisconfig reserve "11" "05/20/2026" "8:00am"

if [ "$#" -lt 5 ]; then
    echo "Usage: $0 <secret-id> <command> <locationId> <MM/DD/YYYY> <time> [court]"
    exit 1
fi

SECRET_ID=$1
COMMAND=$2
LOCATION_ID=$3
DATE_INPUT=$4
TIME_INPUT=$5

SAFE_DATE=$(echo "$DATE_INPUT" | tr -cd '[:alnum:]')
SAFE_TIME=$(echo "$TIME_INPUT" | tr -cd '[:alnum:]')
RULE_NAME="tennis-${COMMAND}-${LOCATION_ID}-${SAFE_DATE}-${SAFE_TIME}"

shift 2

echo "Auto-generated rule name: $RULE_NAME"
echo "Resolving secret ARN for $SECRET_ID..."
SECRET_ARN=$(aws secretsmanager describe-secret --secret-id "$SECRET_ID" --query 'ARN' --output text 2>/dev/null) || true
if [ -z "$SECRET_ARN" ] || [ "$SECRET_ARN" == "None" ]; then
    # Fallback to verbatim if the user already passed an ARN
    if [[ "$SECRET_ID" == arn:aws:secretsmanager:* ]]; then
        SECRET_ARN=$SECRET_ID
    else
        echo "Error: Could not find ARN for secret $SECRET_ID"
        exit 1
    fi
fi

echo "Calculating UTC drop time for reservation on $DATE_INPUT..."
CRON_EXPR=$(npx ts-node src/get-cron.ts "$DATE_INPUT") || { echo "Failed to calculate cron expression"; exit 1; }
echo "Calculated EventBridge cron: $CRON_EXPR"

LAMBDA_ARN=$(aws cloudformation describe-stacks \
  --stack-name nyc-tennis-reservation-bot \
  --query "Stacks[0].Outputs[?OutputKey=='TennisBotFunction'].OutputValue" \
  --output text)

if [ -z "$LAMBDA_ARN" ] || [ "$LAMBDA_ARN" == "None" ]; then
    echo "Error: Could not find TennisBotFunction ARN. Is the SAM stack deployed?"
    exit 1
fi

# 1. Create or update the rule
aws events put-rule \
    --name "$RULE_NAME" \
    --schedule-expression "$CRON_EXPR" \
    --state ENABLED

# 2. Grant permissions to EventBridge to invoke this specific Lambda rule if not already granted
# (Usually you do this once per Lambda or let a broader policy handle it, but here's a safe idempotent-ish command)
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
aws lambda add-permission \
    --function-name "$LAMBDA_ARN" \
    --statement-id "$RULE_NAME-Invoke" \
    --action "lambda:InvokeFunction" \
    --principal "events.amazonaws.com" \
    --source-arn "arn:aws:events:${AWS_DEFAULT_REGION}:${ACCOUNT_ID}:rule/$RULE_NAME" \
    2>/dev/null || true

# 3. Create JSON payload for the target
ARGS_JSON=$(printf '%s\n' "$@" | jq -R . | jq -s .)
PAYLOAD=$(jq -n --arg cmd "$COMMAND" --argjson args "$ARGS_JSON" --arg secret "$SECRET_ARN" '{command: $cmd, args: $args, configSecretId: $secret}')

# 4. Attach the target
TARGETS=$(jq -n --arg arn "$LAMBDA_ARN" --arg input "$PAYLOAD" '[{Id: "1", Arn: $arn, Input: $input}]')
aws events put-targets \
    --rule "$RULE_NAME" \
    --targets "$TARGETS"

echo "Scheduled $RULE_NAME successfully to invoke $LAMBDA_ARN"
echo "Payload: $PAYLOAD"
