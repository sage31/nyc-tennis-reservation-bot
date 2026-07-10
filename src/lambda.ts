import { Handler } from 'aws-lambda';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { EventBridgeClient, RemoveTargetsCommand, DeleteRuleCommand } from '@aws-sdk/client-eventbridge';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { reserve, rebook, withRetries } from './index';
import type { TaskEvent } from './types';

const secretsClient = new SecretsManagerClient({ region: process.env.AWS_REGION || 'us-east-1' });
const s3Client = new S3Client({ region: process.env.AWS_REGION || 'us-east-1' });
const eventsClient = new EventBridgeClient({ region: process.env.AWS_REGION || 'us-east-1' });

export const handler: Handler = async (rawEvent) => {
    console.log('Received event:', JSON.stringify(rawEvent));

    const event = rawEvent as TaskEvent;
    const { command, params, configSecretId, ruleName, scheduledFor, createdAt, locationId, locationName, profileName } = event;

    if (!command || !params) {
        throw new Error('Invalid event payload. Expected { command, params }.');
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

    // Lambda's only writable location is /tmp; the bot writes video recordings to
    // <cwd>/debug, so run from /tmp. Browsers are preinstalled by the Playwright image.
    process.chdir('/tmp');
    process.env.PLAYWRIGHT_BROWSERS_PATH ||= '/ms-playwright';

    // In lambda we always wait for the drop (jobs fire ~2 mins early) and record for diagnostics.
    console.log(`Running ${command} for profile: ${profileName || 'default'}`);
    let succeeded = false;
    let confirmationNumber: string | null = null;
    let failureReason: string | null = null;
    try {
        if (event.command === 'reserve') {
            const p = event.params;
            const result = await withRetries('reserve', (attempt) => reserve(p.locationId, p.date, p.time, p.court, configPath, true, true, p.numPlayers, p.permitsOrTickets, attempt));
            confirmationNumber = result?.confirmationNumber || null;
        } else if (event.command === 'rebook') {
            const p = event.params;
            const result = await withRetries('rebook', (attempt) => rebook(p.confirmationId, p.date, p.time, p.court, true, true, attempt));
            confirmationNumber = result?.confirmationNumber || null;
        } else {
            throw new Error(`Unknown command: ${command}`);
        }
        succeeded = true;
    } catch (e: any) {
        failureReason = e?.message || String(e);
        console.error('Bot run failed:', failureReason);
    }

    const bucketName = process.env.TENNIS_BUCKET_NAME;
    const primaryId = event.command === 'reserve' ? event.params.locationId : event.params.confirmationId;
    const slug = [primaryId, params.date, params.time].map((a) => String(a || '').replace(/[^a-zA-Z0-9]/g, '-')).join('_');
    const taskFolder = ruleName || `${command}-${slug}`;

    if (bucketName) {
        const taskPayload = JSON.stringify({
            taskId: taskFolder,
            command,
            params,
            locationId: locationId || null,
            locationName: locationName || null,
            profileName: profileName || null,
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
                const s3Key = `tasks/${taskFolder}/recordings/${file}`;
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
        throw new Error(failureReason || 'Command failed.');
    }

    return { statusCode: 200, body: JSON.stringify({ confirmationNumber, profileName: profileName || null }) };
};