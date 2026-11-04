import '@testing-library/jest-dom/vitest';
import { cleanup, configure } from '@testing-library/react';
import { afterEach } from 'vitest';

// The suite runs with many files at once: a screen that is found in a few hundred milliseconds alone may take more than the default second when the machine is busy.
configure({ asyncUtilTimeout: 3000 });

afterEach(() => {
  cleanup();
});
