import * as fs from 'node:fs';
import * as path from 'node:path';
import YAML from 'yaml';
import { spawnSync } from 'child_process';

export const DEFAULT_CONFIG = 'config.yaml';
export const ET_TIMEZONE = 'America/New_York';

export function escapeRegExp(value: any) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function parseDateInput(input: string) {
  const match = String(input || '')
    .trim()
    .match(/^(\d{1,2})[\/:-](\d{1,2})[\/:-](\d{4})$/);
  if (!match) throw new Error(`Invalid date "${input}". Use MM/DD/YYYY.`);
  const month = match[1].padStart(2, '0');
  const day = match[2].padStart(2, '0');
  const year = match[3];
  const parsed = new Date(`${year}-${month}-${day}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) throw new Error(`Invalid date "${input}".`);
  const weekday = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][parsed.getUTCDay()];
  return { iso: `${year}-${month}-${day}`, tabLabel: `${weekday} ${month}/${day}` };
}

export function parseTimeInput(input: string) {
  const normalized = String(input || '').trim().toUpperCase().replace(/\s+/g, '');
  const match = normalized.match(/^(\d{1,2})(?::(\d{2}))?(AM|PM)$/);
  if (!match) throw new Error(`Invalid time "${input}". Use h:mmam/pm.`);
  const hour = Number.parseInt(match[1], 10);
  const minute = match[2] || '00';
  const hourLabel = String(hour % 12 || 12);
  const meridiemLabel = match[3] === 'AM' ? 'a.m.' : 'p.m.';
  return { label: `${hourLabel}:${minute} ${meridiemLabel}` };
}

export function parseCourtNumber(input: string) {
  const match = String(input || '').trim().match(/(?:court\s*)?(\d+)/i);
  if (!match) throw new Error(`Invalid court "${input}".`);
  return match[1];
}

export function isConfigPath(value: any) {
  return typeof value === 'string' && /\.(ya?ml|json)$/i.test(value);
}

export function loadConfig(configPath?: string) {
  if (!configPath) return {};
  const absolutePath = path.resolve(configPath);
  const raw = fs.readFileSync(absolutePath, 'utf8');
  if (/\.json$/i.test(absolutePath)) return JSON.parse(raw);
  const parsed = YAML.parse(raw);
  return parsed && typeof parsed === 'object' ? parsed : {};
}

export function extractConfirmationNumber(text: string) {
  const match = String(text || '').match(/Confirmation Number:\s*([A-Za-z0-9]+)/i);
  return match ? match[1] : null;
}

export function buildApplicant(config: any) {
  return { ...(config.applicant || {}) };
}

export function buildPayment(config: any) {
  return {
    cardNumber: String(config.payment?.cardNumber || '').trim(),
    expMonth: String(config.payment?.expMonth || '').trim(),
    expYear: String(config.payment?.expYear || '').trim(),
    cvv: String(config.payment?.cvv || '').trim(),
  };
}

export function requirePaymentDetails(payment: any) {
  const missing: string[] = [];
  if (!payment.cardNumber) missing.push('payment.cardNumber');
  if (!payment.expMonth) missing.push('payment.expMonth');
  if (!payment.expYear) missing.push('payment.expYear');
  if (!payment.cvv) missing.push('payment.cvv');
  if (missing.length) throw new Error(`Missing payment config fields: ${missing.join(', ')}`);
}

export function resolveConfig(configPath?: string) {
    if (configPath) return loadConfig(configPath);
    const defaultPath = path.resolve(DEFAULT_CONFIG);
    if (fs.existsSync(defaultPath)) return loadConfig(defaultPath);
    return {};
}

export function shellQuote(value: string) {
    return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

export function getTimeZoneOffsetMs(date: Date, timeZone: string) {
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone,
        timeZoneName: 'shortOffset',
        hour: '2-digit'
    }).formatToParts(date);
    const tzName = parts.find((p) => p.type === 'timeZoneName')?.value || 'GMT+0';
    return parseShortOffsetToMs(tzName);
}

export function parseShortOffsetToMs(shortOffset: string) {
    const match = shortOffset.match(/GMT([+-])(\d{1,2})(?::?(\d{2}))?/i);
    if (!match) return 0;
    const sign = match[1] === '-' ? -1 : 1;
    const hours = Number.parseInt(match[2], 10);
    const minutes = Number.parseInt(match[3] || '0', 10);
    return sign * ((hours * 60) + minutes) * 60 * 1000;
}
export function zonedDateTimeToUtcDate(year: number, month: number, day: number, hour: number, minute: number, second: number, timeZone: string) {
    let guess = Date.UTC(year, month - 1, day, hour, minute, second);
    for (let i = 0; i < 3; i += 1) {
        const offset = getTimeZoneOffsetMs(new Date(guess), timeZone);
        guess = Date.UTC(year, month - 1, day, hour, minute, second) - offset;
    }
    return new Date(guess);
}

export function calculateDropTimeUtc(dateInput: string) {
    const parsed = parseDateInput(dateInput);
    const [year, month, day] = parsed.iso.split('-').map((v) => Number.parseInt(v, 10));
    const dropDate = new Date(Date.UTC(year, month - 1, day));
    dropDate.setUTCDate(dropDate.getUTCDate() - 7);
    const dropYear = dropDate.getUTCFullYear();
    const dropMonth = dropDate.getUTCMonth() + 1;
    const dropDay = dropDate.getUTCDate();
    return zonedDateTimeToUtcDate(dropYear, dropMonth, dropDay, 0, 0, 0, ET_TIMEZONE);
}

export function formatDateForEt(date: Date) {
    return new Intl.DateTimeFormat('en-US', {
        timeZone: ET_TIMEZONE,
        dateStyle: 'medium',
        timeStyle: 'medium'
    }).format(date);
}

export function startCalendarIntervalXml(date: Date) {
    return [
        '  <dict>',
        '    <key>Month</key>',
        `    <integer>${date.getMonth() + 1}</integer>`,
        '    <key>Day</key>',
        `    <integer>${date.getDate()}</integer>`,
        '    <key>Hour</key>',
        `    <integer>${date.getHours()}</integer>`,
        '    <key>Minute</key>',
        `    <integer>${date.getMinutes()}</integer>`,
        '  </dict>'
    ].join('\n');
}

export function resolveBunBinary() {
    const fromPath = spawnSync('which', ['bun'], { encoding: 'utf8' });
    const candidate = (fromPath.stdout || '').trim();
    if (fromPath.status === 0 && candidate) return candidate;
    const fallbackCandidates = ['/opt/homebrew/bin/bun', '/usr/local/bin/bun'];
    for (const fallback of fallbackCandidates) {
        if (fs.existsSync(fallback)) return fallback;
    }
    throw new Error('Could not find bun in PATH. Install bun and ensure it is available to launchd.');
}

export function runCommandOrThrow(command: string, args: string[], errorMessage: string) {
    const result = spawnSync(command, args, { encoding: 'utf8' });
    if (result.status !== 0) {
        const stderr = (result.stderr || '').trim();
        throw new Error(`${errorMessage}${stderr ? ` (${stderr})` : ''}`);
    }
    return result;
}

export function toPmsetTimestamp(date: Date) {
    const mm = String(date.getMonth() + 1).padStart(2, '0');
    const dd = String(date.getDate()).padStart(2, '0');
    const yy = String(date.getFullYear()).slice(-2);
    const hh = String(date.getHours()).padStart(2, '0');
    const min = String(date.getMinutes()).padStart(2, '0');
    const ss = String(date.getSeconds()).padStart(2, '0');
    return `${mm}/${dd}/${yy} ${hh}:${min}:${ss}`;
}

export function currentEtTimestamp() {
    const d = new Date();
    const formatted = d.toLocaleString('en-US', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).replace(',', '');
    return formatted + '.' + String(d.getMilliseconds()).padStart(3, '0') + ' ET';
}

export async function sleep(ms: number) {
    await new Promise((resolve) => setTimeout(resolve, ms));
}

export async function waitUntilDropAndReload(page: any, dateInput: string, enabled: boolean) {
    if (!enabled) return;
    const dropAt = calculateDropTimeUtc(dateInput);
    const now = new Date();
    if (dropAt.getTime() > now.getTime()) {
        console.log(`Task primed. Waiting until reservation drop at ${formatDateForEt(dropAt)} ET...`);
        while (Date.now() < dropAt.getTime()) {
            const remaining = dropAt.getTime() - Date.now();
            await page.waitForTimeout(Math.min(1000, remaining));
        }
    }
    console.log('Reached drop time. Reloading page to refresh live inventory...');
    await page.reload({ waitUntil: 'domcontentloaded' }).catch(async () => {
        await page.goto(page.url(), { waitUntil: 'domcontentloaded' });
    });
}