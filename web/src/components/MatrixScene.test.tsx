import { render } from '@testing-library/react';
import MatrixScene from './MatrixScene';

jest.mock('pixi.js', () => ({
  WebGLRenderer: class {
    constructor() {
      throw new Error('unsafe-eval is unavailable');
    }
  },
  Container: class {},
  Graphics: class {},
  Ticker: class {},
}));

describe('MatrixScene', () => {
  it('keeps the application mounted when the decorative renderer is blocked', () => {
    expect(() => render(<MatrixScene />)).not.toThrow();
  });
});
