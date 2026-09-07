import { describe, expect, it } from 'vitest';

import { createApp } from './app.js';

describe('health endpoint', () => {
  it('creates the API application', () => {
    expect(createApp()).toBeDefined();
  });
});