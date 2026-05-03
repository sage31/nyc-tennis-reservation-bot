import { chromium } from 'playwright';
import {
    buildApplicant,
    buildPayment, escapeRegExp, extractConfirmationNumber, parseCourtNumber, parseDateInput,
    parseTimeInput, requirePaymentDetails, resolveConfig
} from './utils';

const BASE_URL = 'https://www.nycgovparks.org';
const CHROMIUM_OPTIONS = { headless: true, args: ['--window-size=1280,800'] };
const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36';
const CONTEXT_OPTIONS = { viewport: { width: 1280, height: 800 }, userAgent: USER_AGENT };

function usage() {
    console.error('Usage:');
    console.error('  ts-node src/index.ts reserve <locationId> <MM/DD/YYYY> <h:mmam|pm> [courtNumber] [config]');
    console.error('  ts-node src/index.ts rebook <reservationConfirmationId> <MM/DD/YYYY> <h:mmam|pm> [courtNumber] [config]');
    console.error('  ts-node src/index.ts locations');
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

async function fillApplicantDetails(page: any, applicant: any, numPlayers: string, permitsOrTickets: string) {
    await page.getByRole('button', { name: /Confirm and Enter Player/i }).click();
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
}

async function submitPayment(page: any, payment: any) {
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

async function cancelReservationHold(context: any) {
    const cancelPage = await context.newPage();
    try {
        await cancelPage.goto(`${BASE_URL}/tennisreservation/cancel-reservation`, { waitUntil: 'domcontentloaded', timeout: 15000, referer: `${BASE_URL}/tennisreservation/` });
        const text = await cancelPage.locator('body').innerText().catch(() => '');
        console.log('Cancel flow called for held reservation.');
        if (text) console.log('Cancel page snippet:', text.slice(0, 180).replace(/\s+/g, ' '));
    } finally {
        await cancelPage.close().catch(() => { });
    }
}

async function getLocations() {
    const browser = await chromium.launch(CHROMIUM_OPTIONS);
    const context = await browser.newContext(CONTEXT_OPTIONS);
    const page = await context.newPage();
    try {
        await page.goto(`${BASE_URL}/tennisreservation/`, { waitUntil: 'networkidle', timeout: 5000 }).catch(() => { });
        await page.waitForSelector('table.table.table-bordered', { timeout: 1000 }).catch(() => { });

        // Evaluate rows directly in-page for robustness
        const results = await page.evaluate(() => {
            const out: string[] = [];
            const table = document.querySelector('table.table.table-bordered');
            console.log("found table:", !!table);
            if (!table) return out;
            const rows = Array.from(table.querySelectorAll('tbody tr'));
            console.log(`Found ${rows.length} rows in the locations table.`);
            for (const row of rows) {
                if (row.classList.contains('tennis-res-oos')) continue;
                const strong = row.querySelector('strong');
                if (!strong) continue;
                const name = strong.textContent?.trim() || '';
                const link = row.querySelector('a[href^="/tennisreservation/availability/"]') as HTMLAnchorElement | null;
                const href = link ? link.getAttribute('href') : null;
                if (!href) continue;
                const m = href.match(/availability\/(\d+)/i);
                if (!m) continue;
                out.push(`${name} (id: ${m[1]})`);
            }
            return out;
        });

        if (!results || results.length === 0) {
            console.log('No locations found.');
        } else {
            console.log(results.join('\n'));
        }
    } catch (err: any) {
        console.error('Failed to fetch locations:', err?.message || err);
    } finally {
        await context.close();
        await browser.close();
    }
}

async function reserve(locationId: string, dateInput: string, timeInput: string, courtNumber?: string, configPath?: string) {
    const config = resolveConfig(configPath);
    const applicant = buildApplicant(config);
    const payment = buildPayment(config);
    const numPlayers = String(config.numPlayers || 2);
    const permitsOrTickets = String(config.playersWithPermitsOrTickets || 2);
    const browser = await chromium.launch(CHROMIUM_OPTIONS);
    const context = await browser.newContext(CONTEXT_OPTIONS);
    const page = await context.newPage();
    try {
        await page.goto(`${BASE_URL}/tennisreservation/availability/${locationId}`);
        const slotResult = await clickReservationSlot(page, { dateInput, timeInput, courtNumber });
        const resolvedCourtNumber = slotResult.courtNumber;
        try {
            await fillApplicantDetails(page, applicant, numPlayers, permitsOrTickets);
            const paymentResult = await submitPayment(page, payment);
            console.log(JSON.stringify({ locationId: String(locationId), date: dateInput, time: timeInput, courtNumber: String(resolvedCourtNumber), confirmationNumber: paymentResult.confirmationNumber, url: paymentResult.url }, null, 2));
        } catch (error) {
            console.error('Reservation held but applicant/payment flow failed; attempting to cancel...');
            try { await cancelReservationHold(context); } catch (e) { console.error(`Cancel flow failed: ${e.message}`); }
            throw error;
        }
    } finally {
        await context.close();
        await browser.close();
    }
}

async function rebook(reservationConfirmationId: string, dateInput: string, timeInput: string, courtNumber?: string, configPath?: string) {
    const browser = await chromium.launch(CHROMIUM_OPTIONS);
    const context = await browser.newContext(CONTEXT_OPTIONS);
    const page = await context.newPage();
    try {
        await page.goto(`${BASE_URL}/tennisreservation/rebook/${reservationConfirmationId}`);
        const slotResult = await clickReservationSlot(page, { dateInput, timeInput, courtNumber });
        const resolvedCourtNumber = slotResult.courtNumber;
        await page.getByRole('button', { name: /Make Reservation/i }).click();
        try { await page.waitForFunction(() => /Confirmation Number:/i.test(document.body.innerText), null, { timeout: 30000 }); } catch { }
        const bodyText = await page.locator('body').innerText().catch(() => '');
        const confirmationNumber = extractConfirmationNumber(bodyText);
        if (!confirmationNumber) throw new Error(`Rebook submitted, but no confirmation number was found. Page text: ${bodyText.slice(0, 500)}`);
        console.log(JSON.stringify({ reservationConfirmationId, date: dateInput, time: timeInput, courtNumber: String(resolvedCourtNumber), confirmationNumber, url: page.url() }, null, 2));
    } finally { await context.close(); await browser.close(); }
}

function parseCommandArgs() {
    const args = process.argv.slice(2);

    // Prefer explicit flag: --config or -c
    const flagIndex = args.findIndex((a) => a === '--config' || a === '-c');
    let configPath: string | undefined;
    if (flagIndex !== -1) {
        configPath = args[flagIndex + 1];
        args.splice(flagIndex, 2);
    }
    return { positional: args, configPath };
}

async function main() {
    const { positional, configPath } = parseCommandArgs();
    const [command, locationId, dateInput, timeInput, courtNumber] = positional;
    if (!command) { usage(); process.exitCode = 1; return; }

    if (command === 'locations') { await getLocations(); return; }

    if (command === 'reserve') { if (!locationId || !dateInput || !timeInput) { usage(); process.exitCode = 1; return; } await reserve(locationId, dateInput, timeInput, courtNumber, configPath); return; }

    if (command === 'rebook') { if (!locationId || !dateInput || !timeInput) { usage(); process.exitCode = 1; return; } await rebook(locationId, dateInput, timeInput, courtNumber, configPath); return; }

    usage();
    process.exitCode = 1;
}

main().catch((e) => { console.error(e.message); process.exitCode = 1; });
