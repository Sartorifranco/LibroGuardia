import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Loader2, Palette, RotateCcw, Sparkles } from 'lucide-react';
import { AdminBlock } from '../../../components/admin/AdminUi';
import { hasPermission } from '../../../utils/permissions';
import { useAuth } from '../../../context/AuthContext';
import { useToast } from '../../../context/ToastContext';
import { apiFetch } from '../../../services/api';
import brand from '../../../config/brand';
import { applyAppearanceTheme } from '../../../config/applyBrandTheme';
import { clearAppearanceCache, mergeAppearance, saveAppearanceCache } from '../../../utils/appearance';

/** Presets estilo personalizador (Slack/Discord/Notion). */
export const THEME_PRESETS = [
  {
    id: 'mss-default',
    label: 'MSS (default)',
    primaryColor: brand.primaryColor,
    primaryColorHover: brand.primaryColorHover,
    darkBg: brand.backgroundColor,
    darkSurface: '#141414',
    darkCard: '#1a1a1a',
    darkText: '#fafafa',
    darkMuted: '#a3a3a3',
    darkBorder: '#2a2a2a',
    darkSidebar: '#1a1010',
    lightBg: '#f3f4f6',
    lightSurface: '#ffffff',
    lightCard: '#ffffff',
    lightText: '#111827',
    lightMuted: '#6b7280',
    lightBorder: '#e5e7eb',
    lightSidebar: '#ffffff'
  },
  {
    id: 'ocean',
    label: 'Océano',
    primaryColor: '#0284c7',
    primaryColorHover: '#0369a1',
    darkBg: '#0b1220',
    darkSurface: '#111827',
    darkCard: '#1e293b',
    darkText: '#f8fafc',
    darkMuted: '#94a3b8',
    darkBorder: '#334155',
    darkSidebar: '#0f172a',
    lightBg: '#f0f9ff',
    lightSurface: '#ffffff',
    lightCard: '#ffffff',
    lightText: '#0f172a',
    lightMuted: '#64748b',
    lightBorder: '#bae6fd',
    lightSidebar: '#e0f2fe'
  },
  {
    id: 'forest',
    label: 'Bosque',
    primaryColor: '#16a34a',
    primaryColorHover: '#15803d',
    darkBg: '#0c1410',
    darkSurface: '#122018',
    darkCard: '#1a2e22',
    darkText: '#f0fdf4',
    darkMuted: '#86efac',
    darkBorder: '#365c45',
    darkSidebar: '#102018',
    lightBg: '#f0fdf4',
    lightSurface: '#ffffff',
    lightCard: '#ffffff',
    lightText: '#14532d',
    lightMuted: '#4d7c5a',
    lightBorder: '#bbf7d0',
    lightSidebar: '#dcfce7'
  },
  {
    id: 'midnight',
    label: 'Medianoche',
    primaryColor: '#8b5cf6',
    primaryColorHover: '#7c3aed',
    darkBg: '#09090b',
    darkSurface: '#18181b',
    darkCard: '#27272a',
    darkText: '#fafafa',
    darkMuted: '#a1a1aa',
    darkBorder: '#3f3f46',
    darkSidebar: '#121216',
    lightBg: '#faf5ff',
    lightSurface: '#ffffff',
    lightCard: '#ffffff',
    lightText: '#1e1b4b',
    lightMuted: '#6b7280',
    lightBorder: '#e9d5ff',
    lightSidebar: '#f3e8ff'
  },
  {
    id: 'sand',
    label: 'Arena',
    primaryColor: '#d97706',
    primaryColorHover: '#b45309',
    darkBg: '#1c1917',
    darkSurface: '#292524',
    darkCard: '#44403c',
    darkText: '#fafaf9',
    darkMuted: '#a8a29e',
    darkBorder: '#57534e',
    darkSidebar: '#221f1c',
    lightBg: '#faf7f2',
    lightSurface: '#ffffff',
    lightCard: '#ffffff',
    lightText: '#1c1917',
    lightMuted: '#78716c',
    lightBorder: '#e7e5e4',
    lightSidebar: '#f5f5f4'
  }
];

const DEFAULTS = {
  ...THEME_PRESETS[0],
  backgroundColor: brand.backgroundColor,
  appTitle: brand.appTitle,
  companyName: brand.companyName,
  presetId: 'mss-default'
};

function ColorField({ label, value, onChange }) {
  return (
    <label className="field-label">
      {label}
      <div className="appearance-admin__color-row">
        <input
          type="color"
          value={value || '#000000'}
          onChange={(e) => onChange(e.target.value)}
          aria-label={label}
        />
        <input
          className="input-field"
          value={value || ''}
          onChange={(e) => onChange(e.target.value)}
          pattern="^#[0-9A-Fa-f]{6}$"
          required
        />
      </div>
    </label>
  );
}

function AppearanceAdminSection() {
  const { authToken, currentUser } = useAuth();
  const { showSuccess, showError } = useToast();
  const canEdit = hasPermission(currentUser, 'settings.permissions');

  const [form, setForm] = useState({ ...DEFAULTS });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    if (!authToken || !canEdit) return;
    setLoading(true);
    try {
      const data = await apiFetch('/admin/appearance', { token: authToken, allowForbidden: true });
      setForm(mergeAppearance(DEFAULTS, data.appearance || {}));
    } catch (err) {
      showError(err.message || 'No se pudo cargar la apariencia');
    } finally {
      setLoading(false);
    }
  }, [authToken, canEdit, showError]);

  useEffect(() => {
    load();
  }, [load]);

  const applyLive = (next) => {
    applyAppearanceTheme({
      ...next,
      backgroundColor: next.darkBg || next.backgroundColor
    });
  };

  const handleChange = (key, value) => {
    setForm((prev) => {
      const next = { ...prev, [key]: value, presetId: 'custom' };
      return next;
    });
  };

  const applyPreset = (preset) => {
    const next = {
      ...form,
      ...preset,
      backgroundColor: preset.darkBg,
      presetId: preset.id,
      appTitle: form.appTitle,
      companyName: form.companyName
    };
    setForm(next);
    applyLive(next);
  };

  const preview = () => applyLive(form);

  const handleSave = async (e) => {
    e.preventDefault();
    setSaving(true);
    try {
      const body = {
        ...form,
        backgroundColor: form.darkBg || form.backgroundColor
      };
      const data = await apiFetch('/admin/appearance', {
        method: 'PUT',
        token: authToken,
        body
      });
      const a = mergeAppearance(DEFAULTS, data.appearance || body);
      saveAppearanceCache(a);
      applyLive(a);
      setForm(a);
      showSuccess('Apariencia guardada. Se aplica en toda la instalación (claro y oscuro).');
    } catch (err) {
      showError(err.message || 'No se pudo guardar');
    } finally {
      setSaving(false);
    }
  };

  const handleReset = async () => {
    setForm({ ...DEFAULTS });
    applyLive(DEFAULTS);
    setSaving(true);
    try {
      await apiFetch('/admin/appearance', {
        method: 'PUT',
        token: authToken,
        body: DEFAULTS
      });
      clearAppearanceCache();
      saveAppearanceCache(DEFAULTS);
      showSuccess('Se restauró el tema MSS por defecto.');
    } catch (err) {
      showError(err.message || 'No se pudo restaurar');
    } finally {
      setSaving(false);
    }
  };

  const activePreset = useMemo(
    () => THEME_PRESETS.find((p) => p.id === form.presetId) || null,
    [form.presetId]
  );

  if (!canEdit) {
    return <p className="theme-section-desc">Sin permiso para editar la apariencia.</p>;
  }

  if (loading) {
    return (
      <p className="theme-section-desc flex items-center gap-2">
        <Loader2 className="animate-spin" size={16} />
        Cargando…
      </p>
    );
  }

  return (
    <div className="appearance-admin">
      <aside className="destinos-admin__howto" aria-label="Ayuda">
        <h4>Personalizador de apariencia</h4>
        <p>
          Como en Slack o Discord: elegí un <strong>tema listo</strong> o ajustá a mano
          el color de marca, fondos, paneles y textos del modo claro y oscuro.
        </p>
        <p>
          “Probar en pantalla” aplica al instante; “Guardar” lo deja fijo para toda la instalación.
        </p>
      </aside>

      <AdminBlock title="Temas listos">
        <div className="appearance-admin__presets">
          {THEME_PRESETS.map((preset) => (
            <button
              key={preset.id}
              type="button"
              className={`appearance-admin__preset${activePreset?.id === preset.id ? ' is-active' : ''}`}
              onClick={() => applyPreset(preset)}
            >
              <span
                className="appearance-admin__preset-swatch"
                style={{
                  background: `linear-gradient(135deg, ${preset.darkBg} 0%, ${preset.primaryColor} 55%, ${preset.lightBg} 100%)`
                }}
              />
              <span>{preset.label}</span>
            </button>
          ))}
          {form.presetId === 'custom' && (
            <span className="appearance-admin__preset is-custom">
              <Sparkles size={14} />
              Personalizado
            </span>
          )}
        </div>
      </AdminBlock>

      <AdminBlock title="Marca y textos">
        <form onSubmit={handleSave} className="appearance-admin__form">
          <ColorField
            label="Color principal (botones / acentos)"
            value={form.primaryColor}
            onChange={(v) => handleChange('primaryColor', v)}
          />
          <ColorField
            label="Color al pasar el mouse"
            value={form.primaryColorHover}
            onChange={(v) => handleChange('primaryColorHover', v)}
          />
          <label className="field-label">
            Título de la app
            <input
              className="input-field"
              value={form.appTitle || ''}
              onChange={(e) => handleChange('appTitle', e.target.value)}
              maxLength={80}
            />
          </label>
          <label className="field-label">
            Nombre de empresa / marca
            <input
              className="input-field"
              value={form.companyName || ''}
              onChange={(e) => handleChange('companyName', e.target.value)}
              maxLength={120}
            />
          </label>
        </form>
      </AdminBlock>

      <AdminBlock title="Modo oscuro">
        <div className="appearance-admin__form">
          <ColorField label="Fondo de página" value={form.darkBg} onChange={(v) => handleChange('darkBg', v)} />
          <ColorField label="Superficie" value={form.darkSurface} onChange={(v) => handleChange('darkSurface', v)} />
          <ColorField label="Tarjetas / paneles" value={form.darkCard} onChange={(v) => handleChange('darkCard', v)} />
          <ColorField label="Barra lateral" value={form.darkSidebar} onChange={(v) => handleChange('darkSidebar', v)} />
          <ColorField label="Texto" value={form.darkText} onChange={(v) => handleChange('darkText', v)} />
          <ColorField label="Texto secundario" value={form.darkMuted} onChange={(v) => handleChange('darkMuted', v)} />
          <ColorField label="Bordes" value={form.darkBorder} onChange={(v) => handleChange('darkBorder', v)} />
        </div>
      </AdminBlock>

      <AdminBlock title="Modo claro">
        <div className="appearance-admin__form">
          <ColorField label="Fondo de página" value={form.lightBg} onChange={(v) => handleChange('lightBg', v)} />
          <ColorField label="Superficie" value={form.lightSurface} onChange={(v) => handleChange('lightSurface', v)} />
          <ColorField label="Tarjetas / paneles" value={form.lightCard} onChange={(v) => handleChange('lightCard', v)} />
          <ColorField label="Barra lateral" value={form.lightSidebar} onChange={(v) => handleChange('lightSidebar', v)} />
          <ColorField label="Texto" value={form.lightText} onChange={(v) => handleChange('lightText', v)} />
          <ColorField label="Texto secundario" value={form.lightMuted} onChange={(v) => handleChange('lightMuted', v)} />
          <ColorField label="Bordes" value={form.lightBorder} onChange={(v) => handleChange('lightBorder', v)} />
        </div>
      </AdminBlock>

      <div className="appearance-admin__actions" style={{ marginTop: '1rem' }}>
        <button type="button" className="btn btn-secondary" onClick={preview}>
          <Palette size={16} />
          Probar en pantalla
        </button>
        <button type="button" className="btn btn-secondary" onClick={handleReset} disabled={saving}>
          <RotateCcw size={16} />
          Restaurar MSS
        </button>
        <button type="button" className="btn btn-primary" onClick={handleSave} disabled={saving}>
          {saving ? 'Guardando…' : 'Guardar apariencia'}
        </button>
      </div>
    </div>
  );
}

export default AppearanceAdminSection;
