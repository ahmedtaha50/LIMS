/**
 * Events, persistent notifications and outbound integrations (roadmap M23, r2-events).
 *
 *   emitEvent(tx, ...)      inside the business transaction: one outbox row, or nothing if the change rolls back (emit.ts)
 *   dispatchOnce / startDispatcher   fan-out to notifications and subscriptions, then deliveries with retries (dispatcher.ts)
 *   EVENT_CATALOG           the versioned event types and their strict payloads (catalog.ts)
 *   checkWebhookUrl         the SSRF guard (ssrf.ts);  signWebhook / verifyWebhookSignature (hmac.ts)
 */
import './entities';

export { EVENT_CATALOG, EVENT_TYPES, catalogView, eventDefinition, isEventType, type EventPayload, type EventType } from './catalog';
export { emitEvent, onEventEmitted, wakeDispatchers, type EmitInput } from './emit';
export {
  dispatchOnce, startDispatcher, envelopeOf, notificationView, userRoom, subscriptionSecretContext, MAX_ATTEMPTS, defaultBackoff,
  type DispatchOptions, type DispatchReport, type Dispatcher, type RoomEmitter,
} from './dispatcher';
export { signWebhook, verifyWebhookSignature, newWebhookSecret, SIGNATURE_HEADER } from './hmac';
export { checkWebhookUrl, checkAddress, configuredAllowList, parseAllowList, DestinationError, type AllowList } from './ssrf';
