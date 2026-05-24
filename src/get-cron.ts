import { calculateDropTimeUtc } from './utils';

const dateInput = process.argv[2];
if (!dateInput) {
    console.error('Missing date input (e.g., 05/20/2026)');
    process.exit(1);
}

try {
    const dropAt = calculateDropTimeUtc(dateInput);
    // EventBridge tasks should start 2 minutes before the drop time
    const taskAt = new Date(dropAt.getTime() - (2 * 60 * 1000));
    
    const min = taskAt.getUTCMinutes();
    const hr = taskAt.getUTCHours();
    const dom = taskAt.getUTCDate();
    const mon = taskAt.getUTCMonth() + 1; // 0-indexed in JS
    const dow = '?'; // Required for EventBridge when dom is specified
    const yr = taskAt.getUTCFullYear();
    
    // Format: cron(Minutes Hours Day-of-month Month Day-of-week Year)
    console.log(`cron(${min} ${hr} ${dom} ${mon} ${dow} ${yr})`);
} catch (err: any) {
    console.error(err.message);
    process.exit(1);
}