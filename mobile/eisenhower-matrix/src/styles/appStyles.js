import { StyleSheet } from 'react-native';

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: '#020617',
  },
  content: {
    padding: 16,
    paddingBottom: 32,
  },
  loading: {
    marginTop: 40,
    color: '#e2e8f0',
    textAlign: 'center',
  },
  header: {
    marginBottom: 20,
    gap: 12,
  },
  title: {
    color: '#f8fafc',
    fontSize: 28,
    fontWeight: '700',
  },
  subtitle: {
    color: '#94a3b8',
    marginTop: 6,
  },
  notice: {
    borderRadius: 16,
    paddingHorizontal: 14,
    paddingVertical: 10,
    marginBottom: 16,
    backgroundColor: '#10243f',
  },
  noticeText: {
    color: '#bfdbfe',
    fontWeight: '600',
  },
  form: {
    gap: 12,
    borderRadius: 24,
    padding: 16,
    marginBottom: 20,
    backgroundColor: '#0f172a',
    borderWidth: 1,
    borderColor: 'rgba(56, 189, 248, 0.12)',
  },
  input: {
    borderRadius: 16,
    paddingHorizontal: 16,
    paddingVertical: 12,
    backgroundColor: '#111827',
    color: '#f8fafc',
  },
  batchInput: {
    minHeight: 120,
  },
  switchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  switchLabel: {
    color: '#e2e8f0',
    flex: 1,
    paddingRight: 12,
  },
  actions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
  },
  primaryButton: {
    borderRadius: 999,
    paddingHorizontal: 16,
    paddingVertical: 10,
    backgroundColor: '#14b8a6',
  },
  primaryButtonText: {
    color: '#042f2e',
    fontWeight: '700',
  },
  secondaryButton: {
    borderRadius: 999,
    paddingHorizontal: 16,
    paddingVertical: 10,
    backgroundColor: '#1e293b',
  },
  secondaryButtonText: {
    color: '#e2e8f0',
    fontWeight: '600',
  },
  toolsButton: {
    borderRadius: 999,
    paddingHorizontal: 16,
    paddingVertical: 10,
    backgroundColor: '#0f766e',
  },
  toolsButtonText: {
    color: '#ccfbf1',
    fontWeight: '700',
  },
  disabledButton: {
    opacity: 0.45,
  },
  aiSummary: {
    borderRadius: 24,
    padding: 16,
    marginBottom: 20,
    backgroundColor: '#0f172a',
    borderWidth: 1,
    borderColor: 'rgba(20, 184, 166, 0.18)',
    gap: 12,
  },
  sectionEyebrow: {
    color: '#67e8f9',
    letterSpacing: 2,
    textTransform: 'uppercase',
    fontSize: 12,
    fontWeight: '700',
  },
  aiSubtitle: {
    color: '#94a3b8',
    lineHeight: 20,
  },
  aiStatusBadge: {
    alignSelf: 'flex-start',
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  aiStatusOnline: {
    backgroundColor: 'rgba(20, 184, 166, 0.18)',
  },
  aiStatusOffline: {
    backgroundColor: 'rgba(71, 85, 105, 0.35)',
  },
  aiStatusText: {
    color: '#e2e8f0',
    fontWeight: '600',
  },
  providerPills: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
  },
  providerPill: {
    borderRadius: 999,
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 10,
    backgroundColor: '#111827',
  },
  providerPillLabel: {
    color: '#f8fafc',
    fontWeight: '700',
  },
  providerPillStatus: {
    marginTop: 4,
    fontWeight: '600',
  },
  matrixHeader: {
    marginBottom: 12,
    gap: 6,
  },
  matrixSubtitle: {
    color: '#94a3b8',
  },
  matrixGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
    gap: 12,
  },
  quadrantCard: {
    width: '48%',
    minHeight: 220,
    borderRadius: 24,
    padding: 14,
    backgroundColor: '#0b1220',
    borderWidth: 1,
    gap: 12,
  },
  quadrantHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  quadrantMarker: {
    width: 12,
    height: 12,
    borderRadius: 999,
  },
  quadrantCopy: {
    flex: 1,
  },
  quadrantTitle: {
    color: '#f8fafc',
    fontSize: 16,
    fontWeight: '700',
  },
  quadrantHint: {
    color: '#94a3b8',
    marginTop: 2,
    fontSize: 12,
  },
  quadrantCount: {
    color: '#cbd5e1',
    fontWeight: '700',
  },
  emptyQuadrant: {
    flex: 1,
    minHeight: 110,
    borderRadius: 18,
    borderWidth: 1,
    borderStyle: 'dashed',
    borderColor: 'rgba(148, 163, 184, 0.28)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 12,
  },
  emptyQuadrantText: {
    color: '#64748b',
    textAlign: 'center',
  },
  card: {
    gap: 12,
    borderRadius: 18,
    padding: 12,
    backgroundColor: '#111827',
  },
  cardHeader: {
    flexDirection: 'row',
    gap: 12,
  },
  cardTitle: {
    color: '#f8fafc',
    fontWeight: '700',
  },
  cardDescription: {
    marginTop: 4,
    color: '#94a3b8',
  },
  pendingSyncBadge: {
    alignSelf: 'flex-start',
    marginTop: 8,
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 4,
    backgroundColor: 'rgba(245, 158, 11, 0.18)',
    color: '#fcd34d',
    fontSize: 12,
    fontWeight: '700',
  },
  deleteButton: {
    alignSelf: 'flex-start',
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 8,
    backgroundColor: '#7f1d1d',
  },
  deleteButtonText: {
    color: '#fee2e2',
    fontWeight: '700',
  },
  badges: {
    flexDirection: 'row',
    gap: 8,
    flexWrap: 'wrap',
  },
  badge: {
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 8,
    backgroundColor: '#1e293b',
  },
  badgeText: {
    color: '#cbd5e1',
  },
  modalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(2, 6, 23, 0.82)',
    justifyContent: 'flex-end',
  },
  modalSheet: {
    maxHeight: '90%',
    backgroundColor: '#0f172a',
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)',
    padding: 16,
  },
  modalHeader: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: 12,
  },
  modalHeaderCopy: {
    flex: 1,
    minWidth: 0,
  },
  modalTitle: {
    color: '#f8fafc',
    fontSize: 22,
    fontWeight: '700',
  },
  modalSubtitle: {
    color: '#94a3b8',
    marginTop: 4,
  },
  modalCloseButton: {
    borderRadius: 999,
    paddingHorizontal: 14,
    paddingVertical: 10,
    backgroundColor: '#1e293b',
  },
  modalCloseText: {
    color: '#e2e8f0',
    fontWeight: '600',
  },
  modalFooter: {
    borderTopWidth: 1,
    borderTopColor: 'rgba(148, 163, 184, 0.16)',
    marginTop: 12,
    paddingTop: 12,
  },
  modalFooterCloseButton: {
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 18,
    paddingHorizontal: 16,
    paddingVertical: 14,
    backgroundColor: '#1e293b',
  },
  modalFooterCloseText: {
    color: '#f8fafc',
    fontWeight: '700',
  },
  tabRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
    marginTop: 16,
  },
  tabButton: {
    borderRadius: 999,
    paddingHorizontal: 14,
    paddingVertical: 10,
    backgroundColor: '#1e293b',
  },
  activeTabButton: {
    backgroundColor: '#f8fafc',
  },
  tabButtonText: {
    color: '#e2e8f0',
    fontWeight: '600',
  },
  activeTabButtonText: {
    color: '#020617',
  },
  modalContent: {
    paddingTop: 16,
    paddingBottom: 24,
    gap: 14,
  },
  toolCard: {
    borderRadius: 24,
    padding: 16,
    backgroundColor: '#111827',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)',
    gap: 12,
  },
  toolTitle: {
    color: '#f8fafc',
    fontSize: 16,
    fontWeight: '700',
  },
  analysisResult: {
    borderRadius: 20,
    padding: 14,
    backgroundColor: '#020617',
    gap: 10,
  },
  analysisText: {
    color: '#e2e8f0',
    lineHeight: 20,
  },
  analysisMeta: {
    color: '#93c5fd',
  },
  batchResults: {
    gap: 10,
  },
  batchResultItem: {
    borderRadius: 18,
    padding: 12,
    backgroundColor: '#020617',
    gap: 6,
  },
  batchTask: {
    color: '#f8fafc',
    fontWeight: '700',
  },
  batchQuadrant: {
    color: '#cbd5e1',
  },
  manageStack: {
    gap: 14,
  },
  manageStatBlock: {
    gap: 6,
  },
  manageBigNumber: {
    color: '#f8fafc',
    fontSize: 28,
    fontWeight: '700',
  },
  manageHint: {
    color: '#cbd5e1',
  },
  manageMuted: {
    color: '#64748b',
    fontSize: 12,
  },
  providerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderRadius: 18,
    paddingHorizontal: 14,
    paddingVertical: 12,
    backgroundColor: '#0b1220',
  },
  providerCopy: {
    flex: 1,
    paddingRight: 12,
  },
  providerTitle: {
    color: '#f8fafc',
    fontWeight: '700',
  },
  providerStatus: {
    marginTop: 4,
    fontWeight: '600',
  },
  chipRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  chip: {
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 8,
    backgroundColor: '#1e293b',
  },
  chipActive: {
    backgroundColor: '#f8fafc',
  },
  chipText: {
    color: '#cbd5e1',
    fontWeight: '600',
  },
  chipTextActive: {
    color: '#020617',
  },
  examplesList: {
    gap: 8,
  },
  exampleItem: {
    borderRadius: 16,
    padding: 12,
    backgroundColor: '#020617',
  },
  exampleItemText: {
    color: '#e2e8f0',
  },
  modalError: {
    color: '#fecaca',
  },
  modalMessage: {
    color: '#a7f3d0',
  },
});

export default styles;
