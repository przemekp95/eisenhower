import { useEffect, useState } from 'react';
import {
  addTrainingExample,
  getExamplesByQuadrant,
  getTrainingStats,
  learnFromFeedback,
  retrainModel,
  TrainingStats,
} from '../../services/api';

interface Props {
  onModelUpdated: () => void;
}

export default function AIManagement({ onModelUpdated }: Props) {
  const [stats, setStats] = useState<TrainingStats | null>(null);
  const [message, setMessage] = useState('');
  const [examples, setExamples] = useState<Array<{ text: string; quadrant: number }>>([]);

  useEffect(() => {
    void getTrainingStats().then(setStats).catch(() => setMessage('Failed to load stats'));
  }, []);

  const refreshExamples = async () => {
    const response = await getExamplesByQuadrant(0, 5);
    setExamples(response.examples);
  };

  return (
    <section className="space-y-3 text-sm text-white">
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className="rounded-full bg-emerald-500 px-4 py-2 font-semibold text-slate-950 transition-all hover:-translate-y-0.5 hover:bg-emerald-400 hover:shadow-lg hover:shadow-emerald-500/20"
          onClick={async () => {
            await addTrainingExample('review roadmap', 2);
            setMessage('Example added');
            onModelUpdated();
          }}
        >
          Add example
        </button>
        <button
          type="button"
          className="rounded-full bg-cyan-500 px-4 py-2 font-semibold text-slate-950 transition-all hover:-translate-y-0.5 hover:bg-cyan-400 hover:shadow-lg hover:shadow-cyan-500/20"
          onClick={async () => {
            await learnFromFeedback('urgent task', 1, 0);
            setMessage('Feedback learned');
            onModelUpdated();
          }}
        >
          Learn feedback
        </button>
        <button
          type="button"
          className="rounded-full bg-violet-500 px-4 py-2 font-semibold text-white transition-all hover:-translate-y-0.5 hover:bg-violet-400 hover:shadow-lg hover:shadow-violet-500/20"
          onClick={async () => {
            await retrainModel(false);
            setMessage('Retraining completed');
            onModelUpdated();
          }}
        >
          Retrain
        </button>
        <button
          type="button"
          className="rounded-full bg-white/10 px-4 py-2 font-semibold text-white transition-all hover:bg-white/15 hover:text-white"
          onClick={() => {
            void refreshExamples();
          }}
        >
          Load examples
        </button>
      </div>
      {stats ? <p>Total examples: {stats.total_examples}</p> : null}
      {message ? <p>{message}</p> : null}
      {examples.length > 0 ? (
        <ul className="space-y-2">
          {examples.map((example) => (
            <li key={`${example.quadrant}-${example.text}`} className="rounded-xl bg-black/20 p-3">
              {example.text}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
