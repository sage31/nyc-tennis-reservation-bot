import { chromium, Page } from 'playwright';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
    buildApplicant,
    buildPayment, calculateDropTimeUtc, currentEtTimestamp, escapeRegExp, extractConfirmationNumber, formatDateForEt, parseCourtNumber, parseDateInput,
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

function usage() {
    console.error('Usage:');
    console.error('  ts-node src/index.ts reserve <locationId> <MM/DD/YYYY> <h:mmam|pm> [courtNumber] [config]');
    console.error('  ts-node src/index.ts rebook <reservationConfirmationId> <MM/DD/YYYY> <h:mmam|pm> [courtNumber] [config]');
    console.error('  ts-node src/index.ts schedule <reserve|rebook> <child args> [courtNumber] [config]');
    console.error('  ts-node src/index.ts locations');
}


export async function withRetries<T>(name: string, operation: () => Promise<T>, maxAttempts = DEFAULT_RETRY_ATTEMPTS) {
    let lastError: any;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        try {
            return await operation();
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

async function clickReservationSlot(page: any, { dateInput, timeInput, courtNumber }: any) {
    const date = parseDateInput(dateInput);
    const time = parseTimeInput(timeInput);
    const court = courtNumber ? parseCourtNumber(courtNumber) : null;

    const dateLink = page.locator(`a[href="#${date.iso}"]`).first();
    if (!(await dateLink.count())) {
        const availableDates = await page
            .locator('a[href^="#20"]')
            .evaluateAll((links: any) => links.map((l: any) => l.textContent.trim()).filter(Boolean));
        throw new Error(`Could not find the date tab for ${date.tabLabel}. Available tabs: ${availableDates.join(', ')}`);
    }

    await dateLink.click();
    await page.waitForTimeout(800);
    await page.waitForLoadState('domcontentloaded').catch(() => { });

    const allRowHandles = await page.getByRole('row').all();
    let timeRowIndex = -1;
    for (let i = 0; i < allRowHandles.length; i++) {
        const row = allRowHandles[i];
        const text = await row.innerText().catch(() => '');
        if (text && /\d{1,2}:\d{2}\s+(a\.m\.|p\.m\.)/i.test(text)) {
            const normalizedText = text.replace(/\s+/g, ' ').trim();
            const normalizedExpected = time.label.replace(/\s+/g, ' ');
            if (normalizedText.startsWith(normalizedExpected)) {
                timeRowIndex = i;
                break;
            }
        }
    }

    if (timeRowIndex === -1) {
        const availableTimes = await page.getByRole('row').evaluateAll((rows: any) =>
            rows
                .map((r: any) => r.textContent.trim())
                .filter((t: any) => /\d{1,2}:\d{2}\s+(a\.m\.|p\.m\.)/i.test(t))
                .map((t: any) => t.replace(/\s+/g, ' '))
                .slice(0, 8)
        );
        throw new Error(`Could not find a slot for ${time.label}. Available times: ${availableTimes.join(', ')}`);
    }

    const timeRow = page.getByRole('row').nth(timeRowIndex);
    const reserveLinks = timeRow.getByRole('link', { name: 'Reserve this time' });
    let reserveLink = reserveLinks.first();
    let resolvedCourtNumber = court;

    if (court) {
        const courtHeader = page.getByRole('columnheader', { name: new RegExp(`^Court\\s+${escapeRegExp(court)}$`, 'i') }).first();
        if (!(await courtHeader.count())) {
            const availableCourts = await page.getByRole('columnheader').evaluateAll((headers: any) => headers.map((h: any) => h.textContent.trim()).filter((t: any) => /^Court\s+\d+/i.test(t)));
            throw new Error(`Could not find Court ${court}. Available courts: ${availableCourts.join(', ')}`);
        }
        const courtIndex = await courtHeader.evaluate((header: any) => Array.from(header.parentElement.children).indexOf(header));
        reserveLink = timeRow.locator('td').nth(courtIndex).getByRole('link', { name: 'Reserve this time' });
    } else {
        const firstReserveLink = await reserveLink.evaluate((link: any) => {
            const cell = link.closest('td');
            const row = cell?.parentElement;
            const cells = Array.from(row?.children || []);
            return cells.indexOf(cell);
        });
        const courtHeaders = await page.getByRole('columnheader').evaluateAll((headers: any) =>
            headers.map((h: any) => ({ text: h.textContent.trim(), index: Array.from(h.parentElement.children).indexOf(h) })).filter((h: any) => /^Court\s+(\d+)/i.test(h.text))
        );
        const matchingHeader = courtHeaders.find((h: any) => h.index === firstReserveLink);
        if (matchingHeader) {
            const match = matchingHeader.text.match(/Court\s+(\d+)/i);
            resolvedCourtNumber = match ? match[1] : null;
        }
    }

    if (!(await reserveLink.count())) throw new Error(court ? `Court ${court} at ${time.label} is not available.` : `No court is available at ${time.label}.`);
    await reserveLink.click();
    return { courtNumber: resolvedCourtNumber };
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

async function submitPayment(page: Page, payment: any) {
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
    await paymentTarget.locator('#cc_number').fill(payment.cardNumber);
    await paymentTarget.locator('#expdate_month').fill(payment.expMonth);
    await paymentTarget.locator('#expdate_year').fill(payment.expYear);
    await paymentTarget.locator('#cvv2_number').fill(payment.cvv);
    await Promise.all([page.waitForLoadState('domcontentloaded').catch(() => { }), paymentTarget.locator('#btn_pay_cc1').click()]);
    try {
        await page.waitForFunction(() => /Confirmation Number:/i.test(document.body.innerText), null, { timeout: 30000 });
    } catch { }
    const bodyText = await page.locator('body').innerText().catch(() => '');
    const confirmationNumber = extractConfirmationNumber(bodyText);
    if (!confirmationNumber) throw new Error(`Payment submitted, but no confirmation number was found. Page text: ${bodyText.slice(0, 500)}`);
    return { confirmationNumber, url: page.url() };
}

async function cancelReservationHold(page: any) {
    try {
        await page.goto(`${BASE_URL}/tennisreservation/cancel-reservation`, { waitUntil: 'domcontentloaded', timeout: 15000, referer: `${BASE_URL}/tennisreservation/` });
        const text = await page.locator('body').innerText().catch(() => '');
        console.log('Cancel flow called for held reservation.');
        if (text) console.log('Cancel page snippet:', text.slice(0, 180).replace(/\s+/g, ' '));
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

async function saveRecording(page: Page, label: string) {
    const videoPath = await page.video()?.path();
    if (!videoPath) return;
    const safe = label.replace(/[^a-zA-Z0-9-]/g, '-');
    fs.renameSync(videoPath, path.join(path.dirname(videoPath), `${safe}.webm`));
}

async function createBrowserContext(record: boolean) {
    const browser = await chromium.launch(CHROMIUM_OPTIONS);
    const debugDir = path.join(process.cwd(), 'debug');
    if (record) fs.mkdirSync(debugDir, { recursive: true });
    const contextOptions: any = { ...CONTEXT_OPTIONS };
    if (record) contextOptions.recordVideo = { dir: debugDir };
    const context = await browser.newContext(contextOptions);
    const page = await context.newPage();
    return { browser, context, page };
}

export async function reserve(locationId: string, dateInput: string, timeInput: string, courtNumber?: string, configPath?: string, waitUntilDrop = false, record = false, numPlayers = '2', permitsOrTickets = '2') {
    const config = resolveConfig(configPath);
    const applicant = buildApplicant(config);
    const payment = buildPayment(config);
    const { browser, context, page } = await createBrowserContext(record);
    try {
        await page.goto(`${BASE_URL}/tennisreservation/availability/${locationId}`);
        await waitUntilDropAndReload(page, dateInput, waitUntilDrop);
        const slotResult = await clickReservationSlot(page, { dateInput, timeInput, courtNumber });
        const resolvedCourtNumber = slotResult.courtNumber;
        try {
            await fillApplicantDetails(page, applicant, numPlayers, permitsOrTickets);
            const paymentResult = await submitPayment(page, payment);
            const result = { locationId: String(locationId), date: dateInput, time: timeInput, courtNumber: String(resolvedCourtNumber), confirmationNumber: paymentResult.confirmationNumber, url: paymentResult.url };
            console.log(JSON.stringify(result, null, 2));
            return result;
        } catch (error) {
            console.error('Error during applicant/payment flow:');
            console.error(error);
            console.error('Attempting to cancel...');
            try { await cancelReservationHold(page); } catch (e) { console.error(`Cancel flow failed: ${e.message}`); }
            throw error;
        }
    } finally {
        await context.close();
        await browser.close();
        if (record) await saveRecording(page, `reserve-${locationId}-${dateInput}-${timeInput}`);
    }
}

export async function rebook(reservationConfirmationId: string, dateInput: string, timeInput: string, courtNumber?: string, waitUntilDrop = false, record = false) {
    const { browser, context, page } = await createBrowserContext(record);
    try {
        await page.goto(`${BASE_URL}/tennisreservation/rebook/${reservationConfirmationId}`);
        await waitUntilDropAndReload(page, dateInput, waitUntilDrop);
        const slotResult = await clickReservationSlot(page, { dateInput, timeInput, courtNumber });
        const resolvedCourtNumber = slotResult.courtNumber;
        await page.getByRole('button', { name: /Make Reservation/i }).click();
        try { await page.waitForFunction(() => /Confirmation Number:/i.test(document.body.innerText), null, { timeout: 30000 }); } catch { }
        const bodyText = await page.locator('body').innerText().catch(() => '');
        const confirmationNumber = extractConfirmationNumber(bodyText);
        if (!confirmationNumber) throw new Error(`Rebook submitted, but no confirmation number was found. Page text: ${bodyText.slice(0, 500)}`);
        const result = { reservationConfirmationId, date: dateInput, time: timeInput, courtNumber: String(resolvedCourtNumber), confirmationNumber, url: page.url() };
        console.log(JSON.stringify(result, null, 2));
        return result;
    } finally {
        await context.close();
        await browser.close();
        if (record) await saveRecording(page, `rebook-${reservationConfirmationId}-${dateInput}-${timeInput}`);
    }
}

type ParsedCommandArgs = {
    positional: string[];
    configPath?: string;
    waitUntilDrop?: boolean;
    record?: boolean;
    numPlayers?: string;
    permitsOrTickets?: string;
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
    return { positional, configPath, waitUntilDrop, record, numPlayers, permitsOrTickets };
}

function parseReserveLikeArgs(args: string[]) {
    const { positional, configPath, waitUntilDrop, record, numPlayers, permitsOrTickets } = parseConfigAndWaitFlags(args);
    const [locationId, dateInput, timeInput, courtNumber] = positional;
    if (!locationId || !dateInput || !timeInput) throw new Error('Usage: reserve <locationId> <MM/DD/YYYY> <h:mmam|pm> [courtNumber] [config]');
    return { locationId, dateInput, timeInput, courtNumber, configPath, waitUntilDrop: !!waitUntilDrop, record: !!record, numPlayers, permitsOrTickets };
}

function parseRebookLikeArgs(args: string[]) {
    const { positional, configPath, waitUntilDrop, record } = parseConfigAndWaitFlags(args);
    const [reservationConfirmationId, dateInput, timeInput, courtNumber] = positional;
    if (!reservationConfirmationId || !dateInput || !timeInput) throw new Error('Usage: rebook <reservationConfirmationId> <MM/DD/YYYY> <h:mmam|pm> [courtNumber] [config]');
    return { reservationConfirmationId, dateInput, timeInput, courtNumber, configPath, waitUntilDrop: !!waitUntilDrop, record: !!record };
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
        const { locationId, dateInput, timeInput, courtNumber, configPath, waitUntilDrop, record, numPlayers, permitsOrTickets } = parseReserveLikeArgs(rest);
        await withRetries('reserve', () => reserve(locationId, dateInput, timeInput, courtNumber, configPath, waitUntilDrop, record, numPlayers, permitsOrTickets));
        return;
    }

    if (command === 'rebook') {
        const { reservationConfirmationId, dateInput, timeInput, courtNumber, waitUntilDrop, record } = parseRebookLikeArgs(rest);
        await withRetries('rebook', () => rebook(reservationConfirmationId, dateInput, timeInput, courtNumber, waitUntilDrop, record));
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
