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
  address2: ""
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
bun src/index.ts reserve <locationId> <MM/DD/YYYY> <h:mmam|pm> [courtNumber] --config config.yaml

# Rebook an existing reservation (no payment required)
bun src/index.ts rebook <confirmationId> <MM/DD/YYYY> <h:mmam|pm> [courtNumber] --config config.yaml

# Schedule a local job (macOS launchd) to run at drop time
bun src/index.ts schedule reserve <locationId> <MM/DD/YYYY> <h:mmam|pm> [courtNumber] --config config.yaml
bun src/index.ts schedule rebook <confirmationId> <MM/DD/YYYY> <h:mmam|pm> [courtNumber] --config config.yaml
```

**Flags** (apply to `reserve`, `rebook`, and their `schedule` variants):

| Flag | Description |
|---|---|
| `--config <path>` / `-c <path>` | Path to config YAML/JSON (defaults to `config.yaml` in the cwd) |
| `--players <n>` | Number of players on the reservation (`reserve` only, default `2`) |
| `--permits <n>` | Number of existing permits/tickets held (`reserve` only, default `2`) |
| `--record` | Record a Playwright video of the run to `debug/` for diagnostics |
| `--dry-run` | Walk the flow up through payment entry, then cancel the hold instead of submitting |
| `--wait-until-drop` | Block until the reservation drop time before reloading and booking (used internally by scheduled/Lambda runs) |

**Court selection:** if `courtNumber` is omitted, the bot peeks at the courts typically open for that time slot the day before, then races two browser contexts against each other at drop time to grab whichever of those courts opens first — improving odds when any court will do.

**Local scheduling notes:**
- Drop time is exactly 7 days before the target date at 12:00am ET.
- The scheduler attempts to wake the machine at 11:55pm ET via `pmset schedule wakeorpoweron`.
- The launchd job self-cleans after it runs.
- `reserve` and `rebook` include retry logic for transient failures.

## AWS Deployment

The bot can run as a Lambda function triggered by EventBridge rules, so your machine doesn't need to be awake at drop time.

### Architecture

- **Lambda** — runs the bot in a Docker container (Playwright included); always records video and self-deletes its EventBridge rule after running
- **EventBridge** — triggers the Lambda at the calculated drop time
- **S3** — stores task state/results and Playwright recordings for diagnostics
- **Secrets Manager** — stores `config.yaml` (and, optionally, per-profile configs) so credentials stay out of the codebase

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

Copy `.env.example` to `.env` and fill in values (used by the dashboard):

| Variable | Description |
|---|---|
| `AWS_ACCESS_KEY_ID` | AWS credentials |
| `AWS_SECRET_ACCESS_KEY` | AWS credentials |
| `AWS_DEFAULT_REGION` | AWS region (default: `us-east-1`) |
| `TENNIS_LAMBDA_ARN` | ARN of the deployed Lambda function |
| `TENNIS_SECRET_ID` | Secrets Manager secret name/ARN for `config.yaml` |
| `TENNIS_BUCKET_NAME` | S3 bucket name (from SAM output) |
| `TENNIS_PROFILES_SECRET_ID` | (Optional) Secrets Manager secret name for storing multiple applicant/payment profiles, so the dashboard can schedule jobs for more than one person |

### Dashboard

A local web UI for scheduling and monitoring jobs:

```bash
bun src/dashboard.ts
# Opens at http://localhost:3001
```

The dashboard lets you:
- Schedule `reserve` and `rebook` jobs locally or against the Lambda/EventBridge
- View and cancel scheduled local (launchd) and AWS (EventBridge) jobs
- Browse past run results and recordings pulled from S3
- Edit `config.yaml` / Secrets Manager config directly, including managing multiple applicant/payment profiles (when `TENNIS_PROFILES_SECRET_ID` is set)

### Example output

```
Commonpoint Tennis at Alley Pond Park (id: 7)
Central Park (id: 11)
```
