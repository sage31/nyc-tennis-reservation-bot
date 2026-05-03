import * as fs from 'node:fs';
import * as path from 'node:path';
import YAML from 'yaml';

export const DEFAULT_CONFIG = 'config.yaml';

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
}// Note: resolveConfig implemented inline to use DEFAULT_CONFIG
export function resolveConfig(configPath?: string) {
    if (configPath) return loadConfig(configPath);
    const defaultPath = path.resolve(DEFAULT_CONFIG);
    if (fs.existsSync(defaultPath)) return loadConfig(defaultPath);

    // Fallback to .yml if .yaml not present
    const alt = DEFAULT_CONFIG.replace(/\.ya?ml$/i, (m) => (m.toLowerCase() === '.yaml' ? '.yml' : m));
    const altPath = path.resolve(alt);
    if (alt !== DEFAULT_CONFIG && fs.existsSync(altPath)) return loadConfig(altPath);

    // Also check for config.yml explicitly if DEFAULT_CONFIG didn't specify extension
    if (!DEFAULT_CONFIG.endsWith('.yaml') && !DEFAULT_CONFIG.endsWith('.yml')) {
        const explicitYml = path.resolve(`${DEFAULT_CONFIG}.yml`);
        if (fs.existsSync(explicitYml)) return loadConfig(explicitYml);
    }

    return {};
}

