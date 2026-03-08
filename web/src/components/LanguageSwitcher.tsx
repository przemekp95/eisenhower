import React from 'react';
import { useLanguage } from '../i18n/LanguageContext';

const LanguageSwitcher: React.FC = () => {
  const { language, setLanguage } = useLanguage();

  return (
    <div className="relative inline-flex rounded-full bg-white/10 p-1 backdrop-blur-xs">
      <button
        onClick={() => setLanguage('en')}
        className={`px-4 py-2 rounded-full font-medium transition-all ${
          language === 'en'
            ? 'bg-white text-blue-600 shadow-lg'
            : 'text-white hover:bg-white/10'
        }`}
      >
        English
      </button>
      <button
        onClick={() => setLanguage('pl')}
        className={`px-4 py-2 rounded-full font-medium transition-all ${
          language === 'pl'
            ? 'bg-white text-blue-600 shadow-lg'
            : 'text-white hover:bg-white/10'
        }`}
        >
        Polski
      </button>
    </div>
  );
};

export default LanguageSwitcher;
