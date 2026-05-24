import { Handler } from 'aws-lambda';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { EventBridgeClient, RemoveTargetsCommand, DeleteRuleCommand } from '@aws-sdk/client-eventbridge';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { currentEtTimestamp } from './utils';

(['log', 'info', 'warn', 'error'] as const).forEach(level => {
    const orig = console[level].bind(console);
    console[level] = (...args: any[]) => orig(`[${currentEtTimestamp()}]`, ...args);
});

const secretsClient = new SecretsManagerClient({ region: process.env.AWS_REGION || 'us-east-1' });
const s3Client = new S3Client({ region: process.env.AWS_REGION || 'us-east-1' });
const eventsClient = new EventBridgeClient({ region: process.env.AWS_REGION || 'us-east-1' });

export const handler: Handler = async (event) => {
    // Event pattern:
    // { "command": "reserve", "args": ["11", "05/20/2026", "8:00am", "12"], "configSecretId": "arn:..." }

    console.log('Received event:', JSON.stringify(event));

    const { command, args, configSecretId, ruleName, scheduledFor, createdAt, locationId, locationName } = event;

    if (!command || !args || !Array.isArray(args)) {
        throw new Error('Invalid event payload. Expected { command: string, args: string[] }');
    }

    let configPath: string | undefined;

    if (configSecretId) {
        console.log(`Fetching config from Secrets Manager: ${configSecretId}`);
        const commandParams = new GetSecretValueCommand({ SecretId: configSecretId });
        const response = await secretsClient.send(commandParams);
        
        if (response.SecretString) {
            configPath = '/tmp/config.yaml';
            fs.writeFileSync(configPath, response.SecretString, 'utf8');
            console.log('Config loaded from secret and written to /tmp/config.yaml');
        }
    }

    // Prepare arguments for spawn
    // We spawn the compiled CLI program in a child process so it starts fresh 
    // and correctly invokes standard Main flow.
    const cliPath = path.resolve(__dirname, 'index.js');
    const spawnArgs = [cliPath, command, ...args];
    
    if (configPath) {
        spawnArgs.push('--config', configPath);
    }
    
    // In lambda, always wait for drop since jobs are scheduled ~2 mins early
    spawnArgs.push('--wait-until-drop');
    // Enable recordings for diagnostics so we can upload them to S3
    spawnArgs.push('--record'); 

    console.log('Spawning process:', 'node', spawnArgs.join(' '));
    const result = spawnSync('node', spawnArgs, {
        cwd: '/tmp', // Run in /tmp so debug folder is written to /tmp/debug
        stdio: ['inherit', 'pipe', 'pipe'],
        encoding: 'utf8',
        env: {
            ...process.env,
            PLAYWRIGHT_BROWSERS_PATH: '/ms-playwright', // Default for mcr.microsoft.com/playwright
        }
    });

    const stdout = result.stdout || '';
    const stderr = result.stderr || '';
    if (stdout) console.log('[bot stdout]\n' + stdout);
    if (stderr) console.error('[bot stderr]\n' + stderr);

    // Parse confirmation number from last JSON object in stdout
    const succeeded = result.status === 0;
    let confirmationNumber: string | null = null;
    try {
        const jsonMatches = stdout.match(/\{[\s\S]*?"confirmationNumber"[\s\S]*?\}/g);
        if (jsonMatches) {
            const parsed = JSON.parse(jsonMatches[jsonMatches.length - 1]);
            confirmationNumber = parsed.confirmationNumber || null;
        }
    } catch {}

    const failureReason = !succeeded
        ? (stderr.split('\n').filter(Boolean).slice(-3).join(' ') || `Exit code ${result.status}`)
        : null;

    const bucketName = process.env.TENNIS_BUCKET_NAME;
    const slug = args.slice(0, 3).map((a: string) => String(a).replace(/[^a-zA-Z0-9]/g, '-')).join('_');
    const taskFolder = ruleName || `${command}-${slug}`;

    if (bucketName) {
        const taskPayload = JSON.stringify({
            taskId: taskFolder,
            command,
            args,
            locationId: locationId || null,
            locationName: locationName || null,
            scheduledFor: scheduledFor || null,
            createdAt: createdAt || null,
            status: succeeded ? 'succeeded' : 'failed',
            confirmationNumber,
            failureReason,
            executedAt: new Date().toISOString(),
        }, null, 2);
        const taskKey = `tasks/${taskFolder}/task.json`;
        await s3Client.send(new PutObjectCommand({
            Bucket: bucketName,
            Key: taskKey,
            Body: taskPayload,
            ContentType: 'application/json',
        }));
        console.log(`Task written to s3://${bucketName}/${taskKey}`);

        const debugDir = '/tmp/debug';
        if (fs.existsSync(debugDir)) {
            const files = fs.readdirSync(debugDir);
            console.log(`Found ${files.length} recording files to upload...`);
            for (const file of files) {
                const filePath = path.join(debugDir, file);
                const fileBody = fs.readFileSync(filePath);
                const ext = path.extname(file) || '.webm';
                const s3Key = `tasks/${taskFolder}/recordings/${Date.now()}${ext}`;
                console.log(`Uploading ${file} to s3://${bucketName}/${s3Key}...`);
                await s3Client.send(new PutObjectCommand({
                    Bucket: bucketName,
                    Key: s3Key,
                    Body: fileBody,
                    ContentType: file.endsWith('.webm') ? 'video/webm' : 'application/octet-stream',
                }));
            }
        }
    }

    if (ruleName) {
        try {
            await eventsClient.send(new RemoveTargetsCommand({ Rule: ruleName, Ids: ['1'] }));
            await eventsClient.send(new DeleteRuleCommand({ Name: ruleName }));
            console.log(`Deleted EventBridge rule: ${ruleName}`);
        } catch (e: any) {
            console.warn(`Failed to delete EventBridge rule ${ruleName}: ${e.message}`);
        }
    }

    if (!succeeded) {
        throw new Error(failureReason || `Command failed with status ${result.status}`);
    }

    return { statusCode: 200, body: JSON.stringify({ confirmationNumber }) };
};