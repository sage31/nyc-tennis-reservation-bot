#!/bin/bash
set -e

# Default to US East (N. Virginia)
export AWS_DEFAULT_REGION="us-east-1"

# Usage: ./sync-config.sh <secret-name-or-arn> <path-to-config-file>
# Example: ./sync-config.sh tennis-config config.yaml

if [ "$#" -lt 2 ]; then
    echo "Usage: $0 <secret-name-or-arn> <path-to-config-file>"
    echo "Example: $0 tennis-config config.yaml"
    exit 1
fi

SECRET_ID=$1
CONFIG_FILE=$2

if [ ! -f "$CONFIG_FILE" ]; then
    echo "Error: File $CONFIG_FILE not found."
    exit 1
fi

# Determine if the secret already exists
if aws secretsmanager describe-secret --secret-id "$SECRET_ID" >/dev/null 2>&1; then
    echo "Updating existing secret: $SECRET_ID"
    aws secretsmanager put-secret-value \
        --secret-id "$SECRET_ID" \
        --secret-string "file://$CONFIG_FILE" \
        --output text --query 'ARN'
else
    echo "Creating new secret: $SECRET_ID"
    aws secretsmanager create-secret \
        --name "$SECRET_ID" \
        --description "Config for NYC Tennis Bot" \
        --secret-string "file://$CONFIG_FILE" \
        --output text --query 'ARN'
fi

echo "Successfully synced $CONFIG_FILE to AWS Secrets Manager."
