/** What one delivery attempt of a sink came to. A sink never throws for a refused or failed delivery; the dispatcher records this. */
export interface SinkOutcome {
  ok: boolean;
  /** The receiver's HTTP status (webhook) or SMTP reply code (e-mail), when there was one. */
  statusCode?: number;
  error?: string;
}
