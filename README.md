# Tennis Reservation Bot

CLI and AWS Lambda bot to scrape and reserve NYC Parks tennis courts using Playwright. Supports local scheduling via macOS launchd or cloud scheduling via AWS EventBridge + Lambda.

## Requirements

- [Bun](https://bun.sh) (recommended) or Node + npm (with `ts-node`)
- For AWS deployment: [AWS SAM CLI](https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/install-sam-cli.html), Docker, and AWS credentials configured

## Install

```bash
bun install
# or
npm install
```

## Config

Copy `config.example.yaml` to `config.yaml` and fill in your applicant and payment details:

```yaml
applicant:
  name: "Your Name"
  email: "you@example.com"
  address: "123 Main St"
  city: "New York"
  state: "New York"
  zip: "10001"
  country: "United States"
  phone: "2125550100"

payment:
  cardNumber: ""
  expMonth: ""
  expYear: ""
  cvv: ""
```

## Local CLI Usage

```bash
# List available reservation locations
bun src/index.ts locations

# Reserve a court
bun src/index.ts reserve <locationId> <MM/DD/YYYY> <hh:mmam|pm> [courtNumber] --config config.yaml

# Rebook an existing reservation (no payment required)
bun src/index.ts rebook <confirmationId> <MM/DD/YYYY> <hh:mmam|pm> [courtNumber] --config config.yaml

# Schedule a local job (macOS launchd) to run at drop time
bun src/index.ts schedule reserve <locationId> <MM/DD/YYYY> <hh:mmam|pm> [courtNumber] --config config.yaml
bun src/index.ts schedule rebook <confirmationId> <MM/DD/YYYY> <hh:mmam|pm> [courtNumber] --config config.yaml
```

`schedule-reserve ...` and `schedule-rebook ...` work as aliases.

**Local scheduling notes:**
- Drop time is exactly 7 days before the target date at 12:00am ET.
- The scheduler attempts to wake the machine at 11:55pm ET via `pmset schedule wakeorpoweron`.
- The launchd job self-cleans after it runs.
- `reserve` and `rebook` include retry logic for transient failures.

## AWS Deployment

The bot can run as a Lambda function triggered by EventBridge rules, so your machine doesn't need to be awake at drop time.

### Architecture

- **Lambda** — runs the bot in a Docker container (Playwright included)
- **EventBridge** — triggers the Lambda at the calculated drop time
- **S3** — stores task state and Playwright recordings for diagnostics
- **Secrets Manager** — stores `config.yaml` so credentials stay out of the codebase

### Deploy

```bash
sam build
sam deploy --guided
```

On first deploy, `--guided` will prompt for stack name and region. Subsequent deploys use `samconfig.toml`.

### Sync config to Secrets Manager

```bash
./sync-config.sh <secret-name> config.yaml
# Example:
./sync-config.sh nyc-tennis-config config.yaml
```

Creates the secret if it doesn't exist, updates it if it does.

### Environment variables

Copy `.env.example` to `.env` and fill in values (used by the dashboard and helper scripts):

| Variable | Description |
|---|---|
| `AWS_ACCESS_KEY_ID` | AWS credentials |
| `AWS_SECRET_ACCESS_KEY` | AWS credentials |
| `AWS_DEFAULT_REGION` | AWS region (default: `us-east-1`) |
| `TENNIS_LAMBDA_ARN` | ARN of the deployed Lambda function |
| `TENNIS_SECRET_ID` | Secrets Manager secret name/ARN for `config.yaml` |
| `TENNIS_BUCKET_NAME` | S3 bucket name (from SAM output) |

### Dashboard

A local web UI for scheduling and monitoring jobs:

```bash
bun src/dashboard.ts
# Opens at http://localhost:3001
```

The dashboard lets you schedule `reserve` and `rebook` jobs against the Lambda, view scheduled EventBridge rules, and check task status from S3.

### Example output

```
Commonpoint Tennis at Alley Pond Park (id: 7)
Central Park (id: 11)
```
