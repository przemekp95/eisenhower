import { useState } from 'react';
import AdvancedAIAnalysis from './ai/AdvancedAIAnalysis';
import BatchAnalysis from './ai/BatchAnalysis';
import AIManagement from './ai/AIManagement';
import ImageUpload from './ai/ImageUpload';
import { BatchAnalysisResult, LangChainAnalysis, OCRResult } from '../services/api';
import { useLanguage } from '../i18n/LanguageContext';

interface Props {
  taskTitle: string;
  onClose: () => void;
  onAnalysisComplete: (analysis: LangChainAnalysis) => void;
  onAnalysisTaskAdd?: (analysis: LangChainAnalysis) => Promise<void> | void;
  onOCRTasksExtracted?: (result: OCRResult) => Promise<number> | number;
}

type Tab = 'analysis' | 'ocr' | 'batch' | 'manage';

export default function AITools({
  taskTitle,
  onClose,
  onAnalysisComplete,
  onAnalysisTaskAdd,
  onOCRTasksExtracted,
}: Props) {
  const [activeTab, setActiveTab] = useState<Tab>('analysis');
  const [lastSummary, setLastSummary] = useState('');
  const { language, t } = useLanguage();

  const format = (template: string, values: Record<string, string | number>) =>
    Object.entries(values).reduce(
      (result, [key, value]) => result.replace(`{${key}}`, String(value)),
      template
    );

  const tabs: Array<{ id: Tab; label: string }> = [
    { id: 'analysis', label: t('ai.tabs.analysis') },
    { id: 'ocr', label: t('ai.tabs.ocr') },
    { id: 'batch', label: t('ai.tabs.batch') },
    { id: 'manage', label: t('ai.tabs.manage') },
  ];

  const formatOcrImportedSummary = (count: number) => {
    if (language === 'pl') {
      const remainder10 = count % 10;
      const remainder100 = count % 100;

      if (count === 1) {
        return t('ai.summary.ocrImported.one');
      }

      if (remainder10 >= 2 && remainder10 <= 4 && !(remainder100 >= 12 && remainder100 <= 14)) {
        return format(t('ai.summary.ocrImported.few'), { count });
      }

      return format(t('ai.summary.ocrImported.other'), { count });
    }

    return count === 1
      ? t('ai.summary.ocrImported.one')
      : format(t('ai.summary.ocrImported.other'), { count });
  };

  const handleOCR = async (result: OCRResult) => {
    const importedCount = await onOCRTasksExtracted?.(result);
    setLastSummary(formatOcrImportedSummary(importedCount ?? result.summary.total_tasks));
  };

  const handleBatch = (result: BatchAnalysisResult) => {
    setLastSummary(format(t('ai.summary.batch'), { count: result.summary.total_tasks }));
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/70 p-4">
      <div className="w-full max-w-4xl rounded-4xl border border-white/10 bg-slate-900 p-6 text-white shadow-2xl">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-xl font-semibold">{t('ai.modal.title')}</h2>
            <p className="text-sm text-white/60">{t('ai.modal.subtitle')}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-full bg-white/10 px-4 py-2 text-sm transition-all hover:bg-white/15 hover:text-white"
          >
            {t('ai.modal.close')}
          </button>
        </div>
        <div className="mt-4 flex flex-wrap gap-2">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => setActiveTab(tab.id)}
              className={`rounded-full px-4 py-2 text-sm transition-all ${
                activeTab === tab.id
                  ? 'bg-white text-slate-950 hover:bg-white/90'
                  : 'bg-white/10 text-white hover:bg-white/15 hover:text-white'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>
        <div className="mt-6">
          {activeTab === 'analysis' ? (
            <AdvancedAIAnalysis
              taskTitle={taskTitle}
              onAnalysisComplete={onAnalysisComplete}
              onAddToMatrix={onAnalysisTaskAdd}
            />
          ) : null}
          {activeTab === 'ocr' ? <ImageUpload onTasksExtracted={handleOCR} /> : null}
          {activeTab === 'batch' ? <BatchAnalysis onBatchComplete={handleBatch} /> : null}
          {activeTab === 'manage' ? <AIManagement onModelUpdated={() => setLastSummary(t('ai.summary.updated'))} /> : null}
        </div>
        {lastSummary ? <p className="mt-4 text-sm text-emerald-200">{lastSummary}</p> : null}
      </div>
    </div>
  );
}
