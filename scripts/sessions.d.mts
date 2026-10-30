export type SenderMode = 'bypass' | 'prompting';
export type ReplyAddress = `uds:${string}`;
export interface Target { id: string; pid: number }
export interface OpenOptions extends Target { name: string; ttl?: number; senderMode?: SenderMode }
export interface ChannelSendOptions { text: string; messageId?: string; senderMode?: never; channel?: never; id?: never; pid?: never }
export type SendOptions =
  | (Omit<ChannelSendOptions, 'channel'> & { channel: string; wait?: never; replyTtl?: never })
  | (Target & { text: string; senderMode?: SenderMode; wait?: number; replyTtl?: number; channel?: never; messageId?: never });
export type WaitOptions =
  | { channel: string; after?: string; until?: 'reply'; timeout?: number; request?: never }
  | { request: string; timeout?: number; channel?: never; after?: never; until?: never };
export interface ChannelWaitOptions { timeout?: number; until?: 'reply' | 'event'; after?: never; channel?: never }
export interface ChannelCheckpoint { handle: string; cursor: string }
export interface ChannelSnapshot extends ChannelCheckpoint {
  address: ReplyAddress; name: string; sessionId: string; pid: number; expiresAt: string; closed: boolean;
}
export interface OpenResult {
  status: 'open'; channel: string; channelId: string; cursor: string; address: ReplyAddress;
  name: string; sessionId: string; pid: number; expiresAt: string;
}
export interface DeliveryReceipt { messageId?: string | null; status: string; correlated?: boolean; reason?: string; receivedAt?: string }
export interface ReplyEvent {
  kind: 'reply'; status: 'received'; text: string; from: string; messageId: string | null; seq: number; receivedAt: string;
}
export interface ReceiptEvent { kind: 'receipt'; status: 'receipt'; receipt: DeliveryReceipt & { messageId: string | null; correlated: boolean; receivedAt: string }; seq: number }
export interface LifecycleEvent { kind?: undefined; status: string; message?: string }
export type LegacyReplyEvent = Omit<ReplyEvent, 'kind'> & { kind?: undefined };
export type ChannelEvent = ReplyEvent | ReceiptEvent | LegacyReplyEvent | LifecycleEvent;
export interface ChannelWaitResult {
  channel: string; address: ReplyAddress; name: string; sessionId: string; expiresAt: string;
  cursor: string; reply: ChannelEvent; receipts?: ReceiptEvent[];
}
export interface RequestWaitResult {
  request: string; sessionId: string; messageId: string; expiresAt: string;
  reply: { status: string; text?: string; from?: string; messageId?: string | null; receipt?: DeliveryReceipt };
}
export interface SendResult {
  status: 'submitted' | 'queued'; acceptance: 'unconfirmed'; sessionId: string; pid: number; messageId: string;
  cursor: string | null; queuedAt?: string; sentAt?: string; reused?: boolean; note: string;
  channel?: string; request?: string; address?: ReplyAddress; name?: string; expiresAt?: string; reply?: RequestWaitResult['reply'];
}
export interface CloseResult { status: 'closed'; channel?: string; request?: string; undelivered?: string[] }
export type OutgoingStatus = { channel: string; messageId: string; queuedAt: string } & (
  | { status: 'queued'; sentAt?: never; error?: never }
  | { status: 'submitted'; sentAt?: string; error?: never }
  | { error: string; message: string; status?: never; sentAt?: never }
);
export interface TranscriptMessage { id: string | null; role: string; timestamp?: string | null; text: string; from?: string }
export interface ReadOptions { id: string; tail?: number; maxChars?: number; before?: string; after?: string; events?: boolean }
export interface ReadResult {
  sessionId: string; messages: TranscriptMessage[]; cursor: string | null; firstCursor: string | null; lastCursor: string | null;
  availableMessages: number; truncated: boolean; ancestryIncomplete: boolean; warnings: unknown[]; source?: string;
}
export interface SessionInfo {
  id: string; pid: number; name: string | null; cwd: string; status: string; processIdentity: string; socket: string | null;
  statusUpdatedAt: number | null; waitingFor: unknown; version?: string; lastMessage?: TranscriptMessage | null;
  latestUser?: string; ancestryIncomplete?: boolean; transcriptWarnings?: unknown[]; transcriptError?: string;
}
export interface ListResult { capturedAt: string; configDir: string; counts: { verified: number; unverified: number }; sessions: SessionInfo[]; warnings: unknown[] }
export interface Channel {
  readonly handle: string; readonly address: ReplyAddress; readonly cursor: string; readonly closed: boolean;
  readonly name: string; readonly sessionId: string; readonly pid: number; readonly expiresAt: string;
  send(options: ChannelSendOptions): Promise<SendResult>;
  wait(options?: ChannelWaitOptions): Promise<ChannelWaitResult>;
  status(options: { messageId: string }): Promise<OutgoingStatus>;
  close(): Promise<CloseResult>;
  snapshot(): ChannelSnapshot;
  toJSON(): ChannelSnapshot;
}
export interface Sessions {
  connect(options: OpenOptions): Promise<Channel>;
  resumeChannel(checkpoint: ChannelCheckpoint): Channel;
  list(options?: { noPreview?: boolean }): Promise<ListResult>;
  read(options: ReadOptions): Promise<ReadResult>;
  open(options: OpenOptions): Promise<OpenResult>;
  send(options: SendOptions): Promise<SendResult>;
  wait(options: Extract<WaitOptions, { channel: string }>): Promise<ChannelWaitResult>;
  wait(options: Extract<WaitOptions, { request: string }>): Promise<RequestWaitResult>;
  status(options: { channel: string; messageId: string }): Promise<OutgoingStatus>;
  channels(): Promise<{ capturedAt: string; channels: Array<Record<string, unknown>>; warnings: unknown[] }>;
  close(options: { channel: string; request?: never } | { request: string; channel?: never }): Promise<CloseResult>;
}
export function createSessions(options?: { configDir?: string }): Sessions;
