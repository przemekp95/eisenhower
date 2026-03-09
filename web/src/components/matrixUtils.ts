import { LangChainAnalysis } from '../services/api';

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
