'use client';
/**
 * RuntimeConfigEditor
 *
 * Field-by-field editor for a project's runtime config (the shape rapitas
 * uses to launch/health-check a dev server for live preview and runtime
 * verification — see rapitas-backend's runtime-config.ts). Shared between
 * the theme settings form and the task-detail inline "fix it here" editor
 * so both offer the same editing experience instead of a raw JSON textarea.
 * Encapsulates parse/serialize internally — callers only ever see the same
 * JSON string the backend expects.
 */
import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Plus, X } from 'lucide-react';

export interface RuntimeConfigEditorProps {
  /** Current value as a JSON string (same shape sent to/from the backend); empty string = unset. */
  value: string;
  onChange: (json: string) => void;
}

interface Fields {
  readySelector: string;
  readinessTimeoutMs: number;
  start: string;
  url: string;
  healthPath: string;
  readyTimeoutMs: number;
  checkPaths: string[];
}

const DEFAULT_FIELDS: Fields = {
  readySelector: '',
  readinessTimeoutMs: 25000,
  start: '',
  url: '',
  healthPath: '/',
  readyTimeoutMs: 90_000,
  checkPaths: [''],
};

function parseValue(value: string): Fields {
  if (!value.trim()) return DEFAULT_FIELDS;
  try {
    const parsed: unknown = JSON.parse(value);
    const o = (parsed && typeof parsed === 'object' ? parsed : {}) as Record<string, unknown>;
    const checkPaths = Array.isArray(o.checkPaths)
      ? o.checkPaths.filter((p): p is string => typeof p === 'string')
      : [];
    return {
      readySelector: typeof o.readySelector === 'string' ? o.readySelector : '',
      readinessTimeoutMs: typeof o.readinessTimeoutMs === 'number' ? o.readinessTimeoutMs : 25000,
      start: typeof o.start === 'string' ? o.start : '',
      url: typeof o.url === 'string' ? o.url : '',
      healthPath: typeof o.healthPath === 'string' ? o.healthPath : '/',
      readyTimeoutMs: typeof o.readyTimeoutMs === 'number' ? o.readyTimeoutMs : 90_000,
      checkPaths: checkPaths.length > 0 ? checkPaths : [''],
    };
  } catch {
    return DEFAULT_FIELDS;
  }
}

function serialize(fields: Fields): string {
  const checkPaths = fields.checkPaths.map((p) => p.trim()).filter(Boolean);
  return JSON.stringify({
    ...(fields.readySelector.trim()
      ? {
          readySelector: fields.readySelector.trim(),
          readinessTimeoutMs: fields.readinessTimeoutMs,
        }
      : {}),
    start: fields.start.trim(),
    url: fields.url.trim(),
    healthPath: fields.healthPath.trim() || '/',
    readyTimeoutMs: fields.readyTimeoutMs,
    checkPaths: checkPaths.length > 0 ? checkPaths : ['/'],
  });
}

const inputClass =
  'w-full h-9 rounded-lg border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-800 px-3 text-sm focus:outline-none focus:border-indigo-400 transition-colors';

/**
 * @param value - Current runtime config as a JSON string (empty = unset). / 現在の設定(JSON文字列)
 * @param onChange - Called with the re-serialized JSON string on every field edit. / 変更時のコールバック
 */
export function RuntimeConfigEditor({ value, onChange }: RuntimeConfigEditorProps) {
  const t = useTranslations('runtimeConfig');
  // Parsed once on mount — callers force a remount (key=...) when switching
  // edit targets (e.g. a different theme) so this doesn't fight the user's
  // typing by re-parsing on every keystroke-driven `value` change.
  const [fields, setFields] = useState<Fields>(() => parseValue(value));

  const update = (patch: Partial<Fields>) => {
    const next = { ...fields, ...patch };
    setFields(next);
    onChange(serialize(next));
  };

  const updateCheckPath = (index: number, path: string) => {
    const checkPaths = fields.checkPaths.slice();
    checkPaths[index] = path;
    update({ checkPaths });
  };

  const addCheckPath = () => update({ checkPaths: [...fields.checkPaths, ''] });

  const removeCheckPath = (index: number) => {
    const checkPaths = fields.checkPaths.filter((_, i) => i !== index);
    update({ checkPaths: checkPaths.length > 0 ? checkPaths : [''] });
  };

  return (
    <div className="space-y-2">
      <div>
        <label htmlFor="rce-selector" className="block text-xs text-zinc-500 mb-1">
          {t('readySelector')}
        </label>
        <input
          id="rce-selector"
          aria-label={t('readySelector')}
          className={inputClass}
          value={fields.readySelector}
          onChange={(e) => update({ readySelector: e.target.value })}
          placeholder={'[data-app-ready="true"]'}
        />
        <p className="text-xs text-zinc-500">{t('readySelectorHelp')}</p>
      </div>
      <div>
        <label htmlFor="rce-readiness-timeout" className="block text-xs text-zinc-500 mb-1">
          {t('readinessTimeoutMs')}
        </label>
        <input
          id="rce-readiness-timeout"
          aria-label={t('readinessTimeoutMs')}
          className={inputClass}
          type="number"
          min={1}
          max={60}
          value={fields.readinessTimeoutMs / 1000}
          onChange={(e) => update({ readinessTimeoutMs: (Number(e.target.value) || 25) * 1000 })}
        />
      </div>
      <div>
        <label htmlFor="rce-start" className="block text-xs text-zinc-500 dark:text-zinc-400 mb-1">
          {t('start')}
        </label>
        <input
          id="rce-start"
          type="text"
          value={fields.start}
          onChange={(e) => update({ start: e.target.value })}
          placeholder="npm run dev -- -p {port}"
          aria-label={t('start')}
          className={`${inputClass} font-mono`}
        />
      </div>

      <div>
        <label htmlFor="rce-url" className="block text-xs text-zinc-500 dark:text-zinc-400 mb-1">
          {t('url')}
        </label>
        <input
          id="rce-url"
          type="text"
          value={fields.url}
          onChange={(e) => update({ url: e.target.value })}
          placeholder="http://localhost:{port}"
          aria-label={t('url')}
          className={`${inputClass} font-mono`}
        />
      </div>

      <div className="grid grid-cols-2 gap-2">
        <div>
          <label
            htmlFor="rce-health-path"
            className="block text-xs text-zinc-500 dark:text-zinc-400 mb-1"
          >
            {t('healthPath')}
          </label>
          <input
            id="rce-health-path"
            type="text"
            value={fields.healthPath}
            onChange={(e) => update({ healthPath: e.target.value })}
            placeholder="/"
            aria-label={t('healthPath')}
            className={`${inputClass} font-mono`}
          />
        </div>
        <div>
          <label
            htmlFor="rce-ready-timeout"
            className="block text-xs text-zinc-500 dark:text-zinc-400 mb-1"
          >
            {t('readyTimeoutMs')}
          </label>
          <input
            id="rce-ready-timeout"
            type="number"
            min={5}
            max={300}
            step={1}
            // Displayed/edited in seconds — friendlier than raw milliseconds —
            // but stored as readyTimeoutMs (ms) to match the backend's wire
            // format (parseRuntimeConfig), which clamps to [5_000, 300_000]ms.
            value={Math.round(fields.readyTimeoutMs / 1000)}
            onChange={(e) => update({ readyTimeoutMs: (Number(e.target.value) || 90) * 1_000 })}
            aria-label={t('readyTimeoutMs')}
            className={inputClass}
          />
        </div>
      </div>

      <div>
        <label className="block text-xs text-zinc-500 dark:text-zinc-400 mb-1">
          {t('checkPaths')}
        </label>
        <div className="space-y-1.5">
          {fields.checkPaths.map((path, index) => (
            <div key={index} className="flex items-center gap-1.5">
              <input
                type="text"
                value={path}
                onChange={(e) => updateCheckPath(index, e.target.value)}
                placeholder="/"
                aria-label={`${t('checkPaths')} ${index + 1}`}
                className={`${inputClass} font-mono`}
              />
              <button
                type="button"
                onClick={() => removeCheckPath(index)}
                aria-label={t('removePath')}
                className="shrink-0 p-1.5 rounded-md text-zinc-400 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          ))}
        </div>
        <button
          type="button"
          onClick={addCheckPath}
          className="mt-1.5 inline-flex items-center gap-1 text-xs text-indigo-600 dark:text-indigo-400 hover:underline"
        >
          <Plus className="w-3 h-3" />
          {t('addPath')}
        </button>
      </div>
    </div>
  );
}

export default RuntimeConfigEditor;
