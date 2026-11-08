import { connect } from 'node:net';

// A fixture that the connector conformance test reads as the source of a connector: it opens a connection two ways.
export const offend = (): unknown => {
  connect(1);
  return fetch('https://example.invalid/');
};
