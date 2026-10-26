/**
 * Append one diagnostic line with an ISO timestamp. Failures are swallowed.
 * The file self-truncates (keep the newest half) once it passes the cap.
 */
export declare function diag(scope: string, message: string, detail?: unknown): void;
//# sourceMappingURL=diag.d.ts.map