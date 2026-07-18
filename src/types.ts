export type TaskCommand = 'reserve' | 'rebook';

export interface ReserveParams {
    locationId: string;
    date: string;
    time: string;
    court?: string;
    numPlayers?: string;
    permitsOrTickets?: string;
    dryRun?: boolean;
}

export interface RebookParams {
    confirmationId: string;
    date: string;
    time: string;
    court?: string;
    dryRun?: boolean;
}

// Conditional type: the command determines the shape of its params.
export type ParamsFor<C extends TaskCommand> =
    C extends 'reserve' ? ReserveParams :
    C extends 'rebook' ? RebookParams :
    never;

// Discriminated union of a command and its matching params.
export type ScheduledTask =
    | { command: 'reserve'; params: ReserveParams }
    | { command: 'rebook'; params: RebookParams };

// The payload an EventBridge target sends to the Lambda.
export type TaskEvent = ScheduledTask & {
    ruleName?: string;
    scheduledFor?: string;
    createdAt?: string;
    locationId?: string | null;
    locationName?: string | null;
    configSecretId?: string;
    profileName?: string | null;
};
