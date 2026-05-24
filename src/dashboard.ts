/// <reference types="bun-types" />
import { SecretsManagerClient, GetSecretValueCommand, UpdateSecretCommand, CreateSecretCommand } from '@aws-sdk/client-secrets-manager';
import { EventBridgeClient, ListRulesCommand, ListTargetsByRuleCommand, RemoveTargetsCommand, DeleteRuleCommand, PutRuleCommand, PutTargetsCommand } from '@aws-sdk/client-eventbridge';
import { S3Client, ListObjectsV2Command, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { calculateDropTimeUtc } from './utils';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { spawnSync } from 'node:child_process';
import YAML from 'yaml';

const PORT = 3001;
const CWD = process.cwd();
const CONFIG_PATH = path.join(CWD, 'config.yaml');
const BUN = process.argv[0];
const REGION = process.env.AWS_DEFAULT_REGION || 'us-east-1';
const SECRET_ID = process.env.TENNIS_SECRET_ID || '';
const LAMBDA_ARN = process.env.TENNIS_LAMBDA_ARN || '';
const LAUNCH_AGENTS_DIR = path.join(os.homedir(), 'Library', 'LaunchAgents');
const BOT_PREFIX = 'com.nyc-tennis-reservation-bot.';
const BUCKET = process.env.TENNIS_BUCKET_NAME || '';

const secretsClient = new SecretsManagerClient({ region: REGION });
const eventsClient = new EventBridgeClient({ region: REGION });
const s3Client = new S3Client({ region: REGION });

function buildCronExpr(dateInput: string): string {
    const dropAt = calculateDropTimeUtc(dateInput);
    const taskAt = new Date(dropAt.getTime() - 5 * 60 * 1000);
    const min = taskAt.getUTCMinutes();
    const hr = taskAt.getUTCHours();
    const dom = taskAt.getUTCDate();
    const mon = taskAt.getUTCMonth() + 1;
    const yr = taskAt.getUTCFullYear();
    return `cron(${min} ${hr} ${dom} ${mon} ? ${yr})`;
}

async function scheduleAwsJob(command: 'reserve' | 'rebook', args: string[], locationName?: string): Promise<string> {
    if (!LAMBDA_ARN) throw new Error('TENNIS_LAMBDA_ARN env var not set.');
    const safe = (s: string) => s.replace(/[^a-zA-Z0-9]/g, '');
    const ruleName = `tennis-${command}-${args.slice(0, 3).map(safe).join('-')}`;
    const dateInput = args[1];
    const dropAt = calculateDropTimeUtc(dateInput);
    const runsAt = new Date(dropAt.getTime() - 5 * 60 * 1000);
    const scheduledFor = runsAt.toISOString();
    const createdAt = new Date().toISOString();
    const locationId = command === 'reserve' ? (args[0] || null) : null;
    const cronExpr = buildCronExpr(dateInput);
    const payload = JSON.stringify({ command, args, ruleName, scheduledFor, createdAt, locationId, locationName: locationName || null, ...(SECRET_ID ? { configSecretId: SECRET_ID } : {}) });
    await eventsClient.send(new PutRuleCommand({ Name: ruleName, ScheduleExpression: cronExpr, State: 'ENABLED' }));
    await eventsClient.send(new PutTargetsCommand({ Rule: ruleName, Targets: [{ Id: '1', Arn: LAMBDA_ARN, Input: payload }] }));
    if (BUCKET) {
        await s3Client.send(new PutObjectCommand({
            Bucket: BUCKET,
            Key: `tasks/${ruleName}/task.json`,
            Body: JSON.stringify({ taskId: ruleName, command, args, locationId, locationName: locationName || null, scheduledFor, createdAt, status: 'scheduled', confirmationNumber: null, failureReason: null, executedAt: null }, null, 2),
            ContentType: 'application/json',
        }));
    }
    return ruleName;
}

async function runBot(args: string[], timeoutMs = 60_000) {
    const proc = Bun.spawn([BUN, 'src/index.ts', ...args], { cwd: CWD, stdout: 'pipe', stderr: 'pipe' });
    const timer = setTimeout(() => proc.kill(), timeoutMs);
    try {
        const [stdout, stderr, exitCode] = await Promise.all([
            new Response(proc.stdout).text(),
            new Response(proc.stderr).text(),
            proc.exited,
        ]);
        clearTimeout(timer);
        return { stdout: stdout.trim(), stderr: stderr.trim(), success: exitCode === 0 };
    } catch (e: any) {
        clearTimeout(timer);
        return { stdout: '', stderr: e.message, success: false };
    }
}

function json(data: unknown, status = 200) {
    return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

function parseLocalLabel(label: string) {
    // com.nyc-tennis-reservation-bot.{command}.{id}.{YYYY-MM-DD}.{time}.{ts}
    const parts = label.replace(BOT_PREFIX, '').split('.');
    return {
        label,
        command: parts[0] || '?',
        id: parts[1] || '?',
        date: parts[2] || '?',
        time: (parts[3] || '?').replace(/-/g, ':').replace(/(\d+):(\d+)(am|pm)/i, '$1:$2$3'),
        scheduledAt: parts[4] ? new Date(Number(parts[4])).toLocaleString() : '?',
    };
}

function parsePlistRunTime(plistPath: string): { month?: number; day?: number; hour?: number; minute?: number } | null {
    try {
        const xml = fs.readFileSync(plistPath, 'utf8');
        const monthMatch = xml.match(/<key>Month<\/key>\s*<integer>(\d+)<\/integer>/);
        const dayMatch = xml.match(/<key>Day<\/key>\s*<integer>(\d+)<\/integer>/);
        const hourMatch = xml.match(/<key>Hour<\/key>\s*<integer>(\d+)<\/integer>/);
        const minuteMatch = xml.match(/<key>Minute<\/key>\s*<integer>(\d+)<\/integer>/);
        if (!monthMatch && !dayMatch && !hourMatch && !minuteMatch) return null;
        return {
            month: monthMatch ? parseInt(monthMatch[1], 10) : undefined,
            day: dayMatch ? parseInt(dayMatch[1], 10) : undefined,
            hour: hourMatch ? parseInt(hourMatch[1], 10) : undefined,
            minute: minuteMatch ? parseInt(minuteMatch[1], 10) : undefined,
        };
    } catch {
        return null;
    }
}

function computeRunsAt(plistPath: string): number | null {
    const t = parsePlistRunTime(plistPath);
    if (!t) return null;
    const now = new Date();
    const year = now.getFullYear();
    const month = t.month != null ? t.month - 1 : now.getMonth();
    const day = t.day != null ? t.day : now.getDate();
    const hour = t.hour != null ? t.hour : 0;
    const minute = t.minute != null ? t.minute : 0;
    const dt = new Date(year, month, day, hour, minute, 0, 0);
    // If the time is in the past by more than a day, try next year
    if (dt.getTime() < Date.now() - 86400_000) {
        dt.setFullYear(year + 1);
    }
    return dt.getTime();
}

function listLocalJobs() {
    try {
        const files = fs.readdirSync(LAUNCH_AGENTS_DIR);
        const plists = files.filter(f => f.startsWith(BOT_PREFIX) && f.endsWith('.plist'));
        const loadedRaw = spawnSync('launchctl', ['list'], { encoding: 'utf8' }).stdout || '';
        return plists.map(f => {
            const label = f.replace('.plist', '');
            const loaded = loadedRaw.includes(label);
            const plistPath = path.join(LAUNCH_AGENTS_DIR, f);
            const runsAt = computeRunsAt(plistPath);
            const dropAt = runsAt != null ? runsAt + 2 * 60 * 1000 : null;
            return { ...parseLocalLabel(label), loaded, plistPath, runsAt, dropAt };
        });
    } catch {
        return [];
    }
}

async function listAwsJobs() {
    try {
        const rules = await eventsClient.send(new ListRulesCommand({ NamePrefix: 'tennis-', Limit: 50 }));
        const jobs = await Promise.all((rules.Rules || []).map(async r => {
            let args: string[] | null = null;
            let command: string | null = null;
            try {
                const tgts = await eventsClient.send(new ListTargetsByRuleCommand({ Rule: r.Name! }));
                const t = (tgts.Targets || [])[0];
                if (t?.Input) {
                    const p = JSON.parse(t.Input);
                    args = p.args ?? null;
                    command = p.command ?? null;
                }
            } catch {}
            return { name: r.Name || '', schedule: r.ScheduleExpression || '', state: r.State || '', args, command };
        }));
        return jobs;
    } catch (e: any) {
        return { error: e.message };
    }
}

async function deleteLocalJob(label: string) {
    const uid = typeof process.getuid === 'function' ? process.getuid() : 501;
    spawnSync('launchctl', ['bootout', `gui/${uid}/${label}`], { encoding: 'utf8' });
    const base = path.join(LAUNCH_AGENTS_DIR, label);
    for (const ext of ['.plist', '.sh', '.out.log', '.err.log']) {
        try { fs.unlinkSync(base + ext); } catch {}
    }
}

async function deleteAwsJob(ruleName: string) {
    const targets = await eventsClient.send(new ListTargetsByRuleCommand({ Rule: ruleName }));
    const ids = (targets.Targets || []).map(t => t.Id!);
    if (ids.length) await eventsClient.send(new RemoveTargetsCommand({ Rule: ruleName, Ids: ids }));
    await eventsClient.send(new DeleteRuleCommand({ Name: ruleName }));
}

const DASHBOARD_HTML_PATH = path.join(CWD, 'src', 'dashboard.html');

Bun.serve({
    port: PORT,
    async fetch(req: Request) {
        const url = new URL(req.url);
        const { pathname } = url;

        if (pathname === '/api/info' && req.method === 'GET') {
            return json({ smEnabled: !!SECRET_ID, awsEnabled: !!LAMBDA_ARN, region: REGION });
        }

        if (pathname === '/') {
            try {
                const html = fs.readFileSync(DASHBOARD_HTML_PATH, 'utf8');
                return new Response(html, { headers: { 'Content-Type': 'text/html' } });
            } catch {
                return new Response('dashboard.html not found', { status: 500, headers: { 'Content-Type': 'text/plain' } });
            }
        }

        if (pathname === '/api/locations' && req.method === 'GET') {
            const result = await runBot(['locations']);
            if (result.success) {
                try {
                    return json({ success: true, locations: JSON.parse(result.stdout) });
                } catch {
                    return json({ success: false, locations: [], error: 'Could not parse locations output.' });
                }
            }
            return json({ success: false, locations: [], error: result.stderr });
        }

        if (pathname === '/api/schedule/reserve' && req.method === 'POST') {
            const { locationId, date, time, court, numPlayers, permitsOrTickets, target, locationName } = await req.json();
            if (!locationId || !date || !time) return json({ success: false, stderr: 'Missing required fields.' }, 400);
            const extraFlags = [
                ...(numPlayers && numPlayers !== '2' ? ['--players', String(numPlayers)] : []),
                ...(permitsOrTickets && permitsOrTickets !== '2' ? ['--permits', String(permitsOrTickets)] : []),
            ];
            if (target === 'aws') {
                try {
                    const ruleName = await scheduleAwsJob('reserve', [locationId, date, time, ...(court ? [court] : []), ...extraFlags], locationName);
                    return json({ success: true, stdout: `Scheduled AWS rule: ${ruleName}` });
                } catch (e: any) {
                    return json({ success: false, stderr: e.message });
                }
            }
            return json(await runBot(['schedule', 'reserve', locationId, date, time, ...(court ? [court] : []), ...extraFlags]));
        }

        if (pathname === '/api/schedule/rebook' && req.method === 'POST') {
            const { confirmationId, date, time, court, target } = await req.json();
            if (!confirmationId || !date || !time) return json({ success: false, stderr: 'Missing required fields.' }, 400);
            if (target === 'aws') {
                try {
                    const ruleName = await scheduleAwsJob('rebook', [confirmationId, date, time, ...(court ? [court] : [])]);
                    return json({ success: true, stdout: `Scheduled AWS rule: ${ruleName}` });
                } catch (e: any) {
                    return json({ success: false, stderr: e.message });
                }
            }
            return json(await runBot(['schedule', 'rebook', confirmationId, date, time, ...(court ? [court] : [])]));
        }

        if (pathname === '/api/config' && req.method === 'GET') {
            try {
                return json({ success: true, content: fs.readFileSync(CONFIG_PATH, 'utf8') });
            } catch {
                return json({ success: false, error: 'config.yaml not found. Create one from config.example.yaml.' });
            }
        }

        if (pathname === '/api/config' && req.method === 'PUT') {
            const { content } = await req.json();
            try {
                YAML.parse(content);
                fs.writeFileSync(CONFIG_PATH, content, 'utf8');
                return json({ success: true });
            } catch (e: any) {
                return json({ success: false, error: e.message });
            }
        }

        if (pathname === '/api/secret' && req.method === 'GET') {
            const id = url.searchParams.get('id');
            if (!id) return json({ success: false, error: 'Missing secret id.' }, 400);
            try {
                const res = await secretsClient.send(new GetSecretValueCommand({ SecretId: id }));
                return json({ success: true, content: res.SecretString || '' });
            } catch (e: any) {
                return json({ success: false, error: e.message });
            }
        }

        if (pathname === '/api/secret' && req.method === 'PUT') {
            const id = url.searchParams.get('id');
            if (!id) return json({ success: false, error: 'Missing secret id.' }, 400);
            const { content } = await req.json();
            try {
                YAML.parse(content);
            } catch (e: any) {
                return json({ success: false, error: `Invalid YAML: ${e.message}` });
            }
            try {
                await secretsClient.send(new UpdateSecretCommand({ SecretId: id, SecretString: content }));
                return json({ success: true });
            } catch (e: any) {
                if (e.name === 'ResourceNotFoundException') {
                    await secretsClient.send(new CreateSecretCommand({ Name: id, SecretString: content }));
                    return json({ success: true });
                }
                return json({ success: false, error: e.message });
            }
        }

        if (pathname === '/api/player' && req.method === 'GET') {
            let raw: string;
            let source: 'aws-sm' | 'local' = 'local';
            let smError: string | undefined;
            if (SECRET_ID) {
                try {
                    const smRes = await secretsClient.send(new GetSecretValueCommand({ SecretId: SECRET_ID }));
                    raw = smRes.SecretString || '';
                    source = 'aws-sm';
                    try { fs.writeFileSync(CONFIG_PATH, raw, 'utf8'); } catch {}
                } catch (e: any) {
                    smError = e.message;
                    console.error(`[SM] GetSecretValue failed (${SECRET_ID}):`, e.message);
                    try { raw = fs.readFileSync(CONFIG_PATH, 'utf8'); } catch {
                        return json({ success: false, error: 'No config found locally or in Secrets Manager.', smError });
                    }
                }
            } else {
                try { raw = fs.readFileSync(CONFIG_PATH, 'utf8'); } catch {
                    return json({ success: false, error: 'config.yaml not found.' });
                }
            }
            try {
                const cfg = YAML.parse(raw) as any;
                const payment = cfg.payment || {};
                const cardNumber: string = String(payment.cardNumber || '');
                const last4 = cardNumber.length >= 4 ? cardNumber.slice(-4) : cardNumber;
                const cardNumberMasked = cardNumber.length > 4
                    ? '•••• •••• •••• ' + last4
                    : cardNumber ? '•'.repeat(cardNumber.length) : '';
                const groups = cardNumber.replace(/\D/g, '').match(/.{1,4}/g);
                const cardNumberFull = groups ? groups.join(' ') : cardNumber;
                return json({
                    success: true,
                    source,
                    smEnabled: !!SECRET_ID,
                    smError,
                    config: {
                        applicant: cfg.applicant || {},
                        payment: {
                            cardholder: (cfg.applicant || {}).name || '',
                            cardNumberFull,
                            cardNumberMasked,
                            last4,
                            expMonth: payment.expMonth || '',
                            expYear: payment.expYear || '',
                            cvvFull: String(payment.cvv || ''),
                        },
                    },
                });
            } catch (e: any) {
                return json({ success: false, error: `Failed to parse config: ${e.message}` });
            }
        }

        if (pathname === '/api/player' && req.method === 'PUT') {
            try {
                const body = await req.json() as { applicant?: Record<string, string>; payment?: Record<string, string> };
                const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
                const cfg = YAML.parse(raw) as any;
                if (body.applicant) {
                    cfg.applicant = { ...(cfg.applicant || {}), ...body.applicant };
                }
                if (body.payment) {
                    cfg.payment = { ...(cfg.payment || {}), ...body.payment };
                }
                const newContent = YAML.stringify(cfg);
                fs.writeFileSync(CONFIG_PATH, newContent, 'utf8');
                let smSynced = false;
                let smError: string | undefined;
                if (SECRET_ID) {
                    try {
                        await secretsClient.send(new UpdateSecretCommand({ SecretId: SECRET_ID, SecretString: newContent }));
                        smSynced = true;
                    } catch (e: any) {
                        if (e.name === 'ResourceNotFoundException') {
                            try {
                                await secretsClient.send(new CreateSecretCommand({ Name: SECRET_ID, SecretString: newContent }));
                                smSynced = true;
                            } catch (e2: any) { smError = e2.message; }
                        } else { smError = e.message; }
                    }
                }
                return json({ success: true, smSynced, smEnabled: !!SECRET_ID, smError });
            } catch (e: any) {
                return json({ success: false, error: e.message });
            }
        }

        if (pathname === '/api/scheduled' && req.method === 'GET') {
            const [local, aws] = await Promise.all([listLocalJobs(), listAwsJobs()]);
            return json({ local, aws });
        }

        if (pathname === '/api/scheduled/local' && req.method === 'DELETE') {
            const { label } = await req.json();
            if (!label || !label.startsWith(BOT_PREFIX)) return json({ success: false, error: 'Invalid label.' }, 400);
            try {
                await deleteLocalJob(label);
                return json({ success: true });
            } catch (e: any) {
                return json({ success: false, error: e.message });
            }
        }

        if (pathname === '/api/scheduled/aws' && req.method === 'DELETE') {
            const { rule } = await req.json();
            if (!rule) return json({ success: false, error: 'Missing rule name.' }, 400);
            try {
                await deleteAwsJob(rule);
                return json({ success: true });
            } catch (e: any) {
                return json({ success: false, error: e.message });
            }
        }

        if (pathname === '/api/results' && req.method === 'GET') {
            if (!BUCKET) return json({ success: false, error: 'TENNIS_BUCKET_NAME not set.' });
            try {
                const listed = await s3Client.send(new ListObjectsV2Command({
                    Bucket: BUCKET,
                    Prefix: 'tasks/',
                    MaxKeys: 500,
                }));
                const keys = (listed.Contents || [])
                    .filter(o => o.Key?.endsWith('/task.json'))
                    .sort((a, b) => (b.LastModified?.getTime() ?? 0) - (a.LastModified?.getTime() ?? 0))
                    .slice(0, 100)
                    .map(o => o.Key!);
                const results = await Promise.all(keys.map(async key => {
                    try {
                        const obj = await s3Client.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
                        const text = await obj.Body!.transformToString();
                        return JSON.parse(text);
                    } catch { return null; }
                }));
                return json({ success: true, results: results.filter(Boolean) });
            } catch (e: any) {
                return json({ success: false, error: e.message });
            }
        }

        return new Response('Not Found', { status: 404 });
    },
});

console.log(`Dashboard → http://localhost:${PORT}`);
