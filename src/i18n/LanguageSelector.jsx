import React from 'react';
import { languages, translate } from './index.js';

export default function LanguageSelector({ language, onChange }) {
  return <div className="action-row" role="group" aria-label={translate('언어 선택', language)} data-language-selector>
    {languages.map((entry) => <button key={entry.code} type="button" lang={entry.code}
      aria-pressed={language === entry.code} className={language === entry.code ? 'active' : ''}
      onClick={() => onChange(entry.code)}>{entry.label}</button>)}
  </div>;
}
