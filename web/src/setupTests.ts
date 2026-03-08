import '@testing-library/jest-dom';
import React from 'react';

global.ResizeObserver = jest.fn().mockImplementation(() => ({
  observe: jest.fn(),
  unobserve: jest.fn(),
  disconnect: jest.fn(),
}));

jest.mock('@hello-pangea/dnd', () => ({
  DragDropContext: ({ children }: { children: React.ReactNode }) => children,
  Droppable: ({ children, droppableId }: { children: Function; droppableId: string }) =>
    children(
      {
        innerRef: jest.fn(),
        droppableProps: { 'data-droppable-id': droppableId },
        placeholder: null,
      },
      {}
    ),
  Draggable: ({ children, draggableId }: { children: Function; draggableId: string }) =>
    children(
      {
        innerRef: jest.fn(),
        draggableProps: { 'data-draggable-id': draggableId },
        dragHandleProps: {},
      },
      {}
    ),
}));

jest.mock('@react-three/fiber', () => ({
  Canvas: ({ children }: { children: React.ReactNode }) =>
    React.createElement('div', { 'data-testid': 'canvas' }, children),
}));

jest.mock('@react-three/drei', () => ({
  OrbitControls: () => null,
  Sphere: ({ children }: { children: React.ReactNode }) =>
    React.createElement('div', { 'data-testid': 'sphere' }, children),
}));

jest.mock('./components/MatrixScene', () => ({
  __esModule: true,
  default: () => React.createElement('div', { 'data-testid': 'matrix-scene' }),
}));
