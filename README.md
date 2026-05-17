# Tennis Reservation Bot

Simple CLI to scrape and reserve NYC Parks tennis courts using Playwright.

Requirements
- Bun (recommended) or Node + npm (with `ts-node`)
- Playwright installed (project dependency)

Install
- With npm:
  ```bash
  npm install
  ```
- With Bun:
  ```bash
  bun install
  ```

Usage (Bun)
- Run the Bun script (uses `src/index.ts`):
  ```bash
  bun run bot locations
  bun src/index.ts locations
  bun src/index.ts reserve <locationId> <MM/DD/YYYY> <hh:mmam|pm> [courtNumber] --config config.yaml
  bun src/index.ts rebook <reservationConfirmationId> <MM/DD/YYYY> <hh:mmam|pm> [courtNumber] --config config.yaml
  bun src/index.ts schedule reserve <locationId> <MM/DD/YYYY> <hh:mmam|pm> [courtNumber] --config config.yaml
  bun src/index.ts schedule rebook <reservationConfirmationId> <MM/DD/YYYY> <hh:mmam|pm> [courtNumber] --config config.yaml
  ```

Usage (ts-node)
- Run the bot via `ts-node` (uses `src/index.ts`):
  ```bash
  npm run bot:ts-node -- locations
  npm run bot:ts-node -- reserve <locationId> <MM/DD/YYYY> <hh:mmam|pm> [courtNumber] --config config.yaml
  npm run bot:ts-node -- rebook <reservationConfirmationId> <MM/DD/YYYY> <hh:mmam|pm> [courtNumber] --config config.yaml
  npm run bot:ts-node -- schedule reserve <locationId> <MM/DD/YYYY> <hh:mmam|pm> [courtNumber] --config config.yaml
  npm run bot:ts-node -- schedule rebook <reservationConfirmationId> <MM/DD/YYYY> <hh:mmam|pm> [courtNumber] --config config.yaml
  ```

Commands
- `locations` — fetches available reservation locations and prints lines like `Central Park (id: 11)`.
- `reserve <locationId> <date> <time> [court] [config]` — run the full reserve flow; reads payment/applicant from `config.yaml` or `config.yml` by default.
- `rebook <reservationConfirmationId> <date> <time> [court] [config]` — rebook flow (no payment required).
- `schedule <reserve|rebook> <child args> [court] [config]` — creates a one-shot launchd job that starts at 11:58pm ET on the night reservation inventory should drop, waits until 12:00am ET, reloads the page, and executes the matching flow.
- `schedule-reserve ...` and `schedule-rebook ...` still work as compatibility aliases.

Scheduling notes
- Reservation drop time is calculated as exactly seven full calendar days before your target reservation date at 12:00am ET.
- The scheduler also attempts to create a wake event for 11:55pm ET using `pmset schedule wakeorpoweron`.
- The generated launchd job self-cleans: it unloads itself and removes its own plist/script after the run completes.
- `reserve` and `rebook` now include retry logic for transient failures (timeouts, navigation hiccups, connection resets, etc.).

Example output
- `Commonpoint Tennis at Alley Pond Park (id: 7)`

Config
- Default config filename: `config.yaml` (will fall back to `config.yml` if not provided).
- Example config available as `config.example.yaml`.
