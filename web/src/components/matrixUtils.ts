import { LangChainAnalysis } from '../services/api';

export const QUADRANT_KEYS = ['do', 'delegate', 'schedule', 'delete'] as const;

export const QUADRANT_LABEL_KEYS = {
  0: 'matrix.do',
  1: 'matrix.delegate',
  2: 'matrix.schedule',
  3: 'matrix.delete',
} as const;

export function quadrantToTaskState(quadrant: number) {
  return {
    urgent: quadrant === 0 || quadrant === 1,
    important: quadrant === 0 || quadrant === 2,
  };
}

export function resolveSuggestedQuadrant(analysis: LangChainAnalysis): number {
  return analysis.langchain_analysis.quadrant ?? analysis.rag_classification.quadrant;
}

export function resolveQuadrantLabel(
  quadrant: number,
  quadrantLabels: Record<number, string>,
  unknownLabel: (quadrant: number) => string
) {
  return quadrantLabels[quadrant] ?? unknownLabel(quadrant);
}
