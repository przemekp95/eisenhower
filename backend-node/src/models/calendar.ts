import { Schema, model, models } from 'mongoose';

const scope = {
  tenantId: { type: String, required: true, index: true },
  ownerId: { type: String, required: true, index: true },
};

const connectionSchema = new Schema({
  ...scope,
  provider: { type: String, required: true, enum: ['google'] },
  calendarId: { type: String, required: true },
  credentialRef: { type: String, required: true },
  status: { type: String, required: true, enum: ['active', 'revoked', 'error'] },
}, { timestamps: true });
connectionSchema.index({ tenantId: 1, ownerId: 1, provider: 1, calendarId: 1 }, { unique: true });

const bindingSchema = new Schema({
  ...scope,
  connectionId: { type: Schema.Types.ObjectId, required: true, index: true },
  taskId: { type: Schema.Types.ObjectId, required: true, index: true },
  providerEventId: { type: String, required: true },
  providerEtag: { type: String, required: true },
  lastTaskRevision: { type: Number, required: true },
  lastProviderRevision: { type: String, required: true },
  providerDeletedAt: { type: Date },
}, { timestamps: true });
bindingSchema.index({ tenantId: 1, ownerId: 1, taskId: 1 }, { unique: true });
bindingSchema.index(
  { tenantId: 1, ownerId: 1, connectionId: 1, providerEventId: 1 },
  { unique: true },
);

const conflictSchema = new Schema({
  ...scope,
  connectionId: { type: Schema.Types.ObjectId, required: true, index: true },
  bindingId: { type: Schema.Types.ObjectId, required: true, index: true },
  taskId: { type: Schema.Types.ObjectId, required: true, index: true },
  taskRevision: { type: Number, required: true },
  providerRevision: { type: String, required: true },
  providerSnapshot: { type: Schema.Types.Mixed, required: true },
  status: { type: String, required: true, enum: ['open', 'resolved_local', 'resolved_provider'] },
  resolvedAt: { type: Date },
}, { timestamps: true, versionKey: 'revision' });
conflictSchema.index(
  { bindingId: 1, taskRevision: 1, providerRevision: 1 },
  { unique: true },
);

const syncStateSchema = new Schema({
  ...scope,
  connectionId: { type: Schema.Types.ObjectId, required: true, unique: true },
  syncToken: { type: String },
  pageToken: { type: String },
  fullResyncRequired: { type: Boolean, required: true, default: false },
  watch: {
    type: new Schema({
      channelId: { type: String, required: true },
      resourceId: { type: String, required: true },
      expiresAt: { type: Date, required: true },
    }, { _id: false }),
  },
  lastRequestedAt: { type: Date },
  lastCompletedAt: { type: Date },
}, { timestamps: true });

const outboxSchema = new Schema({
  eventId: { type: String, required: true, unique: true },
  ...scope,
  aggregateId: { type: String, required: true, index: true },
  aggregateRevision: { type: Number, required: true },
  type: { type: String, required: true },
  payload: { type: Schema.Types.Mixed, required: true },
  status: { type: String, required: true, enum: ['pending', 'leased', 'delivered', 'dead_letter'] },
  attempts: { type: Number, required: true, default: 0 },
  availableAt: { type: Date, required: true, default: Date.now },
  leaseUntil: { type: Date },
  lastError: { type: String },
}, { timestamps: true });
outboxSchema.index({ status: 1, availableAt: 1, leaseUntil: 1 });

const receiptSchema = new Schema({
  operationId: { type: String, required: true },
  ...scope,
  fingerprint: { type: String, required: true },
  outcome: { type: String, required: true },
  result: { type: Schema.Types.Mixed, required: true },
}, { timestamps: true });
receiptSchema.index({ tenantId: 1, ownerId: 1, operationId: 1 }, { unique: true });

const auditSchema = new Schema({
  eventId: { type: String, required: true, unique: true },
  ...scope,
  actorId: { type: String, required: true },
  action: { type: String, required: true },
  outcome: { type: String, required: true },
  resourceId: { type: String },
  beforeRevision: { type: Number },
  afterRevision: { type: Number },
  reason: { type: String },
}, { timestamps: true });

export const CalendarConnectionModel = models.CalendarConnection ?? model('CalendarConnection', connectionSchema);
export const CalendarBindingModel = models.CalendarBinding ?? model('CalendarBinding', bindingSchema);
export const CalendarConflictModel = models.CalendarConflict ?? model('CalendarConflict', conflictSchema);
export const CalendarSyncStateModel = models.CalendarSyncState ?? model('CalendarSyncState', syncStateSchema);
export const CalendarOutboxModel = models.CalendarOutbox ?? model('CalendarOutbox', outboxSchema);
export const CalendarMutationReceiptModel = models.CalendarMutationReceipt ?? model('CalendarMutationReceipt', receiptSchema);
export const CalendarDomainAuditModel = models.CalendarDomainAudit ?? model('CalendarDomainAudit', auditSchema);
