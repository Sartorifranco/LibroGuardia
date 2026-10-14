import React from 'react';
import { render, screen, fireEvent, within } from '@testing-library/react';
import '@testing-library/jest-dom';
import PermissionPicker from './PermissionPicker';

describe('PermissionPicker', () => {
  const mockCategories = [
    {
      id: 'visitas',
      label: 'Gestión de Visitas',
      permissions: ['visitas.create', 'visitas.view', 'visitas.edit', 'visitas.approve'],
    },
    {
      id: 'usuarios',
      label: 'Gestión de Usuarios',
      permissions: ['usuarios.create', 'usuarios.view', 'usuarios.delete'],
    },
  ];

  const mockLabels = {
    'visitas.create': 'Cargar visitas autorizadas (sin aprobación)',
    'visitas.view': 'Ver todas las visitas',
    'visitas.edit': 'Editar visitas propias',
    'visitas.approve': 'Aprobar visitas de otros',
    'usuarios.create': 'Crear usuarios nuevos',
    'usuarios.view': 'Ver listado de usuarios',
    'usuarios.delete': 'Eliminar usuarios',
  };

  const mockRolePermissions = ['visitas.view', 'usuarios.view'];
  const mockSelectedPermissions = ['visitas.approve'];
  const mockRoleLabel = 'Supervisor';
  const mockOnToggle = jest.fn();

  beforeEach(() => {
    mockOnToggle.mockClear();
  });

  test('renderiza con 2 categorías y permisos correctos', () => {
    render(
      <PermissionPicker
        categories={mockCategories}
        labels={mockLabels}
        rolePermissions={mockRolePermissions}
        roleLabel={mockRoleLabel}
        selected={mockSelectedPermissions}
        onToggle={mockOnToggle}
      />
    );

    expect(screen.getByText('Gestión de Visitas')).toBeInTheDocument();
    expect(screen.getByText('Gestión de Usuarios')).toBeInTheDocument();

    expect(screen.getByLabelText('Cargar visitas autorizadas (sin aprobación)')).toBeInTheDocument();
    expect(screen.getByLabelText('Ver todas las visitas')).toBeInTheDocument();
    expect(screen.getByLabelText('Aprobar visitas de otros')).toBeInTheDocument();
  });

  test('un permiso del rol está deshabilitado y muestra "Ya lo tiene por ser Supervisor"', () => {
    render(
      <PermissionPicker
        categories={mockCategories}
        labels={mockLabels}
        rolePermissions={mockRolePermissions}
        roleLabel={mockRoleLabel}
        selected={mockSelectedPermissions}
        onToggle={mockOnToggle}
      />
    );

    const viewVisitsCheckbox = screen.getByLabelText('Ver todas las visitas');
    expect(viewVisitsCheckbox).toBeChecked();
    expect(viewVisitsCheckbox).toBeDisabled();
    expect(viewVisitsCheckbox).toHaveAccessibleDescription(`Ya lo tiene por ser ${mockRoleLabel}`);

    fireEvent.click(viewVisitsCheckbox);
    expect(mockOnToggle).not.toHaveBeenCalled(); // No debe llamar a onToggle si está deshabilitado
  });

  test('un permiso libre llama a onToggle al clickear', () => {
    render(
      <PermissionPicker
        categories={mockCategories}
        labels={mockLabels}
        rolePermissions={mockRolePermissions}
        roleLabel={mockRoleLabel}
        selected={mockSelectedPermissions}
        onToggle={mockOnToggle}
      />
    );

    const createVisitsCheckbox = screen.getByLabelText('Cargar visitas autorizadas (sin aprobación)');
    expect(createVisitsCheckbox).not.toBeChecked();
    expect(createVisitsCheckbox).not.toBeDisabled();

    fireEvent.click(createVisitsCheckbox);
    expect(mockOnToggle).toHaveBeenCalledTimes(1);
    expect(mockOnToggle).toHaveBeenCalledWith('visitas.create');
  });

  test('el buscador filtra los permisos por texto del label', () => {
    render(
      <PermissionPicker
        categories={mockCategories}
        labels={mockLabels}
        rolePermissions={mockRolePermissions}
        roleLabel={mockRoleLabel}
        selected={mockSelectedPermissions}
        onToggle={mockOnToggle}
      />
    );

    const searchInput = screen.getByPlaceholderText('Buscar permiso…');
    fireEvent.change(searchInput, { target: { value: 'aprobar' } });

    expect(screen.getByLabelText('Aprobar visitas de otros')).toBeInTheDocument();
    expect(screen.queryByLabelText('Ver todas las visitas')).not.toBeInTheDocument();
    expect(screen.queryByText('Gestión de Usuarios')).not.toBeInTheDocument(); // Categoría completa debería ocultarse si no hay permisos
  });

  test('"Mostrar solo lo que puede sumar" oculta los permisos del rol', () => {
    render(
      <PermissionPicker
        categories={mockCategories}
        labels={mockLabels}
        rolePermissions={mockRolePermissions}
        roleLabel={mockRoleLabel}
        selected={mockSelectedPermissions}
        onToggle={mockOnToggle}
      />
    );

    // Por defecto, se ven todos los permisos
    expect(screen.getByLabelText('Ver todas las visitas')).toBeInTheDocument();
    expect(screen.getByLabelText('Ver listado de usuarios')).toBeInTheDocument();

    const toggleSwitch = screen.getByLabelText('Mostrar solo lo que puede sumar');
    fireEvent.click(toggleSwitch); // Activa el filtro

    // Los permisos del rol NO deben estar visibles
    expect(screen.queryByLabelText('Ver todas las visitas')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Ver listado de usuarios')).not.toBeInTheDocument();

    // Los permisos que no son del rol SÍ deben estar visibles
    expect(screen.getByLabelText('Cargar visitas autorizadas (sin aprobación)')).toBeInTheDocument();
    expect(screen.getByLabelText('Aprobar visitas de otros')).toBeInTheDocument();
  });

  test('muestra "No hay permisos con ese nombre" si la búsqueda no tiene resultados', () => {
    render(
      <PermissionPicker
        categories={mockCategories}
        labels={mockLabels}
        rolePermissions={mockRolePermissions}
        roleLabel={mockRoleLabel}
        selected={mockSelectedPermissions}
        onToggle={mockOnToggle}
      />
    );

    const searchInput = screen.getByPlaceholderText('Buscar permiso…');
    fireEvent.change(searchInput, { target: { value: 'permisoinexistente' } });

    expect(screen.getByText('No hay permisos con ese nombre.')).toBeInTheDocument();
    expect(screen.queryByText('Gestión de Visitas')).not.toBeInTheDocument();
  });

  test('contador "N extra" se muestra correctamente', () => {
    render(
      <PermissionPicker
        categories={mockCategories}
        labels={mockLabels}
        rolePermissions={mockRolePermissions}
        roleLabel={mockRoleLabel}
        selected={mockSelectedPermissions}
        onToggle={mockOnToggle}
      />
    );

    const visitasLegend = screen.getByText('Gestión de Visitas');
    const extraCounter = within(visitasLegend.closest('legend')).getByText('1 extra');
    expect(extraCounter).toBeInTheDocument();

    const usuariosLegend = screen.getByText('Gestión de Usuarios');
    expect(within(usuariosLegend.closest('legend')).queryByText('extra')).not.toBeInTheDocument();
  });

  test('contador "N extra" se actualiza con la búsqueda', () => {
    render(
      <PermissionPicker
        categories={mockCategories}
        labels={mockLabels}
        rolePermissions={mockRolePermissions}
        roleLabel={mockRoleLabel}
        selected={mockSelectedPermissions}
        onToggle={mockOnToggle}
      />
    );

    // Inicialmente, "Gestión de Visitas" tiene "1 extra" (aprobar visitas)
    expect(within(screen.getByText('Gestión de Visitas').closest('legend')).getByText('1 extra')).toBeInTheDocument();

    const searchInput = screen.getByPlaceholderText('Buscar permiso…');
    fireEvent.change(searchInput, { target: { value: 'Cargar visitas' } }); // Buscamos "visitas.create"

    // Ahora, la categoría "Gestión de Visitas" solo tiene "Cargar visitas..."
    // Y como "visitas.create" NO está en `selected` y no es del `rolePermissions`, el contador debería ser 0.
    const visitasLegend = screen.getByText('Gestión de Visitas');
    expect(within(visitasLegend.closest('legend')).queryByText('extra')).not.toBeInTheDocument();

    fireEvent.change(searchInput, { target: { value: 'Aprobar' } }); // Buscamos "visitas.approve"
    expect(within(screen.getByText('Gestión de Visitas').closest('legend')).getByText('1 extra')).toBeInTheDocument();
  });
});
