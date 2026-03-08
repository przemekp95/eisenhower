import { useState } from 'react';
import AdvancedAIAnalysis from './ai/AdvancedAIAnalysis';
import BatchAnalysis from './ai/BatchAnalysis';
import AIManagement from './ai/AIManagement';
import ImageUpload from './ai/ImageUpload';
import { BatchAnalysisResult, LangChainAnalysis, OCRResult } from '../services/api';

interface Props {
  taskTitle: string;
  onClose: () => void;
  onAnalysisComplete: (analysis: LangChainAnalysis) => void;
}

type Tab = 'analysis' | 'ocr' | 'batch' | 'manage';

export default function AITools({ taskTitle, onClose, onAnalysisComplete }: Props) {
  const [activeTab, setActiveTab] = useState<Tab>('analysis');
  const [lastSummary, setLastSummary] = useState('');

  const tabs: Array<{ id: Tab; label: string }> = [
    { id: 'analysis', label: 'Advanced analysis' },
    { id: 'ocr', label: 'OCR' },
    { id: 'batch', label: 'Batch' },
    { id: 'manage', label: 'Manage' },
  ];

  const handleOCR = (result: OCRResult) => {
    setLastSummary(`OCR found ${result.summary.total_tasks} tasks.`);
  };

  const handleBatch = (result: BatchAnalysisResult) => {
    setLastSummary(`Batch processed ${result.summary.total_tasks} tasks.`);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/70 p-4">
      <div className="w-full max-w-4xl rounded-4xl border border-white/10 bg-slate-900 p-6 text-white shadow-2xl">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-xl font-semibold">AI tools</h2>
            <p className="text-sm text-white/60">Lazy-loaded diagnostics and helper flows.</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-full bg-white/10 px-4 py-2 text-sm transition-all hover:bg-white/15 hover:text-white"
          >
            Close
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
            <AdvancedAIAnalysis taskTitle={taskTitle} onAnalysisComplete={onAnalysisComplete} />
          ) : null}
          {activeTab === 'ocr' ? <ImageUpload onTasksExtracted={handleOCR} /> : null}
          {activeTab === 'batch' ? <BatchAnalysis onBatchComplete={handleBatch} /> : null}
          {activeTab === 'manage' ? <AIManagement onModelUpdated={() => setLastSummary('Model updated.')} /> : null}
        </div>
        {lastSummary ? <p className="mt-4 text-sm text-emerald-200">{lastSummary}</p> : null}
      </div>
    </div>
  );
}
