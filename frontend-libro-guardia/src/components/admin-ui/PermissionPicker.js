import React, { useState, useMemo, useCallback } from 'react';
import './PermissionPicker.css';

// Función auxiliar para normalizar texto (sacar acentos y pasar a minúsculas)
const normalizeText = (text) =>
  text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();

const PermissionPicker = ({
  categories = [],
  labels = {},
  rolePermissions = [],
  roleLabel = 'su puesto',
  selected = [],
  onToggle = () => {},
}) => {
  const [searchTerm, setSearchTerm] = useState('');
  const [showOnlyAddable, setShowOnlyAddable] = useState(false);

  const normalizedSearchTerm = useMemo(() => normalizeText(searchTerm), [searchTerm]);

  const filteredCategories = useMemo(() => {
    return categories
      .map((category) => {
        const filteredPermissions = category.permissions.filter((permissionId) => {
          const permissionLabel = labels[permissionId] || permissionId;
          const normalizedPermissionLabel = normalizeText(permissionLabel);

          const matchesSearch = normalizedPermissionLabel.includes(normalizedSearchTerm);
          const isRolePermission = rolePermissions.includes(permissionId);

          if (showOnlyAddable && isRolePermission) {
            return false;
          }

          return matchesSearch;
        });

        // Contar los permisos extra seleccionados que no son del rol
        const extraSelectedCount = filteredPermissions.filter(
          (permissionId) =>
            selected.includes(permissionId) && !rolePermissions.includes(permissionId)
        ).length;

        return {
          ...category,
          permissions: filteredPermissions,
          extraSelectedCount,
        };
      })
      .filter((category) => category.permissions.length > 0); // Ocultar categorías sin resultados
  }, [categories, labels, rolePermissions, selected, searchTerm, showOnlyAddable, normalizedSearchTerm]);

  const handleToggle = useCallback(
    (permissionId) => {
      // Solo llama a onToggle si el permiso no es parte del rol
      if (!rolePermissions.includes(permissionId)) {
        onToggle(permissionId);
      }
    },
    [onToggle, rolePermissions]
  );

  return (
    <div className="perm-picker-container">
      <div className="perm-picker-header">
        <input
          type="search"
          aria-label="Buscar permiso"
          placeholder="Buscar permiso…"
          className="perm-picker-search-input"
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
        />
        <label className="perm-picker-toggle-label">
          <input
            type="checkbox"
            className="perm-picker-toggle-checkbox"
            checked={showOnlyAddable}
            onChange={(e) => setShowOnlyAddable(e.target.checked)}
          />
          Mostrar solo lo que puede sumar
        </label>
      </div>

      {filteredCategories.length === 0 && (
        <p className="perm-picker-no-results">No hay permisos con ese nombre.</p>
      )}

      {filteredCategories.map((category) => (
        <fieldset key={category.id} className="perm-picker-category-fieldset">
          <legend className="perm-picker-category-legend">
            {category.label}
            {category.extraSelectedCount > 0 && (
              <span className="perm-picker-category-counter">
                {category.extraSelectedCount} extra
              </span>
            )}
          </legend>
          <div className="perm-picker-grid">
            {category.permissions.map((permissionId) => {
              const isRolePermission = rolePermissions.includes(permissionId);
              const isSelected = selected.includes(permissionId);
              const isDisabled = isRolePermission;
              const id = `perm-picker-${permissionId.replace(/\./g, '-')}`;

              return (
                <div
                  key={permissionId}
                  className={`perm-picker-item ${isDisabled ? 'perm-picker-item--disabled' : ''}`}
                >
                  <input
                    type="checkbox"
                    id={id}
                    checked={isSelected || isDisabled} // Si es del rol, se muestra marcado
                    disabled={isDisabled}
                    aria-describedby={isDisabled ? `${id}-rol` : undefined}
                    onChange={() => handleToggle(permissionId)}
                  />
                  <label htmlFor={id} className="perm-picker-item-label">
                    {labels[permissionId] || permissionId}
                  </label>
                  {isDisabled && (
                    <span id={`${id}-rol`} className="perm-picker-role-info">
                      Ya lo tiene por ser {roleLabel}
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        </fieldset>
      ))}
    </div>
  );
};

export default PermissionPicker;
