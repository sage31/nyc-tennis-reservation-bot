import { chromium, Page } from 'playwright';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
    buildApplicant,
    buildPayment, calculateDropTimeUtc, createLogger, currentEtTimestamp, extractConfirmationNumber, formatDateForEt, Logger, parseCourtNumber, parseDateInput,
    parseTimeInput, requirePaymentDetails, resolveBunBinary, resolveConfig,
    runCommandOrThrow,
    shellQuote,
    sleep,
    startCalendarIntervalXml,
    toPmsetTimestamp,
    waitUntilDropAndReload
} from './utils';

(['log', 'info', 'warn', 'error'] as const).forEach(level => {
    const orig = console[level].bind(console);
    console[level] = (...args: any[]) => orig(`[${currentEtTimestamp()}]`, ...args);
});

const BASE_URL = 'https://www.nycgovparks.org';
const CHROMIUM_OPTIONS = { headless: true, args: ['--window-size=1280,800', '--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--no-zygote'] };
const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36';
const CONTEXT_OPTIONS = { viewport: { width: 1280, height: 800 }, userAgent: USER_AGENT };
const WAKE_LEAD_MINUTES = 5;
const PREFETCH_LEAD_MINUTES = 2;
const DEFAULT_RETRY_ATTEMPTS = 3;
const RACE_CONTEXT_COUNT = 2;
const NOT_BOOKABLE_TEXT = 'not bookable';

function usage() {
    console.error('Usage:');
    console.error('  ts-node src/index.ts reserve <locationId> <MM/DD/YYYY> <h:mmam|pm> [courtNumber] [config]');
    console.error('  ts-node src/index.ts rebook <reservationConfirmationId> <MM/DD/YYYY> <h:mmam|pm> [courtNumber] [config]');
    console.error('  ts-node src/index.ts schedule <reserve|rebook> <child args> [courtNumber] [config]');
    console.error('  ts-node src/index.ts locations');
}


export async function withRetries<T>(name: string, operation: (attempt: number) => Promise<T>, maxAttempts = DEFAULT_RETRY_ATTEMPTS) {
    let lastError: any;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        try {
            return await operation(attempt);
        } catch (error: any) {
            console.error(error);
            lastError = error;
            if (attempt >= maxAttempts) {
                break;
            };
            console.error(`${name} failed on attempt ${attempt}/${maxAttempts}: ${error?.message || error}. Retrying in ${200}ms...`);
            await sleep(200);
        }
    }
    if (lastError) {
        throw new Error(`${name} failed after ${maxAttempts} attempts. Last error: ${lastError?.message || lastError}`);
    }
}

async function scheduleTask(command: 'reserve' | 'rebook', args: string[], configPath?: string, record?: boolean) {
    const [primaryId, dateInput, timeInput, courtNumber] = args;
    const dropAt = calculateDropTimeUtc(dateInput);
    const wakeAt = new Date(dropAt.getTime() - (WAKE_LEAD_MINUTES * 60 * 1000));
    const taskAt = new Date(dropAt.getTime() - (PREFETCH_LEAD_MINUTES * 60 * 1000));
    const now = new Date();
    if (taskAt.getTime() <= now.getTime()) {
        throw new Error(`The computed start time (${taskAt.toString()}) is in the past. Choose a future reservation target.`);
    }

    const launchAgentsDir = path.join(os.homedir(), 'Library', 'LaunchAgents');
    fs.mkdirSync(launchAgentsDir, { recursive: true });

    const safeDate = parseDateInput(dateInput).iso;
    const safeTime = String(timeInput).toLowerCase().replace(/[^a-z0-9]+/g, '-');
    const label = `com.nyc-tennis-reservation-bot.${command}.${String(primaryId).replace(/[^a-zA-Z0-9]/g, '')}.${safeDate}.${safeTime}.${Date.now()}`;
    const plistPath = path.join(launchAgentsDir, `${label}.plist`);
    const scriptPath = path.join(launchAgentsDir, `${label}.sh`);

    const bunPath = resolveBunBinary();
    const commandArgs = ['src/index.ts', command, ...args];
    if (configPath) commandArgs.push('--config', path.resolve(configPath));
    if (record) commandArgs.push('--record');
    commandArgs.push('--wait-until-drop');
    const quotedCommand = [shellQuote(bunPath), ...commandArgs.map((arg) => shellQuote(arg))].join(' ');

    const uid = typeof process.getuid === 'function' ? process.getuid() : 501;
    const scriptLines = [
        '#!/bin/zsh',
        'set -uo pipefail',
        `cd ${shellQuote(process.cwd())}`,
        `echo "[$(date)] Starting scheduled ${command} run for ${label}"`,
        `cleanup() { launchctl bootout gui/${uid}/${label} >/dev/null 2>&1 || true; rm -f ${shellQuote(plistPath)}; rm -f ${shellQuote(scriptPath)}; }`,
        'trap cleanup EXIT',
        `${quotedCommand}`,
        'status=$?',
        'exit $status'
    ];
    fs.writeFileSync(scriptPath, `${scriptLines.join('\n')}\n`, { encoding: 'utf8' });
    fs.chmodSync(scriptPath, 0o755);

    const plist = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
        '<plist version="1.0">',
        '<dict>',
        '  <key>Label</key>',
        `  <string>${label}</string>`,
        '  <key>ProgramArguments</key>',
        '  <array>',
        `    <string>${scriptPath}</string>`,
        '  </array>',
        '  <key>StartCalendarInterval</key>',
        startCalendarIntervalXml(taskAt),
        '  <key>RunAtLoad</key>',
        '  <false/>',
        '  <key>StandardOutPath</key>',
        `  <string>${path.join(launchAgentsDir, `${label}.out.log`)}</string>`,
        '  <key>StandardErrorPath</key>',
        `  <string>${path.join(launchAgentsDir, `${label}.err.log`)}</string>`,
        '</dict>',
        '</plist>'
    ].join('\n');

    fs.writeFileSync(plistPath, `${plist}\n`, { encoding: 'utf8' });

    const wakeResult = spawnSync('/usr/bin/pmset', ['schedule', 'wakeorpoweron', toPmsetTimestamp(wakeAt)], { encoding: 'utf8' });
    const wakeScheduled = wakeResult.status === 0;

    spawnSync('launchctl', ['bootout', `gui/${uid}/${label}`], { encoding: 'utf8' });
    runCommandOrThrow('launchctl', ['bootstrap', `gui/${uid}`, plistPath], 'Failed to load launchd job.');
    runCommandOrThrow('launchctl', ['enable', `gui/${uid}/${label}`], 'Failed to enable launchd job.');

    const scheduleSummary = {
        command: `schedule ${command}`,
        label,
        locationId: String(primaryId),
        date: String(dateInput),
        time: String(timeInput),
        courtNumber: courtNumber || null,
        record: !!record,
        config: configPath ? path.resolve(configPath) : null,
        startAtLocal: taskAt.toString(),
        startAtEt: `${formatDateForEt(taskAt)} ET`,
        dropAtEt: `${formatDateForEt(dropAt)} ET`,
        wakeAtLocal: wakeAt.toString(),
        wakeAtEt: `${formatDateForEt(wakeAt)} ET`,
        wakeScheduled,
        wakeScheduleError: wakeScheduled ? null : (wakeResult.stderr || wakeResult.stdout || 'pmset wake schedule failed (likely permissions).').trim(),
        plistPath,
        scriptPath
    };
    console.log(JSON.stringify(scheduleSummary, null, 2));
    if (!wakeScheduled) {
        console.error('Wake scheduling did not succeed. You may need to run this manually with sudo:');
        console.error(`  sudo pmset schedule wakeorpoweron "${toPmsetTimestamp(wakeAt)}"`);
    }
    return scheduleSummary;
}

export async function scheduleReserve(locationId: string, dateInput: string, timeInput: string, courtNumber?: string, configPath?: string, record?: boolean, numPlayers?: string, permitsOrTickets?: string) {
    const extraFlags = [
        ...(numPlayers && numPlayers !== '2' ? ['--players', numPlayers] : []),
        ...(permitsOrTickets && permitsOrTickets !== '2' ? ['--permits', permitsOrTickets] : []),
    ];
    return scheduleTask('reserve', [locationId, dateInput, timeInput, ...(courtNumber ? [courtNumber] : []), ...extraFlags], configPath, record);
}

export async function scheduleRebook(reservationConfirmationId: string, dateInput: string, timeInput: string, courtNumber?: string, configPath?: string, record?: boolean) {
    return scheduleTask('rebook', [reservationConfirmationId, dateInput, timeInput, ...(courtNumber ? [courtNumber] : [])], configPath, record);
}

type CourtOption = { courtNumber: string | null; href: string };

// Finds every bookable court for the given date/time tab in a single page.evaluate() round trip
// (previously this walked rows/columns with dozens of sequential locator calls, which widened the
// booking race window). Also returns *all* available courts, not just the first, so callers can
// race for several courts at once when the caller didn't pin a specific court number.
async function locateAvailableCourts(page: any, { dateInput, timeInput }: { dateInput: string; timeInput: string }): Promise<CourtOption[]> {
    const date = parseDateInput(dateInput);
    const time = parseTimeInput(timeInput);

    const dateLink = page.locator(`a[href="#${date.iso}"]`).first();
    if (!(await dateLink.count())) {
        const availableDates = await page
            .locator('a[href^="#20"]')
            .evaluateAll((links: any) => links.map((l: any) => l.textContent.trim()).filter(Boolean));
        throw new Error(`Could not find the date tab for ${date.tabLabel}. Available tabs: ${availableDates.join(', ')}`);
    }

    await dateLink.click();
    await page.waitForFunction(
        (iso: string) => document.querySelector(`a[href="#${iso}"]`)?.parentElement?.classList.contains('active'),
        date.iso,
        { timeout: 5000 }
    ).catch(() => { console.log(`Warning: date tab ${date.iso}'s nav item did not become active after click.`); });

    const lookup = await page.evaluate(({ paneId, timeLabel }: { paneId: string; timeLabel: string }) => {
        const normalize = (s: string) => s.replace(/\s+/g, ' ').trim();
        const pane = document.getElementById(paneId) || document.body;
        const rows = Array.from(pane.querySelectorAll('tr'));
        for (const row of rows) {
            const text = normalize((row as HTMLElement).innerText || row.textContent || '');
            if (!/\d{1,2}:\d{2}\s+(a\.m\.|p\.m\.)/i.test(text)) continue;
            if (!text.startsWith(timeLabel)) continue;
            const table = row.closest('table');
            const headerCells = Array.from(table?.querySelectorAll('thead th, thead td') || []);
            const cells = Array.from(row.children);
            const courts: CourtOption[] = [];
            cells.forEach((cell, idx) => {
                const link = cell.querySelector('a');
                if (!link || !/reserve this time/i.test(link.textContent || '')) return;
                const headerText = normalize((headerCells[idx] as HTMLElement)?.textContent || '');
                const match = headerText.match(/Court\s+(\d+)/i);
                const href = link.getAttribute('href') || '';
                if (href) courts.push({ courtNumber: match ? match[1] : null, href });
            });
            return { found: true, courts };
        }
        return { found: false, courts: [] as CourtOption[] };
    }, { paneId: date.iso, timeLabel: time.label.replace(/\s+/g, ' ') });

    if (!lookup.found) {
        const availableTimes = await page.getByRole('row').evaluateAll((rows: any) =>
            rows
                .map((r: any) => r.textContent.trim())
                .filter((t: any) => /\d{1,2}:\d{2}\s+(a\.m\.|p\.m\.)/i.test(t))
                .map((t: any) => t.replace(/\s+/g, ' '))
                .slice(0, 8)
        );
        throw new Error(`Could not find a slot for ${time.label}. Available times: ${availableTimes.join(', ')}`);
    }

    return lookup.courts;
}

async function resolveReservationTargets(page: any, { dateInput, timeInput, courtNumber }: { dateInput: string; timeInput: string; courtNumber?: string }): Promise<CourtOption[]> {
    const time = parseTimeInput(timeInput);
    const courts = await locateAvailableCourts(page, { dateInput, timeInput });
    if (!courtNumber) {
        if (!courts.length) throw new Error(`No court is available at ${time.label}.`);
        return courts;
    }
    const court = parseCourtNumber(courtNumber);
    const match = courts.find((c) => c.courtNumber === court);
    if (!match) {
        const available = courts.map((c) => c.courtNumber).filter(Boolean).join(', ') || 'none';
        throw new Error(`Could not find Court ${court} at ${time.label}. Available courts: ${available}`);
    }
    return [match];
}

// Navigates to a "Reserve this time" link and classifies the result: success (applicant form
// loaded), a transient server error (retried via reloadUntilNoAlertError), or a genuine race loss
// (someone else grabbed the slot first) which is not retryable for this href.
async function goToReserveUrlAndCheck(page: any, href: string, logger: Logger = console) {
    const reserveUrl = href.startsWith('http') ? href : `${BASE_URL}${href}`;

    const gotoStart = Date.now();
    await page.goto(reserveUrl, { waitUntil: 'commit' });
    logger.log(`Reserve page loaded in ${Date.now() - gotoStart}ms`);

    await page.waitForSelector('#num_players_2, p.alert.alert-error', { timeout: 10000 }).catch(() => { });

    const notBookable = await page.locator('p.alert.alert-error').filter({ hasText: NOT_BOOKABLE_TEXT }).count();
    if (notBookable) throw new Error(`Lost the race: ${reserveUrl} is no longer bookable.`);
    await reloadUntilNoAlertError(page, undefined, undefined, logger);
    if (!(await page.locator('#num_players_2').count())) throw new Error(`Reserve link did not reach the applicant form: ${reserveUrl}`);
}

// Shifts a "MM/DD/YYYY" input by the given number of days, used to find a nearby already-open
// date to peek at before drop time.
function shiftDateInput(dateInput: string, days: number): string {
    const { iso } = parseDateInput(dateInput);
    const [year, month, day] = iso.split('-').map((v) => Number.parseInt(v, 10));
    const shifted = new Date(Date.UTC(year, month - 1, day));
    shifted.setUTCDate(shifted.getUTCDate() + days);
    const mm = String(shifted.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(shifted.getUTCDate()).padStart(2, '0');
    return `${mm}/${dd}/${shifted.getUTCFullYear()}`;
}

// Resolves a court and places a hold on it. When no specific court is requested, a second
// browser context is opened immediately (alongside the primary) so both are already navigated
// and waiting at drop time, rather than the second one only starting once the first has already
// found its target -- that head start is what actually shrinks the race window. Each context
// resolves availability from its own session (hrefs can be session-scoped).
//
// Which courts to race for is decided *before* drop time: the court layout for a given time slot
// is effectively static day to day, so we peek at the day before the target date (always already
// visible in the booking calendar, right up until drop) to learn the usual courts. That prediction
// costs nothing inside the critical window. If a predicted court turns out to be wrong on the
// actual day (or the peek failed entirely), each contestant falls back to discovering live courts
// after the drop-time reload, so correctness never depends on the prediction being right.
async function acquireCourtHold(browser: any, primary: { context: any; page: any }, availabilityUrl: string, dateInput: string, timeInput: string, courtNumber: string | undefined, waitUntilDrop: boolean, record: boolean) {
    if (courtNumber) {
        await primary.page.goto(availabilityUrl);
        await waitUntilDropAndReload(primary.page, dateInput, waitUntilDrop);
        const [target] = await resolveReservationTargets(primary.page, { dateInput, timeInput, courtNumber });
        await goToReserveUrlAndCheck(primary.page, target.href);
        return { browser, context: primary.context, page: primary.page, courtNumber: target.courtNumber };
    }

    await primary.page.goto(availabilityUrl);
    let peekedCourts: CourtOption[] = [];
    try {
        peekedCourts = await locateAvailableCourts(primary.page, { dateInput: shiftDateInput(dateInput, -1), timeInput });
    } catch { }
    const desiredCourts = peekedCourts.slice(0, RACE_CONTEXT_COUNT);
    console.log(desiredCourts.length
        ? `No court specified; pre-drop check found usual court(s) ${desiredCourts.map((t) => t.courtNumber).join(', ')}. Racing for those.`
        : 'No court specified; could not pre-determine usual courts, will discover live at drop.');

    // The secondary contestant gets its own browser *process*, not just an isolated context in
    // the shared one -- two contexts in a single Chromium process were found to contend for the
    // same process's resources (navigations effectively ran one after the other, not in
    // parallel), so a separate process is needed for the two attempts to actually overlap.
    const secondaryBrowser = await chromium.launch(CHROMIUM_OPTIONS);
    const secondary = await createContext(secondaryBrowser, record);
    const contestants = [
        { browser, context: primary.context, page: primary.page },
        { browser: secondaryBrowser, context: secondary.context, page: secondary.page },
    ];

    const jobs = contestants.map((c, idx) => (async () => {
        const logger = createLogger(`[job-${idx}]`);
        if (idx !== 0) await c.page.goto(availabilityUrl);
        await waitUntilDropAndReload(c.page, dateInput, waitUntilDrop, logger);

        let target: CourtOption | undefined;
        const desiredCourtNumber = desiredCourts[idx]?.courtNumber;
        if (desiredCourtNumber) {
            logger.log(`Targeting Court ${desiredCourtNumber} (pre-drop prediction).`);
            try {
                [target] = await resolveReservationTargets(c.page, { dateInput, timeInput, courtNumber: desiredCourtNumber });
            } catch { }
        }
        if (!target) {
            logger.log('Falling back to live court discovery.');
            const liveCourts = await resolveReservationTargets(c.page, { dateInput, timeInput });
            target = liveCourts[idx];
        }
        if (!target) throw Object.assign(new Error('No additional court available for this attempt.'), { browser: c.browser, context: c.context, page: c.page });

        try {
            await goToReserveUrlAndCheck(c.page, target.href, logger);
            logger.log(`Secured Court ${target.courtNumber}.`);
            return { browser: c.browser, context: c.context, page: c.page, courtNumber: target.courtNumber };
        } catch (error: any) {
            logger.log(`Lost: ${error.message}`);
            error.browser = c.browser;
            error.context = c.context;
            error.page = c.page;
            throw error;
        }
    })());

    const results = await Promise.allSettled(jobs);
    const winner = results.find((r): r is PromiseFulfilledResult<{ browser: any; context: any; page: any; courtNumber: string | null }> => r.status === 'fulfilled');

    await Promise.all(results.map(async (r, idx) => {
        const value: any = r.status === 'fulfilled' ? r.value : (r as PromiseRejectedResult).reason;
        if (!value?.context || (winner && value.context === winner.value.context)) return;
        try { await cancelReservationHold(value.page, createLogger(`[job-${idx}]`)); } catch { }
        // idx 0 is always the primary; its browser is owned/closed by the caller. Every other
        // contestant has its own browser process that must be torn down here or it leaks.
        if (idx !== 0) {
            try { await value.browser.close(); } catch { }
        }
    }));

    if (!winner) {
        const messages = results.map((r) => (r as PromiseRejectedResult).reason?.message).filter(Boolean).join('; ');
        throw new Error(`Lost the race for ${contestants.length} available court(s). ${messages}`);
    }
    console.log(`Won the race for Court ${winner.value.courtNumber}.`);
    return winner.value;
}

async function fillApplicantDetails(page: Page, applicant: any, numPlayers: string, permitsOrTickets: string) {
    // await page.getByRole('button', { name: /Confirm and Enter Player/i }).click();
    await page.locator(`#num_players_${numPlayers}`).check();
    await page.locator(`#single_play_exist_${permitsOrTickets}`).check();
    await page.getByRole('textbox', { name: '* Name' }).click();
    await page.getByRole('textbox', { name: '* Name' }).fill(applicant.name);
    await page.getByRole('textbox', { name: '* Name' }).press('Tab');
    await page.getByRole('textbox', { name: '* Email' }).fill(applicant.email);
    await page.getByRole('textbox', { name: '* Email' }).press('Tab');
    await page.getByRole('textbox', { name: '* Address' }).fill(applicant.address);
    await page.getByRole('textbox', { name: '* Address' }).press('Tab');
    await page.getByRole('textbox', { name: 'Apartment (optional)' }).fill(applicant.address2 || '');
    await page.getByRole('textbox', { name: 'Apartment (optional)' }).press('Tab');
    await page.getByRole('textbox', { name: '* City' }).fill(applicant.city);
    await page.getByRole('textbox', { name: '* City' }).press('Tab');
    await page.getByRole('textbox', { name: 'State/Region (optional)' }).fill(applicant.state);
    await page.getByRole('textbox', { name: 'State/Region (optional)' }).press('Tab');
    await page.getByRole('textbox', { name: '* Zip' }).fill(applicant.zip);
    await page.getByRole('textbox', { name: '* Zip' }).press('Tab');
    await page.getByRole('textbox', { name: '* Country' }).press('Tab');
    await page.getByRole('textbox', { name: '* Phone' }).fill(applicant.phone);
    await page.getByRole('button', { name: /Continue to Payment/i }).click();
    // Wait for location change to /payment/review/tennis-reservation
    await page.waitForURL(/\/payment\/review\/tennis-reservation/, { timeout: 10000 }).catch(() => {
        throw new Error('Did not navigate to payment review page after filling applicant details. Current URL: ' + page.url());
    });

    await page.getByRole('button', { name: /Continue to Payment/i }).click();
}

async function submitPayment(page: Page, payment: any, dryRun = false) {
    requirePaymentDetails(payment);
    console.log('Payment page URL:', page.url());
    // wait for iframe or top-level fields; interactions will wait as needed
    const iframeSrcs = await page.locator('iframe').evaluateAll((frames: any) => frames.map((f: any) => f.getAttribute('src') || ''));
    console.log('Detected iframe src values:', iframeSrcs);
    const payflowIframe = page.locator('iframe[src*="payflowlink.paypal.com"]').first();
    const hasIframe = (await payflowIframe.count()) > 0;
    const hasTopLevelFields = (await page.locator('#cc_number').count()) > 0;
    let paymentTarget: any;
    if (hasIframe) {
        console.log('Payment form mode: iframe');
        paymentTarget = page.frameLocator('iframe[src*="payflowlink.paypal.com"]');
    } else if (hasTopLevelFields || /payflowlink\.paypal\.com/i.test(page.url())) {
        console.log('Payment form mode: top-level page');
        paymentTarget = page;
    } else {
        throw new Error('Payment form was not found in either iframe or top-level page.');
    }
    const expYear2 = payment.expYear.length === 4 ? payment.expYear.slice(2) : payment.expYear;
    await paymentTarget.locator('#cc_number').fill(payment.cardNumber);
    await paymentTarget.locator('#expdate_month').fill(payment.expMonth);
    await paymentTarget.locator('#expdate_year').fill(expYear2);
    await paymentTarget.locator('#cvv2_number').fill(payment.cvv);
    if (dryRun) {
        console.log('Dry run: reached the payment step and filled payment fields; stopping before clicking pay.');
        return { confirmationNumber: null as string | null, url: page.url() };
    }
    await paymentTarget.locator('#btn_pay_cc1').click();
    try {
        await page.waitForFunction(() => /Confirmation Number:/i.test(document.body.innerText), null, { timeout: 30000 });
    } catch { }
    const bodyText = await page.locator('body').innerText().catch(() => '');
    const confirmationNumber = extractConfirmationNumber(bodyText);
    if (!confirmationNumber) throw new Error(`Payment submitted, but no confirmation number was found. Page text: ${bodyText.slice(0, 500)}`);
    return { confirmationNumber, url: page.url() };
}

async function reloadUntilNoAlertError(page: any, maxRetries = 5, initialBackoffMs = 50, logger: Logger = console) {
    let backoff = initialBackoffMs;
    for (let attempt = 0; attempt < maxRetries; attempt++) {
        const hasError = await page.locator('p.alert.alert-error').filter({ hasText: 'Sorry, an error has occurred' }).count();
        if (!hasError) return;
        logger.warn(`Alert error detected on attempt ${attempt + 1}/${maxRetries}, reloading after ${backoff}ms...`);
        await sleep(backoff);
        backoff *= 2;
        await page.reload({ waitUntil: 'commit' });
        await page.waitForSelector('#num_players_2, p.alert.alert-error', { timeout: 10000 }).catch(() => { });
    }
    const stillHasError = await page.locator('p.alert.alert-error').filter({ hasText: 'Sorry, an error has occurred' }).count();
    if (stillHasError) throw new Error('Alert error persisted after all reload retries.');
}

async function cancelReservationHold(page: any, logger: Logger = console) {
    try {
        await page.goto(`${BASE_URL}/tennisreservation/cancel-reservation`, { waitUntil: 'domcontentloaded', timeout: 15000, referer: `${BASE_URL}/tennisreservation/` });
        const text = await page.locator('body').innerText().catch(() => '');
        logger.log('Cancel flow called for held reservation.');
        if (text) logger.log('Cancel page snippet:', text.slice(0, 180).replace(/\s+/g, ' '));
    } catch (e) {
        // swallow errors; caller already handling the main failure
    }
}

export async function fetchLocations(): Promise<{ id: string; name: string; borough: string }[]> {
    const browser = await chromium.launch(CHROMIUM_OPTIONS);
    const context = await browser.newContext(CONTEXT_OPTIONS);
    const page = await context.newPage();
    try {
        await page.goto(`${BASE_URL}/tennisreservation/`, { waitUntil: 'networkidle', timeout: 5000 }).catch(() => { });
        await page.waitForSelector('table.table.table-bordered', { timeout: 1000 }).catch(() => { });

        return await page.evaluate(() => {
            const out: { id: string; name: string; borough: string }[] = [];
            const table = document.querySelector('table.table.table-bordered');
            if (!table) return out;
            const rows = Array.from(table.querySelectorAll('tbody tr'));
            for (const row of rows) {
                if (row.classList.contains('tennis-res-oos')) continue;
                const strong = row.querySelector('strong');
                if (!strong) continue;
                const name = strong.textContent?.trim() || '';
                const borough = strong.nextSibling?.textContent?.trim().replace(/[^a-zA-Z\s]/g, '').trim() || '';
                const link = row.querySelector('a[href^="/tennisreservation/availability/"]') as HTMLAnchorElement | null;
                const href = link ? link.getAttribute('href') : null;
                if (!href) continue;
                const m = href.match(/availability\/(\d+)/i);
                if (!m) continue;
                out.push({ id: m[1], name, borough });
            }
            return out;
        });
    } finally {
        await context.close();
        await browser.close();
    }
}

async function saveRecording(page: Page, label: string, attempt: number) {
    const videoPath = await page.video()?.path();
    if (!videoPath) return;
    const safe = label.replace(/[^a-zA-Z0-9-]/g, '-');
    fs.renameSync(videoPath, path.join(path.dirname(videoPath), `${safe}-attempt-${attempt}-${Date.now()}.webm`));
}

async function createContext(browser: any, record: boolean) {
    const debugDir = path.join(process.cwd(), 'debug');
    if (record) fs.mkdirSync(debugDir, { recursive: true });
    const contextOptions: any = { ...CONTEXT_OPTIONS };
    if (record) contextOptions.recordVideo = { dir: debugDir };
    const context = await browser.newContext(contextOptions);
    const page = await context.newPage();
    return { context, page };
}

async function createBrowserContext(record: boolean) {
    const browser = await chromium.launch(CHROMIUM_OPTIONS);
    const { context, page } = await createContext(browser, record);
    return { browser, context, page };
}

export async function reserve(locationId: string, dateInput: string, timeInput: string, courtNumber?: string, configPath?: string, waitUntilDrop = false, record = false, numPlayers = '2', permitsOrTickets = '2', attempt = 1, dryRun = false) {
    const config = resolveConfig(configPath);
    const applicant = buildApplicant(config);
    const payment = buildPayment(config);
    const { browser, context, page } = await createBrowserContext(record);
    let activeContext = context;
    let activePage = page;
    let activeBrowser = browser;
    try {
        const availabilityUrl = `${BASE_URL}/tennisreservation/availability/${locationId}`;
        const held = await acquireCourtHold(browser, { context, page }, availabilityUrl, dateInput, timeInput, courtNumber, waitUntilDrop, record);
        activeContext = held.context;
        activePage = held.page;
        activeBrowser = held.browser;
        const resolvedCourtNumber = held.courtNumber;

        try {
            await fillApplicantDetails(activePage, applicant, numPlayers, permitsOrTickets);
            const paymentResult = await submitPayment(activePage, payment, dryRun);
            if (dryRun) {
                console.log('Dry run complete; cancelling hold without submitting payment.');
                try { await cancelReservationHold(activePage); } catch (e) { console.error(`Cancel flow failed: ${e.message}`); }
            }
            const result = { locationId: String(locationId), date: dateInput, time: timeInput, courtNumber: String(resolvedCourtNumber), confirmationNumber: paymentResult.confirmationNumber, dryRun, url: paymentResult.url };
            console.log(JSON.stringify(result, null, 2));
            return result;
        } catch (error) {
            console.error('Error during applicant/payment flow:');
            console.error(error);
            console.error('Attempting to cancel...');
            try { await cancelReservationHold(activePage); } catch (e) { console.error(`Cancel flow failed: ${e.message}`); }
            throw error;
        }
    } finally {
        if (activeContext !== context) {
            await activeContext.close();
            if (record) await saveRecording(activePage, `reserve-${locationId}-${dateInput}-${timeInput}`, attempt);
            await activeBrowser.close();
            await context.close();
        } else {
            await context.close();
            if (record) await saveRecording(page, `reserve-${locationId}-${dateInput}-${timeInput}`, attempt);
        }
        await browser.close();
    }
}

export async function rebook(reservationConfirmationId: string, dateInput: string, timeInput: string, courtNumber?: string, waitUntilDrop = false, record = false, attempt = 1, dryRun = false) {
    const { browser, context, page } = await createBrowserContext(record);
    let activeContext = context;
    let activePage = page;
    let activeBrowser = browser;
    try {
        const availabilityUrl = `${BASE_URL}/tennisreservation/rebook/${reservationConfirmationId}`;
        const held = await acquireCourtHold(browser, { context, page }, availabilityUrl, dateInput, timeInput, courtNumber, waitUntilDrop, record);
        activeContext = held.context;
        activePage = held.page;
        activeBrowser = held.browser;
        const resolvedCourtNumber = held.courtNumber;

        if (dryRun) {
            console.log('Dry run: reached the rebook confirmation step; stopping before clicking Make Reservation.');
            try { await cancelReservationHold(activePage); } catch (e) { console.error(`Cancel flow failed: ${e.message}`); }
            const result = { reservationConfirmationId, date: dateInput, time: timeInput, courtNumber: String(resolvedCourtNumber), confirmationNumber: null as string | null, dryRun: true, url: activePage.url() };
            console.log(JSON.stringify(result, null, 2));
            return result;
        }

        await activePage.getByRole('button', { name: /Make Reservation/i }).click();
        try { await activePage.waitForFunction(() => /Confirmation Number:/i.test(document.body.innerText), null, { timeout: 30000 }); } catch { }
        const bodyText = await activePage.locator('body').innerText().catch(() => '');
        const confirmationNumber = extractConfirmationNumber(bodyText);
        if (!confirmationNumber) throw new Error(`Rebook submitted, but no confirmation number was found. Page text: ${bodyText.slice(0, 500)}`);
        const result = { reservationConfirmationId, date: dateInput, time: timeInput, courtNumber: String(resolvedCourtNumber), confirmationNumber, url: activePage.url() };
        console.log(JSON.stringify(result, null, 2));
        return result;
    } finally {
        if (activeContext !== context) {
            await activeContext.close();
            if (record) await saveRecording(activePage, `rebook-${reservationConfirmationId}-${dateInput}-${timeInput}`, attempt);
            await activeBrowser.close();
            await context.close();
        } else {
            await context.close();
            if (record) await saveRecording(page, `rebook-${reservationConfirmationId}-${dateInput}-${timeInput}`, attempt);
        }
        await browser.close();
    }
}

type ParsedCommandArgs = {
    positional: string[];
    configPath?: string;
    waitUntilDrop?: boolean;
    record?: boolean;
    numPlayers?: string;
    permitsOrTickets?: string;
    dryRun?: boolean;
};

function parseFlag(positional: string[], flag: string): string | undefined {
    const i = positional.findIndex((a) => a === flag);
    if (i === -1) return undefined;
    const value = positional[i + 1];
    positional.splice(i, 2);
    return value;
}

function parseBoolFlag(positional: string[], flag: string): boolean {
    const i = positional.findIndex((a) => a === flag);
    if (i === -1) return false;
    positional.splice(i, 1);
    return true;
}

function parseConfigAndWaitFlags(args: string[]): ParsedCommandArgs {
    const positional = [...args];
    const configPath = parseFlag(positional, '--config') ?? parseFlag(positional, '-c');
    const waitUntilDrop = parseBoolFlag(positional, '--wait-until-drop');
    const record = parseBoolFlag(positional, '--record');
    const numPlayers = parseFlag(positional, '--players');
    const permitsOrTickets = parseFlag(positional, '--permits');
    const dryRun = parseBoolFlag(positional, '--dry-run');
    return { positional, configPath, waitUntilDrop, record, numPlayers, permitsOrTickets, dryRun };
}

function parseReserveLikeArgs(args: string[]) {
    const { positional, configPath, waitUntilDrop, record, numPlayers, permitsOrTickets, dryRun } = parseConfigAndWaitFlags(args);
    const [locationId, dateInput, timeInput, courtNumber] = positional;
    if (!locationId || !dateInput || !timeInput) throw new Error('Usage: reserve <locationId> <MM/DD/YYYY> <h:mmam|pm> [courtNumber] [config]');
    return { locationId, dateInput, timeInput, courtNumber, configPath, waitUntilDrop: !!waitUntilDrop, record: !!record, numPlayers, permitsOrTickets, dryRun: !!dryRun };
}

function parseRebookLikeArgs(args: string[]) {
    const { positional, configPath, waitUntilDrop, record, dryRun } = parseConfigAndWaitFlags(args);
    const [reservationConfirmationId, dateInput, timeInput, courtNumber] = positional;
    if (!reservationConfirmationId || !dateInput || !timeInput) throw new Error('Usage: rebook <reservationConfirmationId> <MM/DD/YYYY> <h:mmam|pm> [courtNumber] [config]');
    return { reservationConfirmationId, dateInput, timeInput, courtNumber, configPath, waitUntilDrop: !!waitUntilDrop, record: !!record, dryRun: !!dryRun };
}

function parseScheduleArgs(args: string[]) {
    const [subcommand, ...rest] = args;
    if (subcommand !== 'reserve' && subcommand !== 'rebook') {
        throw new Error('Usage: schedule <reserve|rebook> <child args> [courtNumber] [config]');
    }
    if (subcommand === 'reserve') {
        return { subcommand, ...parseReserveLikeArgs(rest) };
    }
    return { subcommand, ...parseRebookLikeArgs(rest) };
}

async function main() {
    const [command, ...rest] = process.argv.slice(2);
    if (!command) { usage(); process.exitCode = 1; return; }

    if (command === 'locations') { console.log(JSON.stringify(await fetchLocations(), null, 2)); return; }

    if (command === 'reserve') {
        const { locationId, dateInput, timeInput, courtNumber, configPath, waitUntilDrop, record, numPlayers, permitsOrTickets, dryRun } = parseReserveLikeArgs(rest);
        await withRetries('reserve', (attempt) => reserve(locationId, dateInput, timeInput, courtNumber, configPath, waitUntilDrop, record, numPlayers, permitsOrTickets, attempt, dryRun));
        return;
    }

    if (command === 'rebook') {
        const { reservationConfirmationId, dateInput, timeInput, courtNumber, waitUntilDrop, record, dryRun } = parseRebookLikeArgs(rest);
        await withRetries('rebook', (attempt) => rebook(reservationConfirmationId, dateInput, timeInput, courtNumber, waitUntilDrop, record, attempt, dryRun));
        return;
    }

    if (command === 'schedule') {
        const { subcommand } = parseScheduleArgs(rest);
        if (subcommand === 'reserve') {
            const { locationId, dateInput, timeInput, courtNumber, configPath, record, numPlayers, permitsOrTickets } = parseReserveLikeArgs(rest.slice(1));
            await scheduleReserve(locationId, dateInput, timeInput, courtNumber, configPath, record, numPlayers, permitsOrTickets);
            return;
        }
        if (subcommand === 'rebook') {
            const { reservationConfirmationId, dateInput, timeInput, courtNumber, configPath, record } = parseRebookLikeArgs(rest.slice(1));
            await scheduleRebook(reservationConfirmationId, dateInput, timeInput, courtNumber, configPath, record);
            return;
        }
        usage();
        process.exitCode = 1;
        return;
    }

    usage();
    process.exitCode = 1;
}

if (require.main === module) {
    main().catch((e) => { console.error(e.message); process.exitCode = 1; });
}
